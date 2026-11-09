//! One transcript line -> at most one searchable message.
//!
//! Only the text blocks a person would call "the conversation": user prompts and the
//! assistant's replies. Thinking, tool input and tool output are not indexed (tool output is
//! the bulk of a transcript and mostly noise). Secrets are masked here, before anything is
//! stored.

use memchr::memmem;
use serde::Deserialize;

use super::mask::mask_secrets;
use crate::usage::time::parse_iso_ms;

/// Same cap as the transcript view (`usage::transcript::TEXT_CAP`).
pub const TEXT_CAP: usize = 20_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Message {
    pub uuid: Option<String>,
    pub session_id: Option<String>,
    pub agent_id: Option<String>,
    pub cwd: Option<String>,
    pub ts: Option<i64>,
    pub role: &'static str,
    /// Who wrote a user line: `ORIGIN_UNKNOWN`, `ORIGIN_HUMAN` or `ORIGIN_MACHINE` (an
    /// assistant line is always unknown). Repeated-request grouping counts only typed prompts.
    pub origin: u8,
    /// Masked, capped, with no control characters.
    pub text: String,
}

/// An older line, or one with no marker either way.
pub const ORIGIN_UNKNOWN: u8 = 0;
/// `origin.kind == "human"`: the person typed it.
pub const ORIGIN_HUMAN: u8 = 1;
/// Not typed: a task notification, a peer message, a scheduled or system prompt, a compact
/// summary, or a line from a headless `claude -p` run.
pub const ORIGIN_MACHINE: u8 = 2;

#[derive(Deserialize)]
struct Block {
    #[serde(rename = "type")]
    kind: Option<String>,
    text: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Content {
    Text(String),
    Blocks(Vec<Block>),
}

#[derive(Deserialize)]
struct Inner {
    content: Option<Content>,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    uuid: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    /// `{"kind": "human" | "task-notification" | "peer" | ...}`; kept loose so a new shape
    /// is read as "unknown" instead of failing the whole line.
    origin: Option<serde_json::Value>,
    #[serde(rename = "promptSource")]
    prompt_source: Option<String>,
    #[serde(rename = "isCompactSummary")]
    is_compact_summary: Option<bool>,
    entrypoint: Option<String>,
    message: Option<Inner>,
}

fn origin_of(l: &Line) -> u8 {
    let kind = l.origin.as_ref().and_then(|o| o.get("kind").and_then(|k| k.as_str()).or_else(|| o.as_str()));
    if kind.is_some_and(|k| k != "human") || l.prompt_source.as_deref() == Some("system") || l.is_compact_summary == Some(true) || l.entrypoint.as_deref() == Some("sdk-cli") {
        return ORIGIN_MACHINE;
    }
    if kind == Some("human") {
        return ORIGIN_HUMAN;
    }
    ORIGIN_UNKNOWN
}

/// Cheap byte-level test before any JSON work: is this a user or assistant line that can
/// carry text? A user line holding only a tool result (the common big one) is dropped here.
pub fn worth_parsing(line: &[u8]) -> bool {
    let user = memmem::find(line, br#""type":"user""#).is_some();
    let asst = !user && memmem::find(line, br#""type":"assistant""#).is_some();
    if !user && !asst {
        return false;
    }
    if user && memmem::find(line, br#""tool_result""#).is_some() && memmem::find(line, br#""type":"text""#).is_none() {
        return false;
    }
    true
}

pub fn parse(line: &[u8]) -> Option<Message> {
    if !worth_parsing(line) {
        return None;
    }
    let l: Line = serde_json::from_slice(line).ok()?;
    let role: &'static str = match l.kind.as_deref()? {
        "user" => "user",
        "assistant" => "assistant",
        _ => return None,
    };
    if l.is_meta == Some(true) {
        return None;
    }
    let origin = if role == "user" { origin_of(&l) } else { ORIGIN_UNKNOWN };
    let raw = match l.message?.content? {
        Content::Text(t) => t,
        Content::Blocks(bs) => {
            let mut parts = bs.into_iter().filter(|b| b.kind.as_deref() == Some("text")).filter_map(|b| b.text);
            let first = parts.next()?;
            match parts.next() {
                None => first,
                Some(second) => {
                    let mut s = first;
                    s.push_str("\n\n");
                    s.push_str(&second);
                    for p in parts {
                        s.push_str("\n\n");
                        s.push_str(&p);
                    }
                    s
                }
            }
        }
    };
    let text = clean(&raw)?;
    Some(Message {
        uuid: l.uuid,
        session_id: l.session_id,
        agent_id: l.agent_id,
        cwd: l.cwd,
        ts: l.timestamp.as_deref().and_then(parse_iso_ms),
        role,
        origin,
        text,
    })
}

/// Cap, drop the two control characters snippets use as markers, mask secrets.
/// `None` when nothing but whitespace is left.
fn clean(raw: &str) -> Option<String> {
    let mut s = raw;
    if s.len() > TEXT_CAP {
        // Cap by characters (not bytes) without scanning more than needed.
        let end = s.char_indices().nth(TEXT_CAP).map(|(i, _)| i).unwrap_or(s.len());
        s = &s[..end];
    }
    if s.trim().is_empty() {
        return None;
    }
    let masked = mask_secrets(s);
    if masked.contains(['\u{1}', '\u{2}']) {
        Some(masked.replace(['\u{1}', '\u{2}'], " "))
    } else {
        Some(masked.into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_string_and_assistant_blocks() {
        let u = br#"{"type":"user","uuid":"u1","sessionId":"s1","cwd":"C:\\p","timestamp":"2026-11-02T09:00:00.000Z","message":{"role":"user","content":"find the flaky test"}}"#;
        let m = parse(u).unwrap();
        assert_eq!((m.role, m.text.as_str(), m.uuid.as_deref(), m.session_id.as_deref()), ("user", "find the flaky test", Some("u1"), Some("s1")));
        assert_eq!(m.cwd.as_deref(), Some("C:\\p"));
        assert_eq!(m.ts, Some(1_793_610_000_000));
        let a = br#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"thinking","thinking":"hmm"},{"type":"text","text":"Look at"},{"type":"tool_use","name":"Read","input":{"x":1}},{"type":"text","text":"the retry loop"}]}}"#;
        let m = parse(a).unwrap();
        assert_eq!(m.role, "assistant");
        assert_eq!(m.text, "Look at\n\nthe retry loop");
    }

    #[test]
    fn tool_results_meta_and_other_types_are_dropped() {
        let tr = br#"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":"lots of output"}]}}"#;
        assert!(parse(tr).is_none());
        let meta = br#"{"type":"user","isMeta":true,"message":{"content":"caveat"}}"#;
        assert!(parse(meta).is_none());
        assert!(parse(br#"{"type":"system","content":"x"}"#).is_none());
        assert!(parse(br#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"x"}]}}"#).is_none());
        assert!(parse(br#"{"type":"user","message":{"content":"   "}}"#).is_none());
        assert!(parse(b"not json at all").is_none());
    }

    #[test]
    fn who_wrote_a_user_line() {
        let line = |extra: &str| format!(r#"{{"type":"user","uuid":"u",{extra}"message":{{"content":"fix the build"}}}}"#);
        let o = |extra: &str| parse(line(extra).as_bytes()).unwrap().origin;
        assert_eq!(o(r#""origin":{"kind":"human"},"#), ORIGIN_HUMAN);
        assert_eq!(o(r#""origin":{"kind":"task-notification"},"#), ORIGIN_MACHINE);
        assert_eq!(o(r#""origin":{"kind":"peer"},"#), ORIGIN_MACHINE);
        assert_eq!(o(r#""promptSource":"system","#), ORIGIN_MACHINE);
        assert_eq!(o(r#""isCompactSummary":true,"#), ORIGIN_MACHINE);
        assert_eq!(o(r#""entrypoint":"sdk-cli","#), ORIGIN_MACHINE);
        // A typed prompt in a headless run is still not typed at a keyboard.
        assert_eq!(o(r#""origin":{"kind":"human"},"entrypoint":"sdk-cli","#), ORIGIN_MACHINE);
        // No marker, or a normal entrypoint: unknown (older lines), counted as typed later.
        assert_eq!(o(""), ORIGIN_UNKNOWN);
        assert_eq!(o(r#""entrypoint":"claude-desktop","#), ORIGIN_UNKNOWN);
        let a = br#"{"type":"assistant","origin":{"kind":"human"},"message":{"content":[{"type":"text","text":"ok"}]}}"#;
        assert_eq!(parse(a).unwrap().origin, ORIGIN_UNKNOWN);
    }

    #[test]
    fn text_next_to_a_tool_result_is_kept() {
        let l = br#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"},{"type":"text","text":"and also this"}]}}"#;
        assert_eq!(parse(l).unwrap().text, "and also this");
    }

    #[test]
    fn secrets_are_masked_and_markers_removed_and_text_capped() {
        let l = br#"{"type":"user","message":{"content":"my key is sk-ant-api03-AbCdEf0123456789xyzXYZ ok \u0001x\u0002"}}"#;
        let t = parse(l).unwrap().text;
        assert!(t.contains("my key is *** ok"), "{t}");
        assert!(!t.contains('\u{1}') && !t.contains("AbCdEf"));
        let big = "w".repeat(TEXT_CAP + 500);
        let l = format!(r#"{{"type":"user","message":{{"content":"{big}"}}}}"#);
        assert_eq!(parse(l.as_bytes()).unwrap().text.chars().count(), TEXT_CAP);
    }
}
