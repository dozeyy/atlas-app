//! One transcript line -> an event (D7, D8, D10, D17, D18).
//!
//! A cheap byte search decides whether a line is worth parsing; most lines
//! (requests, tool results, snapshots) are skipped without touching JSON.
//! Parsing borrows from the line buffer and skips fields Atlas does not use.
//! No message text is ever kept.

use std::borrow::Cow;

use memchr::memmem::Finder;
use serde::Deserialize;

use super::time::parse_iso_ms;

/// What one parsed line means for the ledger.
#[derive(Debug, Clone, PartialEq)]
pub enum LineEvent {
    Message(Box<MsgEvent>),
    Title { session_id: Option<String>, title: String },
    AgentName { session_id: Option<String>, name: String },
    Relocated { session_id: Option<String>, cwd: String },
    CostState { session_id: Option<String>, usd: f64 },
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct MsgEvent {
    /// `message.id|requestId`
    pub key: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub agent_id: Option<String>,
    pub is_sidechain: bool,
    pub model: String,
    pub ts_ms: i64,
    pub input: u64,
    pub output: u64,
    pub cw5m: u64,
    pub cw1h: u64,
    pub cr: u64,
    /// No `cache_creation` breakdown: all writes were booked as 5m (D18).
    pub cw_assumed: bool,
    /// The breakdown did not sum to `cache_creation_input_tokens`; the breakdown won.
    pub cw_mismatch: bool,
    pub web_search: u64,
    pub web_fetch: u64,
    pub thinking: u64,
    pub speed: String,
    pub geo: String,
    pub service_tier: String,
    pub skill: Option<String>,
    pub mcp_server: Option<String>,
    pub mcp_tool: Option<String>,
    pub entrypoint: Option<String>,
    pub version: Option<String>,
    /// The reasoning effort the reply ran at: `perTurnEffort`, else `effort` (`low`, `medium`,
    /// `high`, `xhigh`, `max`, or whatever a newer Claude Code writes). None when the line has
    /// neither (older Claude Code, models without effort): never guessed.
    pub effort: Option<String>,
}

/// Why a line produced no event. Counted in diagnostics, never stored.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    /// Not a line type Atlas reads.
    Ignored,
    /// Looks like a transcript line but cannot be read (D8).
    Malformed,
    /// Model `<synthetic>`: not an API call (D10).
    Synthetic,
    /// All four token counts are zero (D10).
    ZeroUsage,
}

/// One tool call named on an assistant line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolUse {
    /// `Read`, `Bash`, `Skill`, `Agent`, `mcp__server__tool`, ...
    pub name: String,
    /// For `Skill`: the skill that was loaded.
    pub skill: Option<String>,
    /// For `Agent`/`Task`: the helper type that was started.
    pub agent_type: Option<String>,
}

/// The tool calls of one assistant line, with when and in which session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolLine {
    pub session_id: Option<String>,
    pub ts_ms: i64,
    pub uses: Vec<ToolUse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawToolLine<'a> {
    #[serde(rename = "type", borrow)]
    ty: Cow<'a, str>,
    #[serde(borrow, default)]
    session_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    message: Option<RawToolMsg<'a>>,
}

#[derive(Deserialize)]
struct RawToolMsg<'a> {
    #[serde(borrow, default)]
    content: Option<Vec<RawBlock<'a>>>,
}

#[derive(Deserialize)]
struct RawBlock<'a> {
    #[serde(rename = "type", borrow, default)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    input: Option<RawToolInput<'a>>,
}

#[derive(Deserialize)]
struct RawToolInput<'a> {
    #[serde(borrow, default)]
    skill: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    subagent_type: Option<Cow<'a, str>>,
}

pub struct Prefilter {
    assistant: Finder<'static>,
    tool_use: Finder<'static>,
    others: [Finder<'static>; 4],
}

impl Default for Prefilter {
    fn default() -> Self {
        Prefilter::new()
    }
}

impl Prefilter {
    pub fn new() -> Self {
        let f = |s: &'static str| Finder::new(s.as_bytes()).into_owned();
        Prefilter {
            assistant: f(r#""type":"assistant""#),
            tool_use: f(r#""type":"tool_use""#),
            others: [
                f(r#""type":"custom-title""#),
                f(r#""type":"agent-name""#),
                f(r#""type":"relocated""#),
                f(r#""type":"cost-state""#),
            ],
        }
    }

    /// How many tool calls an assistant line makes (0 for every other line type).
    pub fn tool_calls(&self, line: &[u8]) -> u64 {
        let n = self.tool_use.find_iter(line).count() as u64;
        if n > 0 && self.assistant.find(line).is_some() { n } else { 0 }
    }

    /// The tool calls an assistant line makes: each name, plus the skill a `Skill` call loads
    /// (`input.skill`) and the kind of helper an `Agent`/`Task` call starts (`input.subagent_type`).
    /// Call it only for lines `tool_calls` counted; anything unreadable yields None.
    pub fn tool_uses(&self, line: &[u8]) -> Option<ToolLine> {
        let raw: RawToolLine = serde_json::from_slice(trim_ws(line)).ok()?;
        if raw.ty != "assistant" {
            return None;
        }
        let ts_ms = raw.timestamp.as_deref().and_then(parse_iso_ms)?;
        let uses: Vec<ToolUse> = raw
            .message?
            .content?
            .into_iter()
            .filter(|b| b.ty.as_deref() == Some("tool_use"))
            .filter_map(|b| {
                let name = b.name?.into_owned();
                let (skill, agent_type) = b.input.map_or((None, None), |i| {
                    (i.skill.map(Cow::into_owned), i.subagent_type.map(Cow::into_owned))
                });
                Some(ToolUse { name, skill, agent_type })
            })
            .collect();
        if uses.is_empty() {
            return None;
        }
        Some(ToolLine { session_id: raw.session_id.map(Cow::into_owned), ts_ms, uses })
    }

    fn wanted(&self, line: &[u8]) -> bool {
        self.assistant.find(line).is_some() || self.others.iter().any(|f| f.find(line).is_some())
    }

    /// Parse one line (without its newline).
    pub fn parse(&self, line: &[u8]) -> Result<LineEvent, Skip> {
        let line = trim_ws(line);
        if line.is_empty() {
            return Err(Skip::Ignored);
        }
        // A line that is not even shaped like a JSON object is damage, not a skipped type.
        if line[0] != b'{' || line[line.len() - 1] != b'}' {
            return Err(Skip::Malformed);
        }
        if !self.wanted(line) {
            return Err(Skip::Ignored);
        }
        let raw: Raw = serde_json::from_slice(line).map_err(|_| Skip::Malformed)?;
        match raw.ty.as_ref() {
            "assistant" => message(raw),
            "custom-title" => match raw.custom_title {
                Some(t) if !t.trim().is_empty() => Ok(LineEvent::Title {
                    session_id: raw.session_id.map(Cow::into_owned),
                    title: t.trim().to_string(),
                }),
                _ => Err(Skip::Ignored),
            },
            "agent-name" => match raw.agent_name {
                Some(t) if !t.trim().is_empty() => Ok(LineEvent::AgentName {
                    session_id: raw.session_id.map(Cow::into_owned),
                    name: t.trim().to_string(),
                }),
                _ => Err(Skip::Ignored),
            },
            "relocated" => {
                let cwd = raw
                    .relocated_cwd
                    .or_else(|| raw.relocated.and_then(|r| r.relocated_cwd))
                    .filter(|c| !c.is_empty());
                match cwd {
                    Some(c) => Ok(LineEvent::Relocated {
                        session_id: raw.session_id.map(Cow::into_owned),
                        cwd: c.into_owned(),
                    }),
                    None => Err(Skip::Ignored),
                }
            }
            "cost-state" => match raw.total_cost_usd {
                Some(usd) if usd.is_finite() => Ok(LineEvent::CostState {
                    session_id: raw.session_id.map(Cow::into_owned),
                    usd,
                }),
                _ => Err(Skip::Ignored),
            },
            _ => Err(Skip::Ignored),
        }
    }
}

fn trim_ws(mut s: &[u8]) -> &[u8] {
    while let [first, rest @ ..] = s {
        if first.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    while let [rest @ .., last] = s {
        if last.is_ascii_whitespace() {
            s = rest;
        } else {
            break;
        }
    }
    s
}

fn message(raw: Raw) -> Result<LineEvent, Skip> {
    let Some(msg) = raw.message else { return Err(Skip::Malformed) };
    let Some(model) = msg.model else { return Err(Skip::Malformed) };
    if model == "<synthetic>" {
        return Err(Skip::Synthetic);
    }
    let Some(u) = msg.usage else { return Err(Skip::Malformed) };
    let input = u.input_tokens.unwrap_or(0);
    let output = u.output_tokens.unwrap_or(0);
    let cr = u.cache_read_input_tokens.unwrap_or(0);
    let total_cw = u.cache_creation_input_tokens;
    let (cw5m, cw1h, cw_assumed, cw_mismatch) = match &u.cache_creation {
        Some(b) => {
            let (a, c) = (b.ephemeral_5m_input_tokens.unwrap_or(0), b.ephemeral_1h_input_tokens.unwrap_or(0));
            match total_cw {
                // An all-zero breakdown next to real writes says nothing: book the total as 5m.
                Some(t) if a + c == 0 && t > 0 => (t, 0, true, false),
                Some(t) => (a, c, false, a + c != t),
                None => (a, c, false, false),
            }
        }
        None => match total_cw {
            Some(t) if t > 0 => (t, 0, true, false),
            _ => (0, 0, false, false),
        },
    };
    if input == 0 && output == 0 && cr == 0 && cw5m + cw1h == 0 {
        return Err(Skip::ZeroUsage);
    }
    let (Some(id), Some(req)) = (msg.id, raw.request_id) else { return Err(Skip::Malformed) };
    let Some(ts) = raw.timestamp.as_deref().and_then(parse_iso_ms) else {
        return Err(Skip::Malformed);
    };
    let st = u.server_tool_use;
    Ok(LineEvent::Message(Box::new(MsgEvent {
        key: format!("{id}|{req}"),
        session_id: raw.session_id.map(Cow::into_owned),
        cwd: raw.cwd.filter(|c| !c.is_empty()).map(Cow::into_owned),
        agent_id: raw.agent_id.filter(|c| !c.is_empty()).map(Cow::into_owned),
        is_sidechain: raw.is_sidechain.unwrap_or(false),
        // Stored without a context suffix ("claude-opus-5-5[1m]" -> "claude-opus-5-5"): one model
        // is one row in every by-model list, and the label and price are the same anyway.
        model: crate::usage::naming::base_model_id(&model).to_string(),
        ts_ms: ts,
        input,
        output,
        cw5m,
        cw1h,
        cr,
        cw_assumed,
        cw_mismatch,
        web_search: st.as_ref().and_then(|s| s.web_search_requests).unwrap_or(0),
        web_fetch: st.as_ref().and_then(|s| s.web_fetch_requests).unwrap_or(0),
        thinking: u.output_tokens_details.and_then(|d| d.thinking_tokens).unwrap_or(0),
        speed: u.speed.map(Cow::into_owned).unwrap_or_default(),
        geo: u.inference_geo.map(Cow::into_owned).unwrap_or_default(),
        service_tier: u.service_tier.map(Cow::into_owned).unwrap_or_default(),
        skill: raw.attribution_skill.map(Cow::into_owned),
        mcp_server: raw.attribution_mcp_server.map(Cow::into_owned),
        mcp_tool: raw.attribution_mcp_tool.map(Cow::into_owned),
        entrypoint: raw.entrypoint.map(Cow::into_owned),
        version: raw.version.map(Cow::into_owned),
        effort: effort_of(raw.per_turn_effort.as_deref()).or_else(|| effort_of(raw.effort.as_deref())),
    })))
}

/// A usable effort word: trimmed, lower case, short, letters only. Anything else is no effort.
pub fn effort_of(v: Option<&str>) -> Option<String> {
    let v = v?.trim();
    (!v.is_empty() && v.len() <= 16 && v.bytes().all(|b| b.is_ascii_alphabetic())).then(|| v.to_ascii_lowercase())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw<'a> {
    #[serde(rename = "type", borrow)]
    ty: Cow<'a, str>,
    #[serde(borrow, default)]
    session_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    timestamp: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    cwd: Option<Cow<'a, str>>,
    #[serde(default)]
    is_sidechain: Option<bool>,
    #[serde(borrow, default)]
    agent_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    request_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    entrypoint: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    version: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    effort: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    per_turn_effort: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    attribution_skill: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    attribution_mcp_server: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    attribution_mcp_tool: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    message: Option<RawMsg<'a>>,
    #[serde(borrow, default)]
    custom_title: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    agent_name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    relocated_cwd: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    relocated: Option<RawReloc<'a>>,
    #[serde(rename = "totalCostUSD", default)]
    total_cost_usd: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReloc<'a> {
    #[serde(borrow, default)]
    relocated_cwd: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct RawMsg<'a> {
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    usage: Option<RawUsage<'a>>,
}

#[derive(Deserialize)]
struct RawUsage<'a> {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default)]
    cache_read_input_tokens: Option<u64>,
    #[serde(default)]
    cache_creation: Option<RawCw>,
    #[serde(default)]
    server_tool_use: Option<RawTools>,
    #[serde(default)]
    output_tokens_details: Option<RawDetails>,
    #[serde(borrow, default)]
    speed: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    inference_geo: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    service_tier: Option<Cow<'a, str>>,
    // `iterations[]` is deliberately not read: top-level counts already include them (Q3, D19).
}

#[derive(Deserialize)]
struct RawCw {
    #[serde(default)]
    ephemeral_5m_input_tokens: Option<u64>,
    #[serde(default)]
    ephemeral_1h_input_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct RawTools {
    #[serde(default)]
    web_search_requests: Option<u64>,
    #[serde(default)]
    web_fetch_requests: Option<u64>,
}

#[derive(Deserialize)]
struct RawDetails {
    #[serde(default)]
    thinking_tokens: Option<u64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(usage: &str, extra: &str) -> String {
        format!(
            r#"{{"type":"assistant","sessionId":"s1","timestamp":"2026-11-02T09:00:01.000Z","cwd":"C:\\X\\Proj","requestId":"r1"{extra},"message":{{"id":"m1","model":"claude-opus-5-5","usage":{usage}}}}}"#
        )
    }

    #[test]
    fn reads_a_normal_line_and_ignores_iterations() {
        let p = Prefilter::new();
        let l = a(
            r#"{"input_tokens":10,"output_tokens":20,"cache_creation_input_tokens":300,"cache_read_input_tokens":4,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200},"iterations":[{"input_tokens":10,"output_tokens":20}]}"#,
            "",
        );
        let LineEvent::Message(m) = p.parse(l.as_bytes()).unwrap() else { panic!() };
        assert_eq!((m.input, m.output, m.cw5m, m.cw1h, m.cr), (10, 20, 100, 200, 4));
        assert_eq!(m.cwd.as_deref(), Some("C:\\X\\Proj"));
        assert!(!m.cw_assumed && !m.cw_mismatch);
        assert_eq!(m.key, "m1|r1");
    }

    #[test]
    fn missing_breakdown_is_assumed_5m_and_mismatch_is_flagged() {
        let p = Prefilter::new();
        let l = a(r#"{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":500}"#, "");
        let LineEvent::Message(m) = p.parse(l.as_bytes()).unwrap() else { panic!() };
        assert_eq!((m.cw5m, m.cw1h, m.cw_assumed), (500, 0, true));
        let l = a(
            r#"{"input_tokens":1,"output_tokens":1,"cache_creation_input_tokens":999,"cache_creation":{"ephemeral_5m_input_tokens":100,"ephemeral_1h_input_tokens":200}}"#,
            "",
        );
        let LineEvent::Message(m) = p.parse(l.as_bytes()).unwrap() else { panic!() };
        assert_eq!((m.cw5m, m.cw1h, m.cw_assumed, m.cw_mismatch), (100, 200, false, true));
    }

    #[test]
    fn skips_synthetic_zero_and_unknown_types() {
        let p = Prefilter::new();
        let syn = a(r#"{"input_tokens":1,"output_tokens":1}"#, "").replace("claude-opus-5-5", "<synthetic>");
        assert_eq!(p.parse(syn.as_bytes()), Err(Skip::Synthetic));
        let zero = a(r#"{"input_tokens":0,"output_tokens":0}"#, r#","isApiErrorMessage":true"#);
        assert_eq!(p.parse(zero.as_bytes()), Err(Skip::ZeroUsage));
        assert_eq!(p.parse(br#"{"type":"user","message":{"content":"x"}}"#), Err(Skip::Ignored));
        assert_eq!(p.parse(b"not json"), Err(Skip::Malformed));
        assert_eq!(p.parse(br#"{"type":"assistant","message":{"id":"m"#), Err(Skip::Malformed));
        assert_eq!(p.parse(br#"{"type":"assistant"}"#), Err(Skip::Malformed));
    }

    #[test]
    fn effort_prefers_the_per_turn_value_and_never_guesses() {
        let p = Prefilter::new();
        let u = r#"{"input_tokens":1,"output_tokens":1}"#;
        let get = |extra: &str| {
            let LineEvent::Message(m) = p.parse(a(u, extra).as_bytes()).unwrap() else { panic!() };
            m.effort
        };
        assert_eq!(get(r#","effort":"high","perTurnEffort":"high""#).as_deref(), Some("high"));
        assert_eq!(get(r#","effort":"high","perTurnEffort":"xhigh""#).as_deref(), Some("xhigh"));
        assert_eq!(get(r#","effort":"Medium""#).as_deref(), Some("medium"));
        assert_eq!(get(r#","perTurnEffort":"low""#).as_deref(), Some("low"));
        assert_eq!(get(""), None);
        assert_eq!(get(r#","effort":"""#), None);
        assert_eq!(get(r#","effort":"<b>""#), None);
    }

    #[test]
    fn a_context_suffix_is_stored_as_the_base_model() {
        let p = Prefilter::new();
        let line = a(r#"{"input_tokens":1,"output_tokens":1}"#, "").replace("claude-opus-5-5", "claude-opus-5-5[1m]");
        let LineEvent::Message(m) = p.parse(line.as_bytes()).unwrap() else { panic!() };
        assert_eq!(m.model, "claude-opus-5-5");
    }

    #[test]
    fn metadata_lines() {
        let p = Prefilter::new();
        assert!(matches!(
            p.parse(br#"{"type":"custom-title","customTitle":"Hello","sessionId":"s"}"#),
            Ok(LineEvent::Title { .. })
        ));
        assert!(matches!(
            p.parse(br#"{"type":"relocated","relocatedCwd":"/new/place"}"#),
            Ok(LineEvent::Relocated { .. })
        ));
        assert!(matches!(
            p.parse(br#"{"type":"cost-state","sessionId":"s","totalCostUSD":1.5}"#),
            Ok(LineEvent::CostState { usd, .. }) if usd == 1.5
        ));
        // CRLF and a BOM-free trailing \r are tolerated.
        assert!(p.parse(b"{\"type\":\"agent-name\",\"agentName\":\"x\"}\r").is_ok());
    }
}
