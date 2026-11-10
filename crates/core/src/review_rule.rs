//! "Make this a rule": the deterministic draft text for a review theme, the byte-preserving
//! line append for a CLAUDE.md, and the small `review-rules.json` log of which themes already
//! became rules (ids and paths only). Pure functions plus one atomic JSON file; the write to the
//! Claude folder itself goes through `setup_write::apply_append` / `create_apply`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

use crate::fsutil::atomic_write;

/// The heading a CLAUDE.md line goes under.
pub const HEADING: &str = "## Caught in review";
/// What the user sees when the target changed between opening the sheet and Save.
pub const STALE_MESSAGE: &str = "This file changed since you opened it.";
/// The stamp of a file that does not exist yet.
pub const MISSING_STAMP: &str = "missing";

const LINE_PREFIX: &str = "- Check before handing work back: ";

/// A severity word ("High", "error"), bare. Dropped only when it leads the text as a label.
fn is_severity(word: &str) -> bool {
    let w = word.trim_matches(|c: char| !c.is_ascii_alphanumeric()).to_ascii_lowercase();
    matches!(w.as_str(), "critical" | "high" | "medium" | "low" | "minor" | "major" | "nit" | "blocker" | "info" | "warning" | "error")
}

/// A leading severity label: "[High]", "(medium)", "Error:", "High -". A severity word inside the
/// sentence ("Error text is swallowed") is part of the finding and stays.
fn is_label(word: &str, next: Option<&str>) -> bool {
    if !is_severity(word) {
        return false;
    }
    let wrapped = word.starts_with(['[', '(']) && word.ends_with([']', ')', ':']);
    let ends = word.ends_with(':') || word.ends_with(['-']);
    let then_sep = next.is_some_and(|n| matches!(n, "-" | ":" | "--" | "|"));
    wrapped || ends || then_sep
}

/// A directory path ("src/lib/api.ts") or a bare line reference (":42", "L42-50"): dropped from
/// the draft. A bare file name ("net.rs") is a name, not a path, and stays.
fn is_noise(word: &str) -> bool {
    looks_like_dir_path(word) || looks_like_line_ref(word)
}

/// Words that introduce a place: dropped with the path that follows them.
fn is_place_word(word: &str) -> bool {
    matches!(word.to_ascii_lowercase().as_str(), "in" | "at" | "on" | "from" | "inside" | "within")
}

/// "net.rs:42" -> "net.rs" (a trailing `:line` or `:line-line`, with any closing punctuation kept).
fn strip_line_suffix(word: &str) -> String {
    let core_end = word.trim_end_matches([')', ',', ';', '.', '"', '\'', ']']).len();
    let (core, tail) = word.split_at(core_end);
    match core.rsplit_once(':') {
        Some((head, num)) if !head.is_empty() && !num.is_empty() && num.chars().all(|c| c.is_ascii_digit() || c == '-') => format!("{head}{tail}"),
        _ => word.to_string(),
    }
}

fn looks_like_dir_path(word: &str) -> bool {
    let w = word.trim_matches(|c: char| matches!(c, '`' | '(' | ')' | ',' | ';' | ':' | '"' | '\'' | '.'));
    (w.contains('/') || w.contains('\\')) && w.len() > 2
}

fn looks_like_line_ref(word: &str) -> bool {
    let w = word.trim_matches(|c: char| matches!(c, '`' | '(' | ')' | ',' | ';' | '"' | '\''));
    let digits = |t: &str| !t.is_empty() && t.chars().all(|c| c.is_ascii_digit() || c == '-');
    // ":42", ":42-50", "L42", "L42-50". A plain number in a sentence stays.
    w.strip_prefix(':').is_some_and(digits) || w.strip_prefix(['L', 'l']).is_some_and(digits)
}

/// The longest label a draft carries; a finding can be a paragraph.
pub const LABEL_CHARS: usize = 160;
/// The longest line a CLAUDE.md rule may be, enforced on Save as well as in the draft.
pub const LINE_MAX_CHARS: usize = 400;

/// Where a markdown link starting at `chars[i]` (`[`) ends: (end of the text, end of the link).
fn link_at(chars: &[char], i: usize) -> Option<(usize, usize)> {
    let close = chars[i + 1..].iter().position(|c| *c == ']')? + i + 1;
    if chars.get(close + 1) != Some(&'(') {
        return None;
    }
    let end = chars[close + 2..].iter().position(|c| *c == ')')? + close + 2;
    Some((close, end))
}

/// `[text](url)` becomes `text`: a link in a rule would send every future chat to a page.
fn strip_links(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        match (chars[i] == '[').then(|| link_at(&chars, i)).flatten() {
            Some((close, end)) => {
                out.extend(&chars[i + 1..close]);
                i = end + 1;
            }
            None => {
                out.push(chars[i]);
                i += 1;
            }
        }
    }
    out
}

/// A `@path` word is an import in a CLAUDE.md: it would pull a file into every chat.
fn is_import(word: &str) -> bool {
    word.trim_start_matches(['(', '"', '\'', '[']).starts_with('@')
}

/// The finding text made safe to write into a rules file, without severity words, path and
/// line tokens, whitespace collapsed. Secret-looking parts are masked, `@imports`, backticks and
/// markdown links are removed, and the length is capped.
pub fn clean_label(label: &str) -> String {
    let safe = strip_links(&crate::setup::secrets::redact_inline(label)).replace('`', "");
    let all: Vec<&str> = safe.split_whitespace().filter(|w| !is_import(w)).collect();
    // A leading "[High]" / "HIGH:" / "(medium)" tag, possibly more than one.
    let mut start = 0;
    while start < all.len() && is_label(all[start], all.get(start + 1).copied()) {
        start += 1;
    }
    let mut words: Vec<String> = Vec::new();
    for w in &all[start..] {
        if is_noise(w) {
            // "in crates/core/x.rs": the place word goes with its path.
            if words.last().is_some_and(|p| is_place_word(p)) {
                words.pop();
            }
            continue;
        }
        words.push(strip_line_suffix(w));
    }
    // Dangling joiners left where a label or path was removed.
    while words.first().is_some_and(|w| matches!(w.as_str(), "-" | ":" | "--" | "|" | "in" | "at" | "on")) {
        words.remove(0);
    }
    while words.last().is_some_and(|w| matches!(w.as_str(), "-" | ":" | "--" | "|" | "in" | "at" | "on" | "(" | ")")) {
        words.pop();
    }
    // A finding that is nothing but a location ("src/a/b.rs:12"): keep the place, without the line.
    if words.is_empty() {
        words = all[start..].iter().map(|w| strip_line_suffix(w)).filter(|w| !looks_like_line_ref(w)).collect();
    }
    // Removing backticks and links can join the pieces of a secret that was split by markup
    // ("sk-ant-api03-abc`defghijklmno`"): mask once more on the finished sentence.
    let joined = crate::setup::secrets::redact_inline(&words.join(" "));
    if joined.chars().count() <= LABEL_CHARS {
        return joined;
    }
    // Cut at a word edge.
    let cut: String = joined.chars().take(LABEL_CHARS).collect();
    match cut.rsplit_once(' ') {
        Some((head, _)) if !head.is_empty() => head.to_string(),
        _ => cut,
    }
}

/// What Save accepts for a CLAUDE.md rule: exactly one `- ` line, no heading or code fence in it,
/// no control characters, at most `LINE_MAX_CHARS`. Returns the line trimmed, or a plain sentence
/// saying what is wrong. The page also limits the field; the server does not trust the page.
pub fn validate_line(text: &str) -> Result<String, &'static str> {
    let t = text.trim_end_matches(['\n', '\r', ' ', '\t']);
    let t = t.trim_start_matches(['\n', '\r']);
    if t.contains('\n') || t.contains('\r') {
        return Err("A rule is one line. Remove the extra lines.");
    }
    if t.chars().any(|c| c.is_control()) {
        return Err("The rule has a character that can't be saved.");
    }
    let Some(body) = t.strip_prefix("- ") else { return Err("A rule starts with a dash and a space.") };
    let body = body.trim();
    if body.is_empty() {
        return Err("There is nothing to add.");
    }
    if body.starts_with('#') || body.contains("```") || body.contains("~~~") {
        return Err("A rule can't hold a heading or a code block.");
    }
    if t.chars().count() > LINE_MAX_CHARS {
        return Err("That line is too long. Keep it under 400 characters.");
    }
    Ok(t.to_string())
}

/// Whether the `## Caught in review` section of `file` already has exactly this line (ignoring
/// trailing spaces and line endings). The same text in a code block or under another heading is
/// not the rule being there, so it does not count.
pub fn has_line(file: &[u8], line: &str) -> bool {
    let want = line.trim();
    let spans = line_spans(file);
    let in_fence = fence_marks(file, &spans);
    let Some((h, end)) = section_of(file, &spans, &in_fence, HEADING) else { return false };
    (h + 1..end).any(|k| !in_fence[k] && String::from_utf8_lossy(&file[spans[k].0..spans[k].1]).trim() == want)
}

fn sentence(label: &str) -> String {
    let c = clean_label(label);
    let c = c.trim().trim_end_matches(['.', ';', ':', ',']).trim();
    let mut chars = c.chars();
    let Some(first) = chars.next() else { return String::new() };
    let mut out: String = first.to_uppercase().collect();
    out.push_str(chars.as_str());
    out.push('.');
    out
}

/// `- Check before handing work back: <label cleaned, first letter upper-case, full stop>`.
pub fn draft_line(label: &str) -> String {
    format!("{LINE_PREFIX}{}", sentence(label))
}

/// `# <first 6 words, title case>` above the line, for a rule file.
pub fn rule_file_text(label: &str) -> String {
    format!("{}\n\n{}\n", rule_title(label), draft_line(label))
}

pub fn rule_title(label: &str) -> String {
    let c = clean_label(label);
    let words: Vec<String> = c
        .split_whitespace()
        .take(6)
        .map(|w| {
            let w = w.trim_matches(|ch: char| !ch.is_ascii_alphanumeric() && ch != '\'' && ch != '-');
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().collect::<String>() + &cs.as_str().to_ascii_lowercase(),
                None => String::new(),
            }
        })
        .filter(|w| !w.is_empty())
        .collect();
    if words.is_empty() {
        "# Review rule".to_string()
    } else {
        format!("# {}", words.join(" "))
    }
}

/// a-z, 0-9 and `-`, at most 40 characters, never empty.
pub fn rule_slug(label: &str) -> String {
    let c = clean_label(label).to_ascii_lowercase();
    let mut s = String::new();
    let mut dash = true;
    for ch in c.chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            s.push(ch);
            dash = false;
        } else if !dash {
            s.push('-');
            dash = true;
        }
    }
    let s: String = s.chars().take(40).collect();
    let s = s.trim_matches('-').to_string();
    if s.is_empty() {
        "review-rule".into()
    } else {
        s
    }
}

// ---------------------------------------------------------------------------
// Byte-preserving append
// ---------------------------------------------------------------------------

/// Put `text` (the editor's lines, LF) at the end of the `heading` section of `file`, adding the
/// heading at the end of the file when it is missing. Every byte outside the inserted lines is
/// kept: the BOM, line endings (the new lines use the file's own), blank lines and other
/// sections. The result differs from `file` only by the inserted bytes.
pub fn append_under_heading(file: &[u8], heading: &str, text: &str) -> Vec<u8> {
    let crlf = file.windows(2).any(|w| w == b"\r\n");
    let eol: &[u8] = if crlf { b"\r\n" } else { b"\n" };
    let lines_of = |t: &str| -> Vec<Vec<u8>> { t.replace("\r\n", "\n").trim_end_matches('\n').split('\n').map(|l| l.as_bytes().to_vec()).collect() };
    let new_lines = lines_of(text);

    let spans = line_spans(file);
    let in_fence = fence_marks(file, &spans);

    let mut out = Vec::with_capacity(file.len() + 128);
    match section_of(file, &spans, &in_fence, heading) {
        Some((h, end_line)) => {
            // Insert after the last non-blank line of the section.
            let mut last = h;
            for (k, s) in spans.iter().enumerate().take(end_line).skip(h + 1) {
                if !String::from_utf8_lossy(&file[s.0..s.1]).trim().is_empty() {
                    last = k;
                }
            }
            let at = spans[last].2;
            let had_terminator = at > spans[last].1; // the last line ended with a newline
            out.extend_from_slice(&file[..at]);
            if !had_terminator {
                out.extend_from_slice(eol);
            }
            for l in &new_lines {
                out.extend_from_slice(l);
                out.extend_from_slice(eol);
            }
            out.extend_from_slice(&file[at..]);
        }
        None => {
            out.extend_from_slice(file);
            let ends_nl = file.last() == Some(&b'\n');
            if !file.is_empty() {
                if !ends_nl {
                    out.extend_from_slice(eol);
                }
                // One blank line before the new heading unless the file already ends with one.
                let blank_before = file.ends_with(b"\n\n") || file.ends_with(b"\r\n\r\n") || file.ends_with(b"\n\r\n");
                if !blank_before {
                    out.extend_from_slice(eol);
                }
            }
            out.extend_from_slice(heading.as_bytes());
            out.extend_from_slice(eol);
            out.extend_from_slice(eol);
            for l in &new_lines {
                out.extend_from_slice(l);
                out.extend_from_slice(eol);
            }
        }
    }
    out
}

/// The lines of `file` with their byte ranges `(start, content_end, end)`; the terminator is part
/// of the range. A leading BOM is skipped.
fn line_spans(file: &[u8]) -> Vec<(usize, usize, usize)> {
    let mut spans = Vec::new();
    let mut i = if file.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
    while i < file.len() {
        let start = i;
        while i < file.len() && file[i] != b'\n' {
            i += 1;
        }
        let nl = i < file.len();
        let mut content_end = i;
        if content_end > start && file[content_end - 1] == b'\r' {
            content_end -= 1;
        }
        if nl {
            i += 1;
        }
        spans.push((start, content_end, i));
    }
    spans
}

/// The `heading` section as `(heading line, first line past the section)`, outside code fences.
/// It ends at the next heading at or above its level, or the end of the file.
fn section_of(file: &[u8], spans: &[(usize, usize, usize)], in_fence: &[bool], heading: &str) -> Option<(usize, usize)> {
    let h = spans.iter().enumerate().position(|(k, s)| !in_fence[k] && String::from_utf8_lossy(&file[s.0..s.1]).trim_end() == heading)?;
    let level = heading.chars().take_while(|c| *c == '#').count();
    let mut end_line = spans.len();
    for (k, s) in spans.iter().enumerate().skip(h + 1) {
        if in_fence[k] {
            continue;
        }
        let t = String::from_utf8_lossy(&file[s.0..s.1]);
        let hashes = t.chars().take_while(|c| *c == '#').count();
        if hashes > 0 && hashes <= level && t.chars().nth(hashes) == Some(' ') {
            end_line = k;
            break;
        }
    }
    Some((h, end_line))
}

/// One line of the "what will change" preview.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewLine {
    /// `keep` (already in the file) | `added` (a heading Atlas adds with the rule) | `slot` (the rule).
    pub kind: &'static str,
    /// The line's text; empty for `slot` (the page shows the line being edited there).
    pub text: String,
}

/// The lines around where a CLAUDE.md rule will land: up to `PREVIEW_BEFORE` lines before it, the
/// slot for the rule itself (with the heading Atlas adds when the file has none), and the line
/// after it (two lines, so the next heading shows). Found by running the real append with a marker, so the preview cannot disagree with
/// the write.
pub fn preview(file: &[u8]) -> Vec<PreviewLine> {
    const MARK: &str = "- atlas-preview-slot-7f3a";
    const PREVIEW_BEFORE: usize = 5;
    let lines_of = |b: &[u8]| -> Vec<String> {
        let b = b.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(b);
        String::from_utf8_lossy(b).lines().map(|l| l.to_string()).collect()
    };
    let before = lines_of(file);
    let after = lines_of(&append_under_heading(file, HEADING, MARK));
    let Some(slot) = after.iter().position(|l| l == MARK) else { return Vec::new() };
    // Lines the append added in front of the slot (the heading and the blank line under it).
    let added = after.len().saturating_sub(before.len() + 1).min(slot);
    let from = slot.saturating_sub(PREVIEW_BEFORE + added);
    let to = (slot + 3).min(after.len());
    let mut out = Vec::new();
    for (k, text) in after.iter().enumerate().take(to).skip(from) {
        let kind = if k == slot {
            "slot"
        } else if k >= slot - added && k < slot {
            "added"
        } else {
            "keep"
        };
        out.push(PreviewLine { kind, text: if k == slot { String::new() } else { text.clone() } });
    }
    out
}

/// Which lines are inside (or are the edge of) a fenced code block. A fence opens with three or more
/// backticks or tildes and closes only on the same character, at least as long, with nothing after
/// it (CommonMark), so a shorter or different fence inside the block does not end it.
fn fence_marks(file: &[u8], spans: &[(usize, usize, usize)]) -> Vec<bool> {
    let mut v = vec![false; spans.len()];
    let mut open: Option<(char, usize)> = None;
    for (k, s) in spans.iter().enumerate() {
        let t = String::from_utf8_lossy(&file[s.0..s.1]);
        let t = t.trim_start();
        let ch = t.chars().next().filter(|c| *c == '`' || *c == '~');
        let run = ch.map_or(0, |c| t.chars().take_while(|x| *x == c).count());
        match open {
            None => {
                // A backtick fence's info string cannot hold a backtick ("```x```" is inline code).
                let opens = run >= 3 && !(ch == Some('`') && t[run..].contains('`'));
                if opens {
                    open = Some((ch.unwrap_or('`'), run));
                    v[k] = true;
                }
            }
            Some((c, len)) => {
                v[k] = true;
                if ch == Some(c) && run >= len && t[run..].trim().is_empty() {
                    open = None;
                }
            }
        }
    }
    v
}

/// The CLAUDE.md a missing global file starts as: the heading and the line.
pub fn new_instructions_text(text: &str) -> String {
    format!("{HEADING}\n\n{}\n", text.replace("\r\n", "\n").trim_end_matches('\n'))
}

// ---------------------------------------------------------------------------
// review-rules.json
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MadeRule {
    pub path: String,
    pub made_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct RulesFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    rules: BTreeMap<String, MadeRule>,
}

pub fn rules_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("review-rules.json")
}

/// Theme id -> where it became a rule. A missing or unreadable file is an empty list.
pub fn load(data_dir: &Path) -> BTreeMap<String, MadeRule> {
    std::fs::read(rules_path(data_dir)).ok().and_then(|b| serde_json::from_slice::<RulesFile>(&b).ok()).map(|f| f.rules).unwrap_or_default()
}

pub fn record(data_dir: &Path, theme_id: &str, path: &str, made_ms: u64) -> std::io::Result<()> {
    let mut rules = load(data_dir);
    rules.insert(theme_id.to_string(), MadeRule { path: path.to_string(), made_ms });
    save(data_dir, rules)
}

pub fn forget(data_dir: &Path, theme_id: &str) -> std::io::Result<()> {
    let mut rules = load(data_dir);
    if rules.remove(theme_id).is_none() {
        return Ok(());
    }
    save(data_dir, rules)
}

fn save(data_dir: &Path, rules: BTreeMap<String, MadeRule>) -> std::io::Result<()> {
    let f = RulesFile { schema_version: 1, rules };
    let text = serde_json::to_string_pretty(&f).map_err(std::io::Error::other)?;
    atomic_write(&rules_path(data_dir), text.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_preview_shows_where_the_line_lands_and_the_heading_it_adds() {
        let kinds = |p: &[PreviewLine]| p.iter().map(|l| l.kind).collect::<Vec<_>>();
        // No heading yet: a blank line, the heading and its blank line are added after the last 5 lines.
        let p = preview(b"# Notes\n\na\nb\nc\nd\ne\nf\n");
        assert_eq!(kinds(&p), ["keep", "keep", "keep", "keep", "keep", "added", "added", "added", "slot"]);
        assert_eq!(p[0].text, "b");
        assert_eq!((p[5].text.as_str(), p[6].text.as_str()), ("", "## Caught in review"));
        // An existing section: the slot sits under its last line, and the next heading follows.
        let p = preview(b"## Caught in review\n- one\n\n## Other\ntext\n");
        assert_eq!(kinds(&p), ["keep", "keep", "slot", "keep", "keep"]);
        assert_eq!(p[1].text, "- one");
        assert_eq!(p[3].text, "");
        // An empty file, then a BOM and CRLF.
        assert_eq!(kinds(&preview(b"")), ["added", "added", "slot"]);
        let p = preview(b"\xEF\xBB\xBF# T\r\nx\r\n");
        assert_eq!(p[0].text, "# T");
        assert!(p.iter().all(|l| !l.text.contains('\r')));
    }

    #[test]
    fn bare_file_names_and_severity_words_inside_the_sentence_stay() {
        assert_eq!(draft_line("Retry loop in net.rs never backs off after a failure"), "- Check before handing work back: Retry loop in net.rs never backs off after a failure.");
        assert_eq!(draft_line("Error text is swallowed instead of shown"), "- Check before handing work back: Error text is swallowed instead of shown.");
        assert_eq!(draft_line("High latency on the first paint"), "- Check before handing work back: High latency on the first paint.");
        // Only directories and line numbers go.
        assert_eq!(draft_line("Retry loop in src/net.rs:42 never backs off"), "- Check before handing work back: Retry loop never backs off.");
        assert_eq!(draft_line("net.rs:42 never backs off"), "- Check before handing work back: Net.rs never backs off.");
        // A finding that is only a location keeps the place, without the line number.
        assert_eq!(draft_line("`.github/workflows/release.yml:199`"), "- Check before handing work back: .github/workflows/release.yml.");
        // A leading label goes, in each of its usual shapes.
        assert_eq!(draft_line("Error: net.rs never backs off"), "- Check before handing work back: Net.rs never backs off.");
        assert_eq!(draft_line("High - retries are unbounded"), "- Check before handing work back: Retries are unbounded.");
        assert_eq!(draft_line("(medium) retries are unbounded"), "- Check before handing work back: Retries are unbounded.");
    }

    #[test]
    fn the_draft_drops_severity_path_and_line_and_ends_in_a_full_stop() {
        assert_eq!(draft_line("[High] src/lib/api.ts:42 missing null check on the response"), "- Check before handing work back: Missing null check on the response.");
        assert_eq!(draft_line("HIGH: handler leaks the lock in crates/core/src/x.rs"), "- Check before handing work back: Handler leaks the lock.");
        assert_eq!(draft_line("tests do not cover the empty case;"), "- Check before handing work back: Tests do not cover the empty case.");
    }

    #[test]
    fn a_plain_number_in_a_sentence_stays() {
        assert_eq!(clean_label("retries are capped at 3 attempts"), "retries are capped at 3 attempts");
    }

    #[test]
    fn title_is_the_first_six_words_in_title_case_and_slug_is_safe() {
        assert_eq!(rule_title("missing null check on the API response before use"), "# Missing Null Check On The Api");
        let s = rule_slug("[Critical] Missing null check on the API response, src/a.ts:9");
        assert_eq!(s, "missing-null-check-on-the-api-response");
        assert!(s.len() <= 40 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'));
        assert_eq!(rule_slug("???"), "review-rule");
        assert!(rule_slug(&"word ".repeat(30)).len() <= 40);
        assert!(!rule_slug(&"abc-".repeat(20)).ends_with('-'));
    }

    #[test]
    fn rule_file_has_a_heading_then_the_line() {
        assert_eq!(rule_file_text("Missing null check"), "# Missing Null Check\n\n- Check before handing work back: Missing null check.\n");
    }

    #[test]
    fn appends_under_an_existing_heading_and_keeps_every_other_byte() {
        let before = b"# Notes\n\n## Caught in review\n\n- Old one.\n\n## Other\n\ntext\n";
        let out = append_under_heading(before, HEADING, "- New.");
        assert_eq!(String::from_utf8(out).unwrap(), "# Notes\n\n## Caught in review\n\n- Old one.\n- New.\n\n## Other\n\ntext\n");
    }

    #[test]
    fn adds_the_heading_at_the_end_when_missing_with_crlf_and_bom() {
        let mut before = vec![0xEF, 0xBB, 0xBF];
        before.extend_from_slice(b"# Notes\r\n\r\nSome line\r\n");
        let out = append_under_heading(&before, HEADING, "- New.");
        let mut want = before.clone();
        want.extend_from_slice(b"\r\n## Caught in review\r\n\r\n- New.\r\n");
        assert_eq!(out, want);
        assert!(out.starts_with(&before), "every original byte stays at the front");
    }

    #[test]
    fn a_file_without_a_final_newline_and_an_empty_file_are_handled() {
        let out = append_under_heading(b"# A", HEADING, "- X.");
        assert_eq!(String::from_utf8(out).unwrap(), "# A\n\n## Caught in review\n\n- X.\n");
        let out = append_under_heading(b"", HEADING, "- X.");
        assert_eq!(String::from_utf8(out).unwrap(), "## Caught in review\n\n- X.\n");
        let out = append_under_heading(b"## Caught in review\n- Old.", HEADING, "- X.");
        assert_eq!(String::from_utf8(out).unwrap(), "## Caught in review\n- Old.\n- X.\n");
    }

    #[test]
    fn a_heading_inside_a_code_fence_is_not_the_section() {
        let before = b"```\n## Caught in review\n```\n";
        let out = append_under_heading(before, HEADING, "- X.");
        assert!(String::from_utf8(out).unwrap().ends_with("```\n\n## Caught in review\n\n- X.\n"));
    }

    #[test]
    fn the_draft_masks_secrets_and_drops_imports_links_backticks_and_length() {
        let d = draft_line("see @~/.ssh/config and [the doc](https://evil.example/x) with `eval` for sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
        assert!(!d.contains('@') && !d.contains("evil.example") && !d.contains('`') && !d.contains("sk-ant-api03"), "{d}");
        assert!(d.contains("the doc"), "{d}");
        let long = draft_line(&"word ".repeat(200));
        assert!(long.chars().count() <= LINE_PREFIX.len() + LABEL_CHARS + 1, "{}", long.len());
        assert!(validate_line(&long).is_ok());
    }

    #[test]
    fn save_accepts_exactly_one_dash_line() {
        assert_eq!(validate_line("- Check this.\n"), Ok("- Check this.".to_string()));
        assert!(validate_line("- A\n- B").is_err());
        assert!(validate_line("- A\n\n## Heading").is_err());
        assert!(validate_line("## Heading").is_err());
        assert!(validate_line("Plain text").is_err());
        assert!(validate_line("- # sneaky heading").is_err());
        assert!(validate_line("- ```sh").is_err());
        assert!(validate_line("- ").is_err());
        assert!(validate_line(&format!("- {}", "x".repeat(LINE_MAX_CHARS))).is_err());
        assert!(validate_line("- bell \u{7}").is_err());
    }

    #[test]
    fn a_secret_split_by_markup_is_masked_after_the_markup_is_stripped() {
        let c = clean_label("Leaks sk-ant-api03-abc`defghijklmnopqrstuv` in the log");
        assert!(!c.contains("sk-ant"), "{c}");
        assert!(!c.contains("defghijklmno"), "{c}");
    }

    #[test]
    fn has_line_only_counts_inside_the_review_section_outside_fences() {
        let l = "- Check before handing work back: run the tests.";
        let in_fence = format!("# Notes\n\n```\n{l}\n```\n\n## Caught in review\n\n- other\n");
        assert!(!has_line(in_fence.as_bytes(), l));
        let other = format!("## Other\n\n{l}\n\n## Caught in review\n\n- other\n");
        assert!(!has_line(other.as_bytes(), l));
        let after = format!("## Caught in review\n\n- other\n\n## Later\n\n{l}\n");
        assert!(!has_line(after.as_bytes(), l));
        let inside = format!("## Caught in review\n\n- other\n{l}\n\n## Later\n");
        assert!(has_line(inside.as_bytes(), l));
        assert!(!has_line(b"", l));
    }

    #[test]
    fn has_line_ignores_line_endings_and_trailing_spaces() {
        assert!(has_line(b"## Caught in review\r\n- Same.  \r\n", "- Same."));
        assert!(!has_line(b"## Caught in review\n- Other.\n", "- Same."));
    }

    #[test]
    fn a_longer_or_different_fence_inside_a_block_does_not_end_it() {
        // The ```` block holds a ``` line and a "## Caught in review" that are both still code.
        let before = b"````md\n```\n## Caught in review\n```\n````\n";
        let out = append_under_heading(before, HEADING, "- X.");
        assert_eq!(String::from_utf8(out).unwrap(), "````md\n```\n## Caught in review\n```\n````\n\n## Caught in review\n\n- X.\n");
        // A tilde fence is not closed by backticks.
        let before = b"~~~\n```\n## Caught in review\n~~~\n";
        let out = String::from_utf8(append_under_heading(before, HEADING, "- X.")).unwrap();
        assert!(out.ends_with("~~~\n\n## Caught in review\n\n- X.\n"), "{out}");
    }

    #[test]
    fn the_log_round_trips_and_forgets() {
        let d = tempfile::tempdir().unwrap();
        assert!(load(d.path()).is_empty());
        record(d.path(), "theme-1", "C:/x/CLAUDE.md", 5).unwrap();
        assert_eq!(load(d.path()).get("theme-1"), Some(&MadeRule { path: "C:/x/CLAUDE.md".into(), made_ms: 5 }));
        forget(d.path(), "theme-1").unwrap();
        assert!(load(d.path()).is_empty());
        forget(d.path(), "nope").unwrap();
    }
}
