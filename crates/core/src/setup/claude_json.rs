//! A read-only view of the parts of `.claude.json` Setup needs.
//!
//! The file holds the account, caches and every project's history; Setup
//! extracts only MCP data and the list of known project folders. Server
//! entries are reduced to names, transports and redacted one-line summaries:
//! env and header values are never kept.

use std::path::Path;

use serde_json::Value;

use super::mcp::McpEntry;
use super::model::fnv1a64;

#[derive(Debug, Clone, Default)]
pub struct CjProject {
    /// The key exactly as written in the file.
    pub key: String,
    pub mcp: Vec<McpEntry>,
    pub disabled_mcp: Vec<String>,
    pub enabled_mcp: Vec<String>,
    pub enabled_json: Vec<String>,
    pub disabled_json: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CjView {
    pub user_mcp: Vec<McpEntry>,
    pub projects: Vec<CjProject>,
    /// Folders listed under `githubRepoPaths`.
    pub github_paths: Vec<String>,
}

fn strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    }
}

fn servers(v: Option<&Value>) -> Vec<McpEntry> {
    match v {
        Some(Value::Object(m)) => m.iter().map(|(k, v)| McpEntry::from_value(k, v)).collect(),
        _ => Vec::new(),
    }
}

pub fn parse(text: &str) -> Result<CjView, String> {
    let v: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(text))
        .map_err(|e| format!("line {}, column {}: {}", e.line(), e.column(), e.classify_name()))?;
    let mut view = CjView { user_mcp: servers(v.get("mcpServers")), ..Default::default() };
    if let Some(Value::Object(ps)) = v.get("projects") {
        for (key, p) in ps {
            view.projects.push(CjProject {
                key: key.clone(),
                mcp: servers(p.get("mcpServers")),
                disabled_mcp: strings(p.get("disabledMcpServers")),
                enabled_mcp: strings(p.get("enabledMcpServers")),
                enabled_json: strings(p.get("enabledMcpjsonServers")),
                disabled_json: strings(p.get("disabledMcpjsonServers")),
            });
        }
    }
    match v.get("githubRepoPaths") {
        Some(Value::Object(m)) => {
            for val in m.values() {
                match val {
                    Value::Array(a) => view.github_paths.extend(a.iter().filter_map(|x| x.as_str().map(str::to_string))),
                    Value::String(s) => view.github_paths.push(s.clone()),
                    _ => {}
                }
            }
        }
        Some(Value::Array(a)) => view.github_paths.extend(a.iter().filter_map(|x| x.as_str().map(str::to_string))),
        _ => {}
    }
    Ok(view)
}

trait ClassifyName {
    fn classify_name(&self) -> &'static str;
}
impl ClassifyName for serde_json::Error {
    fn classify_name(&self) -> &'static str {
        use serde_json::error::Category::*;
        match self.classify() {
            Io => "could not be read",
            Syntax => "not valid JSON here",
            Data => "unexpected data",
            Eof => "the file ends early",
        }
    }
}

/// Read and parse `<cj>`. `Ok(None)` when the file does not exist.
pub fn read(path: &Path) -> Result<Option<CjView>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("the file is too large".into());
    }
    let text = String::from_utf8_lossy(&bytes);
    parse(&text).map(Some)
}

/// Hash of the subtrees that change what Setup shows. A write that only
/// touches counters or caches leaves it unchanged.
pub fn relevant_hash(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let v: Value = serde_json::from_str(text.strip_prefix('\u{feff}').unwrap_or(&text)).ok()?;
    let mut acc = String::new();
    if let Some(m) = v.get("mcpServers") {
        acc.push_str(&m.to_string());
    }
    acc.push('|');
    if let Some(Value::Object(ps)) = v.get("projects") {
        for (k, p) in ps {
            acc.push_str(k);
            for f in ["mcpServers", "disabledMcpServers", "enabledMcpServers", "enabledMcpjsonServers", "disabledMcpjsonServers"] {
                acc.push('~');
                if let Some(x) = p.get(f) {
                    acc.push_str(&x.to_string());
                }
            }
            acc.push(';');
        }
    }
    acc.push('|');
    if let Some(g) = v.get("githubRepoPaths") {
        acc.push_str(&g.to_string());
    }
    Some(fnv1a64(&acc))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_mcp_state_without_values() {
        let v = parse(
            r#"{"mcpServers":{"u":{"type":"stdio","command":"node","args":["a.js"],"env":{"SECRET_TOKEN":"FIXTURE-PLACEHOLDER"}}},
                "projects":{"/p":{"mcpServers":{"l":{"type":"http","url":"https://x.test/mcp","headers":{"Authorization":"FIXTURE-PLACEHOLDER"}}},"disabledMcpServers":["u"]}},
                "numStartups":4}"#,
        )
        .unwrap();
        assert_eq!(v.user_mcp[0].env_keys, vec!["SECRET_TOKEN"]);
        assert_eq!(v.projects[0].mcp[0].header_keys, vec!["Authorization"]);
        assert_eq!(v.projects[0].disabled_mcp, vec!["u"]);
        let dump = format!("{v:?}");
        assert!(!dump.contains("FIXTURE-PLACEHOLDER"));
    }

    #[test]
    fn parse_error_has_a_position_and_no_content() {
        let e = parse("{\"a\": ").unwrap_err();
        assert!(e.starts_with("line "));
    }
}
