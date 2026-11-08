//! YAML frontmatter and the facts a card needs from a markdown file.

use serde_json::{Map, Value};

pub const HEAD_BYTES: usize = 16 * 1024;
pub const WIDE_BYTES: usize = 256 * 1024;

/// What a card learns from the start of a markdown file.
#[derive(Debug, Clone, Default)]
pub struct MdMeta {
    /// Parsed frontmatter, if there was a fence and it parsed.
    pub fm: Option<Map<String, Value>>,
    pub had_fence: bool,
    /// "Frontmatter can't be read" detail: the YAML error with its line.
    pub fm_error: Option<String>,
    pub description: String,
    pub name: Option<String>,
    /// First `#` heading, else first non-empty body line.
    pub heading: Option<String>,
    pub first_line: Option<String>,
    /// `paths` entries of a rule.
    pub paths: Vec<String>,
    pub crlf: bool,
    pub bom: bool,
}

/// Split `text` into (frontmatter yaml, body). `closed` is false when the
/// opening fence has no closing one inside `text`.
pub fn split(text: &str) -> (Option<&str>, &str, bool) {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut lines = t.split_inclusive('\n');
    let Some(first) = lines.next() else { return (None, t, true) };
    if first.trim_end() != "---" {
        return (None, t, true);
    }
    let start = first.len();
    let mut pos = start;
    for line in lines {
        let trimmed = line.trim_end();
        if trimmed == "---" || trimmed == "..." {
            return (Some(&t[start..pos]), &t[pos + line.len()..], true);
        }
        pos += line.len();
    }
    (Some(&t[start..]), "", false)
}

/// True when `text` opens a fence that is not closed yet: the caller should
/// read more of the file.
pub fn needs_more(text: &str) -> bool {
    let (fm, _, closed) = split(text);
    fm.is_some() && !closed
}

pub fn parse_yaml(yaml: &str) -> Result<Map<String, Value>, String> {
    if yaml.trim().is_empty() {
        return Ok(Map::new());
    }
    match serde_yaml_ng::from_str::<Value>(yaml) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(Value::Null) => Ok(Map::new()),
        Ok(_) => Err("line 1: the frontmatter is not a list of keys".into()),
        Err(e) => {
            let line = e.location().map(|l| l.line() + 1).unwrap_or(2);
            // The error text may quote the offending line; keep only its first sentence.
            let msg = e.to_string();
            let msg = msg.split(" at line ").next().unwrap_or(&msg).trim().to_string();
            Err(format!("line {line}: {msg}"))
        }
    }
}

fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => clean(s),
        Value::Null => String::new(),
        Value::Array(a) => a.iter().map(value_text).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

pub fn analyze(text: &str) -> MdMeta {
    let mut m = MdMeta { bom: text.starts_with('\u{feff}'), crlf: text.contains("\r\n"), ..Default::default() };
    let (fm_text, body, closed) = split(text);
    if let Some(y) = fm_text {
        m.had_fence = true;
        if !closed {
            m.fm_error = Some("line 1: the closing --- is missing".into());
        } else {
            match parse_yaml(y) {
                Ok(map) => {
                    if let Some(v) = map.get("name") {
                        let n = value_text(v);
                        if !n.is_empty() {
                            m.name = Some(n);
                        }
                    }
                    if let Some(v) = map.get("description") {
                        m.description = value_text(v);
                    }
                    if let Some(v) = map.get("paths") {
                        m.paths = match v {
                            Value::Array(a) => a.iter().map(value_text).collect(),
                            Value::String(s) => s.split(',').map(|p| p.trim().to_string()).filter(|p| !p.is_empty()).collect(),
                            _ => Vec::new(),
                        };
                    }
                    m.fm = Some(map);
                }
                Err(e) => m.fm_error = Some(e),
            }
        }
    }
    for line in body.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        if m.first_line.is_none() {
            m.first_line = Some(clean(l.trim_start_matches('#').trim()));
        }
        if m.heading.is_none() && l.starts_with('#') {
            m.heading = Some(clean(l.trim_start_matches('#').trim()));
            break;
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_lf_crlf_and_bom_alike() {
        let lf = "---\nname: a\ndescription: Hello there\n---\n# Title\nbody\n";
        let crlf = lf.replace('\n', "\r\n");
        let bom = format!("\u{feff}{crlf}");
        let a = analyze(lf);
        let b = analyze(&crlf);
        let c = analyze(&bom);
        for m in [&a, &b, &c] {
            assert_eq!(m.name.as_deref(), Some("a"));
            assert_eq!(m.description, "Hello there");
            assert_eq!(m.heading.as_deref(), Some("Title"));
        }
        assert!(!a.crlf && b.crlf && c.crlf && c.bom && !b.bom);
    }

    #[test]
    fn broken_yaml_reports_a_line() {
        let m = analyze("---\nname: x\ndescription: a: b: c\n  bad: [\n---\nbody");
        assert!(m.fm_error.is_some());
        assert!(m.fm_error.unwrap().starts_with("line "));
    }

    #[test]
    fn no_fence_means_no_frontmatter() {
        let m = analyze("# Just a heading\nsome text\n");
        assert!(!m.had_fence);
        assert_eq!(m.heading.as_deref(), Some("Just a heading"));
    }

    #[test]
    fn unclosed_fence_asks_for_more() {
        assert!(needs_more("---\nname: a\n"));
        assert!(!needs_more("---\nname: a\n---\n"));
        assert!(!needs_more("plain"));
    }

    #[test]
    fn rule_paths_become_chips() {
        let m = analyze("---\npaths:\n  - \"src/**/*.ts\"\n  - docs/*.md\n---\nUse tabs.\n");
        assert_eq!(m.paths, vec!["src/**/*.ts", "docs/*.md"]);
        assert_eq!(m.first_line.as_deref(), Some("Use tabs."));
    }
}
