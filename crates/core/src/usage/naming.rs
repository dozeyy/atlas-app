//! Names for sessions and subagents (Phase 2, subagent round).
//!
//! A session is named, in order, by its title (`custom-title`, then `agent-name`), then by a
//! one-line summary of its first real user prompt, then not at all (the UI says "Session in
//! <project>"). A subagent is named by the Agent/Task `description` Claude Code recorded in its
//! `.meta.json` (the same text as the parent's `tool_use` `input.description`), then by its
//! `agentType`, then by a summary of the prompt it was given, then "Helper".
//!
//! Only the short summary is cached (at most [`SUMMARY_CHARS`] characters, one line); the full
//! conversation is still read from the transcript on demand and never stored.

use serde::Deserialize;

/// The longest summary kept.
pub const SUMMARY_CHARS: usize = 80;

/// Where a name came from, for the UI's tooltip and for tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameSource {
    Description,
    AgentType,
    Prompt,
    Fallback,
}

impl NameSource {
    pub fn as_str(self) -> &'static str {
        match self {
            NameSource::Description => "description",
            NameSource::AgentType => "type",
            NameSource::Prompt => "prompt",
            NameSource::Fallback => "fallback",
        }
    }
}

/// Remove `<tag>...</tag>` blocks and stray tags (slash-command wrappers, system reminders).
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let name_len = after
            .char_indices()
            .find(|(_, c)| !(c.is_ascii_alphanumeric() || *c == '-' || *c == '_' || *c == ':'))
            .map(|(i, _)| i)
            .unwrap_or(after.len());
        let name = &after[..name_len];
        let is_tag = !name.is_empty() && after[name_len..].contains('>');
        if !is_tag {
            // A lone "<" in prose.
            out.push('<');
            rest = after;
            continue;
        }
        let close = format!("</{name}>");
        if let Some(end) = after.find(&close) {
            rest = &after[end + close.len()..];
        } else if let Some(gt) = after.find('>') {
            rest = &after[gt + 1..];
        } else {
            rest = "";
        }
    }
    out.push_str(rest);
    out
}

/// A one-line label from the start of a prompt: tags removed, first non-empty line, whitespace
/// collapsed, cut at a word boundary with "..." past [`SUMMARY_CHARS`].
pub fn summarize_prompt(text: &str) -> Option<String> {
    let cleaned = if text.contains('<') { strip_tags(text) } else { text.to_string() };
    let line = cleaned.lines().map(str::trim).find(|l| !l.is_empty())?;
    let line = line.trim_start_matches(['#', '>', '*', '-', ' ']).trim();
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return None;
    }
    if collapsed.chars().count() <= SUMMARY_CHARS {
        return Some(collapsed);
    }
    let cut = collapsed.char_indices().nth(SUMMARY_CHARS).map(|(i, _)| i).unwrap_or(collapsed.len());
    let head = &collapsed[..cut];
    let head = match head.rfind(' ') {
        Some(i) if i > SUMMARY_CHARS / 2 => &head[..i],
        _ => head,
    };
    Some(format!("{}...", head.trim_end_matches([',', ';', ':', '.', ' '])))
}

/// "general-purpose" -> "General purpose", "code_reviewer" -> "Code reviewer".
pub fn humanize_type(t: &str) -> String {
    let words = t.trim().replace(['-', '_'], " ");
    let mut cs = words.chars();
    match cs.next() {
        Some(c) => c.to_uppercase().collect::<String>() + cs.as_str(),
        None => String::new(),
    }
}

/// The name for a subagent and where it came from.
pub fn agent_name(description: Option<&str>, agent_type: Option<&str>, prompt_summary: Option<&str>) -> (String, NameSource) {
    fn clean(s: Option<&str>) -> Option<&str> {
        s.map(str::trim).filter(|s| !s.is_empty())
    }
    if let Some(d) = clean(description) {
        let one = d.lines().next().unwrap_or(d).trim();
        return (one.to_string(), NameSource::Description);
    }
    if let Some(t) = clean(agent_type) {
        return (humanize_type(t), NameSource::AgentType);
    }
    if let Some(p) = clean(prompt_summary) {
        return (p.to_string(), NameSource::Prompt);
    }
    ("Helper".to_string(), NameSource::Fallback)
}

/// The sidecar Claude Code writes next to `agent-<id>.jsonl`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentMeta {
    pub agent_type: Option<String>,
    pub description: Option<String>,
    pub tool_use_id: Option<String>,
    pub parent_agent_id: Option<String>,
    pub spawn_depth: Option<i64>,
    /// Newer Claude Code writes `finished: true` when the helper ended on its own.
    pub finished: Option<bool>,
    pub worktree_branch: Option<String>,
}

impl AgentMeta {
    pub fn parse(bytes: &[u8]) -> Option<AgentMeta> {
        let mut m: AgentMeta = serde_json::from_slice(bytes).ok()?;
        for f in [&mut m.agent_type, &mut m.description, &mut m.tool_use_id, &mut m.parent_agent_id, &mut m.worktree_branch] {
            if f.as_deref().is_some_and(|s| s.trim().is_empty()) {
                *f = None;
            }
        }
        Some(m)
    }
}

/// `agent-<hex>.jsonl` -> `<hex>`; anything else keeps its stem.
pub fn agent_id_of_stem(stem: &str) -> String {
    stem.strip_prefix("agent-").unwrap_or(stem).to_string()
}

/// A model id without a trailing bracketed suffix ("claude-opus-5-5[1m]" -> "claude-opus-5-5"):
/// the suffix picks a context size, not a different model.
pub fn base_model_id(id: &str) -> &str {
    let t = id.trim();
    match t.strip_suffix(']').and_then(|s| s.rfind('[').map(|i| &s[..i])) {
        Some(base) if !base.is_empty() => base.trim_end(),
        _ => t,
    }
}

/// A model id as people say it, always with its full version: "claude-opus-5-5" -> "Opus 5.5",
/// "claude-fable-5-2" -> "Fable 5.2", "claude-haiku-4-5-20251001" -> "Haiku 4.5", the old
/// "claude-3-5-sonnet-20241022" -> "Sonnet 3.5". Any family works, so a model Atlas has never
/// heard of still gets a real name ("claude-nova-9-1" -> "Nova 9.1"); whether it is priced is
/// a separate question (`PriceTable::is_known`). Anything else (`<synthetic>`) stays as it is.
/// The app's `modelLabel` (`src/lib/usage.ts`) follows the same rules.
pub fn model_label(id: &str) -> String {
    let id = base_model_id(id);
    let digits = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit());
    let family = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_lowercase());
    let cap = |s: &str| {
        let mut c = s.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    let Some(rest) = id.strip_prefix("claude-") else { return id.to_string() };
    let mut parts: Vec<&str> = rest.split('-').collect();
    if parts.len() > 2 && parts.last().is_some_and(|p| p.len() == 8 && digits(p, 8)) {
        parts.pop();
    }
    let version = |major: &str, minor: Option<&&str>| match minor {
        Some(n) => format!("{major}.{n}"),
        None => major.to_string(),
    };
    let minor_ok = |rest: &[&str]| rest.len() <= 1 && rest.first().is_none_or(|n| digits(n, 2));
    match parts.as_slice() {
        [f, maj, rest @ ..] if family(f) && digits(maj, 3) && minor_ok(rest) => format!("{} {}", cap(f), version(maj, rest.first())),
        [maj, rest @ .., f] if family(f) && digits(maj, 3) && minor_ok(rest) => format!("{} {}", cap(f), version(maj, rest.first())),
        _ => id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_labels_carry_the_full_version_for_every_family() {
        for (id, want) in [
            ("claude-opus-5-5", "Opus 5.5"),
            ("claude-opus-5", "Opus 5"),
            ("claude-fable-5-2", "Fable 5.2"),
            ("claude-mythos-5-2", "Mythos 5.2"),
            ("claude-sonnet-5-5", "Sonnet 5.5"),
            ("claude-haiku-5-5", "Haiku 5.5"),
            ("claude-haiku-4-5-20251001", "Haiku 4.5"),
            ("claude-opus-4-20250514", "Opus 4"),
            ("claude-3-5-sonnet-20241022", "Sonnet 3.5"),
            ("claude-3-opus-20240229", "Opus 3"),
            ("claude-nova-9-1", "Nova 9.1"),
            ("<synthetic>", "<synthetic>"),
            ("gpt-5", "gpt-5"),
            ("claude-opus", "claude-opus"),
            ("claude-opus-5-5[1m]", "Opus 5.5"),
            ("claude-sonnet-4-5-20250929[1m]", "Sonnet 4.5"),
            ("[1m]", "[1m]"),
        ] {
            assert_eq!(model_label(id), want, "{id}");
        }
    }

    #[test]
    fn summaries_are_one_short_clean_line() {
        assert_eq!(summarize_prompt("  Fix the login bug\nand the logout one").as_deref(), Some("Fix the login bug"));
        assert_eq!(summarize_prompt("\n\n# Plan the   release  ").as_deref(), Some("Plan the release"));
        assert_eq!(summarize_prompt("   \n  "), None);
        let long = "word ".repeat(40);
        let s = summarize_prompt(&long).unwrap();
        assert!(s.ends_with("..."), "{s}");
        assert!(s.chars().count() <= SUMMARY_CHARS + 3, "{s}");
        assert!(!s.contains("  "));
    }

    #[test]
    fn tag_wrappers_do_not_become_names() {
        assert_eq!(summarize_prompt("<command-name>/clear</command-name>\n<command-args></command-args>"), None);
        assert_eq!(
            summarize_prompt("<system-reminder>ignore me</system-reminder>\nAdd a dark mode toggle").as_deref(),
            Some("Add a dark mode toggle")
        );
        assert_eq!(summarize_prompt("is 3 < 5 true?").as_deref(), Some("is 3 < 5 true?"));
    }

    #[test]
    fn agent_names_fall_back_in_order() {
        let (n, s) = agent_name(Some("Find usages of Invoice"), Some("Explore"), Some("You are..."));
        assert_eq!((n.as_str(), s), ("Find usages of Invoice", NameSource::Description));
        let (n, s) = agent_name(Some("  "), Some("general-purpose"), Some("You are..."));
        assert_eq!((n.as_str(), s), ("General purpose", NameSource::AgentType));
        let (n, s) = agent_name(None, None, Some("Write unit tests for the parser"));
        assert_eq!((n.as_str(), s), ("Write unit tests for the parser", NameSource::Prompt));
        let (n, s) = agent_name(None, Some(""), None);
        assert_eq!((n.as_str(), s), ("Helper", NameSource::Fallback));
    }

    #[test]
    fn meta_parses_and_blanks_become_none() {
        let m = AgentMeta::parse(br#"{"agentType":"Explore","description":"  ","toolUseId":"toolu_1","spawnDepth":2,"parentAgentId":"abc","extra":1}"#).unwrap();
        assert_eq!(m.agent_type.as_deref(), Some("Explore"));
        assert_eq!(m.description, None);
        assert_eq!(m.spawn_depth, Some(2));
        assert_eq!(m.parent_agent_id.as_deref(), Some("abc"));
        assert!(AgentMeta::parse(b"not json").is_none());
        assert_eq!(agent_id_of_stem("agent-0f3a"), "0f3a");
    }
}
