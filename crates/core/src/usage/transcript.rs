//! The readable conversation for Session Detail (D43). Streamed from the jsonl
//! files on demand, never cached: the ledger keeps numbers, not message text.
//! Only user and assistant text blocks are shown, each capped at 20,000 characters.

use serde::{Deserialize, Serialize};

use super::reader::{open_read_only, read_lines, Item, ReadStats, LINE_CAP};
use super::time::parse_iso_ms;

pub const TEXT_CAP: usize = 20_000;
pub const MAX_LIMIT: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub ts: Option<i64>,
    pub role: String,
    pub agent_id: Option<String>,
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    pub items: Vec<TranscriptItem>,
    pub next_cursor: Option<String>,
    /// None of the session's files exist any more.
    pub source_missing: bool,
}

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
struct Msg {
    content: Option<Content>,
}

#[derive(Deserialize)]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    timestamp: Option<String>,
    #[serde(rename = "agentId")]
    agent_id: Option<String>,
    #[serde(rename = "isMeta")]
    is_meta: Option<bool>,
    message: Option<Msg>,
}

fn cap(mut s: String) -> (String, bool) {
    if s.chars().count() <= TEXT_CAP {
        return (s, false);
    }
    let end = s.char_indices().nth(TEXT_CAP).map(|(i, _)| i).unwrap_or(s.len());
    s.truncate(end);
    (s, true)
}

/// One line to at most one item.
pub fn item_from_line(line: &[u8]) -> Option<TranscriptItem> {
    let user = memchr::memmem::find(line, br#""type":"user""#).is_some();
    let asst = memchr::memmem::find(line, br#""type":"assistant""#).is_some();
    if !user && !asst {
        return None;
    }
    let l: Line = serde_json::from_slice(line).ok()?;
    let role = l.kind.as_deref().filter(|k| *k == "user" || *k == "assistant")?.to_string();
    if l.is_meta == Some(true) {
        return None;
    }
    let text = match l.message?.content? {
        Content::Text(t) => t,
        Content::Blocks(bs) => bs
            .into_iter()
            .filter(|b| b.kind.as_deref() == Some("text"))
            .filter_map(|b| b.text)
            .collect::<Vec<_>>()
            .join("\n\n"),
    };
    if text.trim().is_empty() {
        return None;
    }
    let (text, truncated) = cap(text);
    Some(TranscriptItem {
        ts: l.timestamp.as_deref().and_then(parse_iso_ms),
        role,
        agent_id: l.agent_id,
        text,
        truncated,
    })
}

/// The most of an agent's prompt the detail page shows.
pub const PROMPT_CAP: usize = 4_000;

/// What a transcript's first real user line says (the prompt an agent was given), read from the
/// file on demand: at most the first 80 lines, never cached. Returns the text and whether it was cut.
pub fn first_prompt(path: &std::path::Path, stats: &ReadStats) -> Option<(String, bool)> {
    let file = open_read_only(path).ok()?;
    let mut found: Option<String> = None;
    let mut lines = 0usize;
    let _ = read_lines(file, 0, LINE_CAP, stats, |item, _| {
        if let Item::Line(l) = item {
            lines += 1;
            if let Some(it) = item_from_line(l)
                && it.role == "user"
            {
                found = Some(it.text);
                return false;
            }
        }
        lines < 80
    });
    let text = found?;
    if text.chars().count() <= PROMPT_CAP {
        return Some((text, false));
    }
    let end = text.char_indices().nth(PROMPT_CAP).map(|(i, _)| i).unwrap_or(text.len());
    Some((text[..end].to_string(), true))
}

/// A page of the conversation. Cursor = `<file index>:<byte offset>`.
pub fn page(
    conn: &rusqlite::Connection,
    session_id: &str,
    cursor: Option<&str>,
    limit: usize,
    stats: &ReadStats,
) -> rusqlite::Result<TranscriptPage> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let mut files: Vec<String> = Vec::new();
    {
        let mut st = conn.prepare_cached(
            "SELECT DISTINCT f.path, f.is_subagent FROM messages m JOIN files f ON f.file_id = m.file_id \
             WHERE m.session_id=?1 ORDER BY f.is_subagent, f.path",
        )?;
        for r in st.query_map([session_id], |r| r.get::<_, String>(0))? {
            files.push(r?);
        }
    }
    let (mut idx, mut offset) = cursor
        .and_then(|c| c.split_once(':'))
        .and_then(|(i, o)| Some((i.parse::<usize>().ok()?, o.parse::<u64>().ok()?)))
        .unwrap_or((0, 0));
    let source_missing = !files.iter().any(|p| std::path::Path::new(p).is_file());
    let mut items: Vec<TranscriptItem> = Vec::new();
    let mut next: Option<String> = None;
    while idx < files.len() {
        let Ok(file) = open_read_only(std::path::Path::new(&files[idx])) else {
            idx += 1;
            offset = 0;
            continue;
        };
        let mut stopped_at: Option<u64> = None;
        let committed = read_lines(file, offset, LINE_CAP, stats, |item, end| {
            if let Item::Line(l) = item
                && let Some(it) = item_from_line(l) {
                    items.push(it);
                }
            if items.len() >= limit {
                stopped_at = Some(end);
                return false;
            }
            true
        });
        match (committed, stopped_at) {
            (Ok(_), Some(end)) => {
                next = Some(format!("{idx}:{end}"));
                break;
            }
            _ => {
                idx += 1;
                offset = 0;
            }
        }
    }
    if next.is_none() && items.len() >= limit && idx < files.len() {
        next = Some(format!("{idx}:{offset}"));
    }
    Ok(TranscriptPage { items, next_cursor: next, source_missing })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_blocks_only_and_tool_results_skipped() {
        let l = br#"{"type":"assistant","timestamp":"2026-11-02T09:00:01.000Z","message":{"content":[{"type":"text","text":"hello"},{"type":"tool_use","name":"x"}]}}"#;
        let it = item_from_line(l).unwrap();
        assert_eq!(it.role, "assistant");
        assert_eq!(it.text, "hello");
        assert_eq!(it.ts, Some(1_793_610_001_000));
        let tool = br#"{"type":"user","message":{"content":[{"type":"tool_result","content":"zzz"}]}}"#;
        assert!(item_from_line(tool).is_none());
        let plain = br#"{"type":"user","message":{"content":"hi there"}}"#;
        assert_eq!(item_from_line(plain).unwrap().text, "hi there");
    }

    #[test]
    fn long_text_is_capped() {
        let big = "x".repeat(TEXT_CAP + 50);
        let l = format!(r#"{{"type":"user","message":{{"content":"{big}"}}}}"#);
        let it = item_from_line(l.as_bytes()).unwrap();
        assert!(it.truncated);
        assert_eq!(it.text.chars().count(), TEXT_CAP);
    }

    #[test]
    fn meta_lines_are_skipped() {
        let l = br#"{"type":"user","isMeta":true,"message":{"content":"caveat"}}"#;
        assert!(item_from_line(l).is_none());
    }
}
