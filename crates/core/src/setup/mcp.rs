//! MCP server entries: what a card shows about one, without any secret.

use std::path::Path;

use serde_json::{Map, Value};

use super::model::*;
use super::projects::norm_key;
use super::secrets::{redact_inline, MASK};
use super::{display_path, mtime_ms, read_head, Build, ScopeCtx, SourceRef};

#[derive(Debug, Clone, Default)]
pub struct McpEntry {
    pub name: String,
    /// stdio | http | sse | ws | ...
    pub transport: String,
    /// `command args` or `url`, redacted, never an env or header value.
    pub summary: String,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
}

fn keys_of(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Object(m)) => m.keys().cloned().collect(),
        _ => Vec::new(),
    }
}

/// Drop `user:password@` from a URL.
fn clean_url(u: &str) -> String {
    if let Some(scheme_end) = u.find("://") {
        let rest = &u[scheme_end + 3..];
        let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
        if let Some(at) = rest[..host_end].rfind('@') {
            return format!("{}://{}{}{}", &u[..scheme_end], MASK, "@", &rest[at + 1..]);
        }
    }
    u.to_string()
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('\u{2026}');
        t
    }
}

impl McpEntry {
    pub fn from_value(name: &str, v: &Value) -> McpEntry {
        let ty = v.get("type").and_then(Value::as_str).map(str::to_string);
        let command = v.get("command").and_then(Value::as_str);
        let url = v.get("url").and_then(Value::as_str);
        let transport = ty.clone().unwrap_or_else(|| {
            if command.is_some() {
                "stdio".into()
            } else if url.is_some() {
                "http".into()
            } else {
                "unknown".into()
            }
        });
        let summary = if let Some(c) = command {
            let args: Vec<String> =
                v.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
            let joined = if args.is_empty() { c.to_string() } else { format!("{c} {}", args.join(" ")) };
            format!("{transport}: {}", truncate(&redact_inline(&joined), 140))
        } else if let Some(u) = url {
            format!("{transport}: {}", truncate(&redact_inline(&clean_url(u)), 140))
        } else {
            transport.clone()
        };
        McpEntry {
            name: name.to_string(),
            transport,
            summary,
            env_keys: keys_of(v.get("env")),
            header_keys: keys_of(v.get("headers")),
        }
    }
}

impl Build<'_> {
    /// One server card. `base` is the JSON path of the map holding it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add_mcp_entry(&mut self, e: &McpEntry, display_name: &str, scope: &ScopeCtx, file: &Path, base: &[&str], mtime: Option<i64>, shadow: bool) -> Option<usize> {
        let mut it = SetupItem::new(ItemKind::McpServer, scope.kind, display_name.to_string());
        it.path = Some(display_path(file));
        it.modified_ms = mtime;
        it.description = e.summary.clone();
        it.chips = vec![e.transport.clone()];
        it.has_secrets = !e.env_keys.is_empty() || !e.header_keys.is_empty();
        if !e.env_keys.is_empty() {
            it.detail.push(DetailRow { label: "Environment variables (names only)".into(), value: e.env_keys.join(", ") });
        }
        if !e.header_keys.is_empty() {
            it.detail.push(DetailRow { label: "Headers (names only)".into(), value: e.header_keys.join(", ") });
        }
        it.mcp = Some(McpInfo {
            transport: e.transport.clone(),
            summary: e.summary.clone(),
            env_keys: e.env_keys.clone(),
            header_keys: e.header_keys.clone(),
            ..Default::default()
        });
        if shadow {
            it.shadow_key = Some(e.name.clone());
        }
        let mut pointer: Vec<String> = base.iter().map(|s| s.to_string()).collect();
        pointer.push(e.name.clone());
        let ptr_str = format!("/{}", pointer.join("/"));
        self.add(it, scope, file, &ptr_str, SourceRef::JsonEntry { file: file.to_path_buf(), pointer })
    }

    /// A `.mcp.json`-shaped file: `{ "mcpServers": {...} }` (or the map itself).
    pub(crate) fn add_mcp_file(&mut self, path: &Path, scope: &ScopeCtx, key: &str) {
        let Some(text) = read_head(path, 1024 * 1024) else { return };
        let mtime = std::fs::metadata(path).ok().map(|m| mtime_ms(&m));
        match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
            Ok(Value::Object(root)) => {
                let (servers, base): (Option<&Map<String, Value>>, Vec<&str>) = match root.get(key) {
                    Some(Value::Object(m)) => (Some(m), vec![key]),
                    _ if !root.is_empty() && root.values().all(|v| v.get("command").is_some() || v.get("url").is_some()) => (Some(&root), vec![]),
                    _ => (None, vec![]),
                };
                let Some(servers) = servers else { return };
                let shadow = scope.kind != ScopeKind::Plugin;
                for (name, v) in servers {
                    let e = McpEntry::from_value(name, v);
                    let shown = match &scope.plugin {
                        Some(p) if scope.kind == ScopeKind::Plugin => format!("plugin:{p}:{name}"),
                        _ => name.clone(),
                    };
                    self.add_mcp_entry(&e, &shown, scope, path, &base, mtime, shadow);
                }
            }
            _ => {
                let mut it = SetupItem::new(ItemKind::Other, scope.kind, path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default());
                it.path = Some(display_path(path));
                it.description = "Can't be read".into();
                it.warnings.push("Can't be read as JSON".into());
                self.add(it, scope, path, "", SourceRef::File { path: path.to_path_buf() });
            }
        }
    }

    /// User and local servers from `.claude.json`, plus the per-project on/off matrix.
    pub(crate) fn assemble_mcp(&mut self) {
        let Some(cj) = self.cj.clone() else { return };
        let cj_path = self.inputs.root.claude_json.clone();
        let mtime = std::fs::metadata(&cj_path).ok().map(|m| mtime_ms(&m));
        // Projects Claude has run in, as the matrix columns.
        let mut matrix: Vec<(String, String, Vec<String>)> = Vec::new(); // id, name, disabled
        for cp in &cj.projects {
            if let Some(&i) = self.col.by_key.get(&norm_key(&cp.key)) {
                let p = &self.col.projects[i];
                if !p.is_worktree && p.exists {
                    matrix.push((p.id.clone(), p.name.clone(), cp.disabled_mcp.clone()));
                }
            }
        }
        let user_scope = ScopeCtx::user();
        for e in &cj.user_mcp {
            let Some(idx) = self.add_mcp_entry(e, &e.name, &user_scope, &cj_path, &["mcpServers"], mtime, true) else { continue };
            let per: Vec<ProjectState> = matrix
                .iter()
                .map(|(id, name, disabled)| ProjectState { project_id: id.clone(), project_name: name.clone(), on: !disabled.iter().any(|d| d == &e.name) })
                .collect();
            let on = per.iter().filter(|p| p.on).count() as u32;
            let total = per.len() as u32;
            let it = &mut self.items[idx];
            if let Some(m) = it.mcp.as_mut() {
                m.per_project = per;
                m.on_count = on;
                m.total_projects = total;
            }
            it.enabled = if total == 0 {
                Enabled::on()
            } else if on == 0 {
                Enabled::of(EnabledKind::Off, "Off in all projects")
            } else {
                Enabled::of(EnabledKind::On, &format!("On in {on} of {total} projects"))
            };
        }
        for cp in &cj.projects {
            if cp.mcp.is_empty() {
                continue;
            }
            let Some(&i) = self.col.by_key.get(&norm_key(&cp.key)) else { continue };
            let p = self.col.projects[i].clone();
            let scope = self.proj_scope(&p, ScopeKind::Local);
            for e in &cp.mcp {
                let Some(idx) = self.add_mcp_entry(e, &e.name, &scope, &cj_path, &["projects", &cp.key, "mcpServers"], mtime, true) else { continue };
                self.items[idx].enabled =
                    if cp.disabled_mcp.iter().any(|d| d == &e.name) { Enabled::of(EnabledKind::Off, "Off") } else { Enabled::on() };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summary_hides_secrets_in_args_and_urls() {
        let e = McpEntry::from_value(
            "a",
            &json!({"command":"npx","args":["-y","pkg","--token=abcdefghijkl"],"env":{"K":"FIXTURE-PLACEHOLDER"}}),
        );
        assert!(!e.summary.contains("abcdefghijkl"));
        assert!(e.summary.starts_with("stdio: npx -y pkg"));
        let e = McpEntry::from_value("b", &json!({"type":"http","url":"https://u:p@h.test/mcp?api_key=zzzzzzzz1234"}));
        assert!(!e.summary.contains("zzzzzzzz1234") && !e.summary.contains("u:p"));
        assert_eq!(e.transport, "http");
    }
}
