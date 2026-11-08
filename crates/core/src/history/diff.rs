//! Comparing two versions of a file: a line diff with word-level marks inside changed
//! lines, and a plain-words summary above it. Secrets are masked on both sides first
//! (a changed secret reads "a hidden value changed"). Pure functions; nothing here touches
//! the disk.

use serde::Serialize;
use serde_json::{Map, Value};
use similar::{ChangeTag, TextDiff};

use crate::setup::secrets;

/// Context lines around a change.
pub const CONTEXT: usize = 3;
/// A diff is cut after this many shown lines (a new 5000-line file is not read line by line).
const MAX_SHOWN: usize = 600;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Seg {
    pub t: String,
    /// This part is what changed inside the line.
    pub c: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    /// "same" | "add" | "del"
    pub kind: &'static str,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
    /// Word-level marks for a changed line (absent for plain lines).
    pub segs: Option<Vec<Seg>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    /// Lines that are the same and hidden before this hunk.
    pub skipped_before: u32,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// "text" | "same" | "binary" | "tooLarge" | "missing"
    pub kind: &'static str,
    pub summary: Vec<String>,
    pub hunks: Vec<Hunk>,
    /// Lines that are the same and hidden after the last hunk.
    pub skipped_after: u32,
    pub added: u32,
    pub removed: u32,
    /// The text on screen was cut after `MAX_SHOWN` lines.
    pub cut: bool,
}

impl Diff {
    pub fn note(kind: &'static str, line: &str) -> Diff {
        Diff { kind, summary: vec![line.to_string()], hunks: Vec::new(), skipped_after: 0, added: 0, removed: 0, cut: false }
    }
}

fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

fn is_json_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".json") || p.ends_with(".jsonc")
}

fn is_md_path(path: &str) -> bool {
    let p = path.to_ascii_lowercase();
    p.ends_with(".md") || p.ends_with(".markdown")
}

/// Mask secrets; the masked values, in order, are returned for comparing.
fn masked(path: &str, text: &str) -> (String, Vec<String>) {
    let m = if is_json_path(path) { secrets::mask_json(text) } else { secrets::mask_plain(text) };
    (m.text, m.originals)
}

/// Compare `old` with `new` (both full texts of the file at `path`). `context` lines of
/// unchanged text stay around each change.
pub fn compare(path: &str, old: &str, new: &str, context: usize) -> Diff {
    let (old, new) = (strip_bom(old), strip_bom(new));
    let same_bytes = old == new;
    let lf = |s: &str| s.replace("\r\n", "\n");
    if same_bytes {
        return Diff::note("same", "These two are the same.");
    }
    if lf(old) == lf(new) {
        return Diff::note("same", "Only line endings changed.");
    }
    let (mo, oo) = masked(path, &lf(old));
    let (mn, on) = masked(path, &lf(new));
    let hidden = oo != on;
    let mut summary = summarize(path, &mo, &mn, hidden);
    let td = TextDiff::from_lines(mo.as_str(), mn.as_str());
    let groups = td.grouped_ops(context);
    let (mut added, mut removed) = (0u32, 0u32);
    for c in td.iter_all_changes() {
        match c.tag() {
            ChangeTag::Insert => added += 1,
            ChangeTag::Delete => removed += 1,
            ChangeTag::Equal => {}
        }
    }
    if summary.is_empty() {
        summary.push(counts_sentence(added, removed));
    }
    let total_old = mo.lines().count() as u32;
    let mut hunks = Vec::new();
    let mut shown = 0usize;
    let mut cut = false;
    let mut prev_end_old = 0u32;
    'outer: for g in &groups {
        let first_old = g.first().map(|op| op.old_range().start as u32).unwrap_or(0);
        let skipped_before = first_old.saturating_sub(prev_end_old);
        let mut lines = Vec::new();
        for op in g {
            for ch in td.iter_inline_changes(op) {
                if shown >= MAX_SHOWN {
                    cut = true;
                    hunks.push(Hunk { skipped_before, lines });
                    break 'outer;
                }
                shown += 1;
                let kind = match ch.tag() {
                    ChangeTag::Equal => "same",
                    ChangeTag::Insert => "add",
                    ChangeTag::Delete => "del",
                };
                let mut text = String::new();
                let mut segs = Vec::new();
                let mut any = false;
                for (emph, v) in ch.iter_strings_lossy() {
                    text.push_str(&v);
                    any |= emph;
                    segs.push(Seg { t: v.into_owned(), c: emph });
                }
                let text = text.trim_end_matches('\n').to_string();
                if let Some(last) = segs.last_mut() {
                    last.t = last.t.trim_end_matches('\n').to_string();
                }
                lines.push(DiffLine {
                    kind,
                    old_no: ch.old_index().map(|i| i as u32 + 1),
                    new_no: ch.new_index().map(|i| i as u32 + 1),
                    text,
                    segs: if any && kind != "same" { Some(segs) } else { None },
                });
            }
        }
        prev_end_old = g.last().map(|op| op.old_range().end as u32).unwrap_or(prev_end_old);
        hunks.push(Hunk { skipped_before, lines });
    }
    let skipped_after = if cut { 0 } else { total_old.saturating_sub(prev_end_old) };
    Diff { kind: "text", summary, hunks, skipped_after, added, removed, cut }
}

fn counts_sentence(added: u32, removed: u32) -> String {
    let plural = |n: u32| if n == 1 { "line" } else { "lines" };
    match (added, removed) {
        (0, 0) => "Nothing visible changed.".into(),
        (a, 0) => format!("Added {a} {}.", plural(a)),
        (0, r) => format!("Removed {r} {}.", plural(r)),
        (a, r) => format!("Added {a} {} and removed {r} {}.", plural(a), plural(r)),
    }
}

/// Plain-words summary of what changed between two (already masked) texts.
pub fn summarize(path: &str, old: &str, new: &str, hidden_changed: bool) -> Vec<String> {
    let mut out = Vec::new();
    if is_json_path(path) {
        if let (Ok(a), Ok(b)) = (serde_json::from_str::<Value>(old), serde_json::from_str::<Value>(new)) {
            json_summary(&a, &b, &mut out);
        }
    } else if is_md_path(path) {
        md_summary(old, new, &mut out);
    }
    if hidden_changed {
        out.push("A hidden value changed.".into());
    }
    out
}

/// One line for a timeline row: the first sentence of the summary, or a line count.
pub fn one_line(path: &str, old: Option<&str>, new: &str) -> String {
    let Some(old) = old else { return "First copy.".into() };
    let (old, new) = (strip_bom(old), strip_bom(new));
    let lf = |s: &str| s.replace("\r\n", "\n");
    if lf(old) == lf(new) {
        return "Only line endings changed.".into();
    }
    let (mo, oo) = masked(path, &lf(old));
    let (mn, on) = masked(path, &lf(new));
    let s = summarize(path, &mo, &mn, oo != on);
    if !s.is_empty() {
        return s.into_iter().take(2).collect::<Vec<_>>().join(" ");
    }
    let td = TextDiff::from_lines(mo.as_str(), mn.as_str());
    let (mut a, mut r) = (0, 0);
    for c in td.iter_all_changes() {
        match c.tag() {
            ChangeTag::Insert => a += 1,
            ChangeTag::Delete => r += 1,
            ChangeTag::Equal => {}
        }
    }
    counts_sentence(a, r)
}

// ---------------------------------------------------------------- JSON

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

fn str_set(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map(str::to_owned).unwrap_or_else(|| x.to_string())).collect(),
        _ => Vec::new(),
    }
}

fn keys(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

fn diff_lists(a: &[String], b: &[String]) -> (Vec<String>, Vec<String>) {
    let added = b.iter().filter(|x| !a.contains(x)).cloned().collect();
    let removed = a.iter().filter(|x| !b.contains(x)).cloned().collect();
    (added, removed)
}

fn short(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn json_summary(a: &Value, b: &Value, out: &mut Vec<String>) {
    let (Value::Object(ao), Value::Object(bo)) = (a, b) else {
        return;
    };
    let get = |m: &'_ Map<String, Value>, k: &str| m.get(k).cloned();
    // Permissions: one line per list that moved.
    for (list, add_word, rem_word) in [("allow", "Allowed", "No longer allows"), ("deny", "Blocked", "No longer blocks"), ("ask", "Now asks about", "No longer asks about")] {
        let pa = ao.get("permissions").and_then(|p| p.get(list));
        let pb = bo.get("permissions").and_then(|p| p.get(list));
        let (added, removed) = diff_lists(&str_set(pa), &str_set(pb));
        if !added.is_empty() {
            out.push(format!("{add_word} {}.", plural(added.len(), "command", "commands")));
        }
        if !removed.is_empty() {
            out.push(format!("{rem_word} {}.", plural(removed.len(), "command", "commands")));
        }
    }
    // The model.
    if let (ma, mb) = (get(ao, "model"), get(bo, "model"))
        && ma != mb
    {
        match (ma, mb) {
            (Some(x), Some(y)) => out.push(format!("Changed the model from {} to {}.", short(&x), short(&y))),
            (None, Some(y)) => out.push(format!("Set the model to {}.", short(&y))),
            (Some(_), None) => out.push("Went back to the default model.".into()),
            _ => {}
        }
    }
    // Hooks: by event name.
    {
        let (added, removed) = diff_lists(&keys(ao.get("hooks")), &keys(bo.get("hooks")));
        for e in &added {
            out.push(format!("Added a hook on {e}."));
        }
        for e in &removed {
            out.push(format!("Removed the hook on {e}."));
        }
        for e in keys(bo.get("hooks")).iter().filter(|e| !added.contains(e)) {
            if ao.get("hooks").and_then(|h| h.get(e)) != bo.get("hooks").and_then(|h| h.get(e)) {
                out.push(format!("Changed the hook on {e}."));
            }
        }
    }
    // Servers.
    let (sa, sb) = (keys(ao.get("mcpServers")), keys(bo.get("mcpServers")));
    let (added, removed) = diff_lists(&sa, &sb);
    for s in added {
        out.push(format!("Added the {s} server."));
    }
    for s in removed {
        out.push(format!("Removed the {s} server."));
    }
    for s in sb.iter().filter(|s| sa.contains(s)) {
        if ao.get("mcpServers").and_then(|m| m.get(s)) != bo.get("mcpServers").and_then(|m| m.get(s)) {
            out.push(format!("Changed the {s} server."));
        }
    }
    // Servers per project (the MCP view of the global file).
    if let (Some(Value::Object(pa)), Some(Value::Object(pb))) = (ao.get("projects"), bo.get("projects")) {
        let mut n_added = 0usize;
        let mut n_removed = 0usize;
        let mut n_changed = 0usize;
        for (p, v) in pb {
            match pa.get(p) {
                None => n_added += 1,
                Some(old) if old != v => n_changed += 1,
                _ => {}
            }
        }
        for p in pa.keys() {
            if !pb.contains_key(p) {
                n_removed += 1;
            }
        }
        if n_added > 0 {
            out.push(format!("{} gained server settings.", plural(n_added, "project", "projects")));
        }
        if n_changed > 0 {
            out.push(format!("Server settings changed in {}.", plural(n_changed, "project", "projects")));
        }
        if n_removed > 0 {
            out.push(format!("{} lost its server settings.", plural(n_removed, "project", "projects")));
        }
    }
    // Environment values are never shown.
    {
        let (added, removed) = diff_lists(&keys(ao.get("env")), &keys(bo.get("env")));
        if !added.is_empty() {
            out.push(format!("Added {}.", plural(added.len(), "environment variable", "environment variables")));
        }
        if !removed.is_empty() {
            out.push(format!("Removed {}.", plural(removed.len(), "environment variable", "environment variables")));
        }
    }
    // Everything else that moved, by name.
    let handled = ["permissions", "model", "hooks", "mcpServers", "projects", "env"];
    let mut others: Vec<&str> = Vec::new();
    for k in bo.keys().chain(ao.keys()) {
        if handled.contains(&k.as_str()) || others.contains(&k.as_str()) {
            continue;
        }
        if ao.get(k) != bo.get(k) {
            others.push(k);
        }
    }
    match others.len() {
        0 => {}
        1..=3 => out.push(format!("Changed {}.", others.iter().map(|k| format!("`{k}`")).collect::<Vec<_>>().join(", "))),
        n => out.push(format!("Changed {n} other settings.")),
    }
}

// ---------------------------------------------------------------- Markdown

fn frontmatter(text: &str) -> Vec<(String, String)> {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Vec::new();
    }
    let mut out: Vec<(String, String)> = Vec::new();
    for l in lines {
        if l.trim() == "---" {
            break;
        }
        if let Some((k, v)) = l.split_once(':')
            && !l.starts_with(' ')
            && !l.starts_with('\t')
        {
            out.push((k.trim().to_string(), v.trim().to_string()));
        } else if let Some(last) = out.last_mut() {
            last.1.push(' ');
            last.1.push_str(l.trim());
        }
    }
    out
}

fn md_summary(old: &str, new: &str, out: &mut Vec<String>) {
    let (fa, fb) = (frontmatter(old), frontmatter(new));
    for (k, v) in &fb {
        match fa.iter().find(|(k2, _)| k2 == k) {
            None => out.push(format!("Added `{k}` to the header.")),
            Some((_, v2)) if v2 != v => out.push(format!("The {k} changed.")),
            _ => {}
        }
    }
    for (k, _) in &fa {
        if !fb.iter().any(|(k2, _)| k2 == k) {
            out.push(format!("Removed `{k}` from the header."));
        }
    }
    if !out.is_empty() {
        let body = |t: &str| -> String {
            t.strip_prefix("---").map(|r| r.split_once("\n---").map(|(_, b)| b.to_string()).unwrap_or_default()).unwrap_or_else(|| t.to_string())
        };
        let (ba, bb) = (body(old), body(new));
        if ba != bb {
            let td = TextDiff::from_lines(ba.as_str(), bb.as_str());
            let (mut a, mut r) = (0u32, 0u32);
            for c in td.iter_all_changes() {
                match c.tag() {
                    ChangeTag::Insert => a += 1,
                    ChangeTag::Delete => r += 1,
                    ChangeTag::Equal => {}
                }
            }
            out.push(counts_sentence(a, r).replace("Added", "The text: added").replace("Removed", "the text: removed"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crlf_only_reads_plainly() {
        let d = compare("a.md", "one\r\ntwo\r\n", "one\ntwo\n", CONTEXT);
        assert_eq!(d.kind, "same");
        assert_eq!(d.summary, vec!["Only line endings changed.".to_string()]);
    }

    #[test]
    fn settings_change_is_named() {
        let a = r#"{"model":"sonnet","permissions":{"allow":["Bash(ls)"]},"hooks":{"Stop":[{"x":1}]}}"#;
        let b = r#"{"model":"opus","permissions":{"allow":["Bash(ls)","Bash(git status)"]}}"#;
        let d = compare("settings.json", a, b, CONTEXT);
        let s = d.summary.join(" ");
        assert!(s.contains("Allowed 1 command."), "{s}");
        assert!(s.contains("Changed the model from sonnet to opus."), "{s}");
        assert!(s.contains("Removed the hook on Stop."), "{s}");
        assert!(d.added > 0 || d.removed > 0);
    }

    #[test]
    fn a_changed_secret_is_hidden() {
        let a = "{\n  \"env\": {\n    \"API_TOKEN\": \"sk-aaaaaaaaaaaaaaaaaaaaaaaa\"\n  }\n}\n";
        let b = "{\n  \"env\": {\n    \"API_TOKEN\": \"sk-bbbbbbbbbbbbbbbbbbbbbbbb\"\n  }\n}\n";
        let d = compare("settings.json", a, b, CONTEXT);
        assert!(d.summary.iter().any(|l| l == "A hidden value changed."), "{:?}", d.summary);
        let all: String = d.hunks.iter().flat_map(|h| h.lines.iter()).map(|l| l.text.clone()).collect();
        assert!(!all.contains("aaaaaaaa") && !all.contains("bbbbbbbb"));
    }

    #[test]
    fn hunks_keep_three_lines_of_context_and_count_the_rest() {
        let old: String = (1..=40).map(|i| format!("line {i}\n")).collect();
        let new = old.replace("line 20\n", "line twenty\n");
        let d = compare("x.txt", &old, &new, CONTEXT);
        assert_eq!(d.hunks.len(), 1);
        assert_eq!(d.hunks[0].skipped_before, 16);
        assert_eq!(d.hunks[0].lines.len(), 8);
        assert_eq!(d.skipped_after, 17);
        assert_eq!((d.added, d.removed), (1, 1));
    }

    #[test]
    fn markdown_header_changes_come_first() {
        let a = "---\nname: x\ndescription: old words\n---\nbody\n";
        let b = "---\nname: x\ndescription: new words\n---\nbody\n";
        assert_eq!(compare("x.md", a, b, CONTEXT).summary[0], "The description changed.");
    }
}
