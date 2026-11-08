//! Installed plugins and the items inside them.
//!
//! Only plugins named in `installed_plugins.json` are read; `plugins/cache` and
//! `plugins/marketplaces` are never walked on their own.

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use super::files::{walk, Mode};
use super::model::*;
use super::projects::norm_key;
use super::secrets::redact_inline;
use super::{display_path, mtime_ms, read_head, truncate_chars, value_text, Build, ScopeCtx, SourceRef};

const PLUGIN_TOP: &[&str] = &["skills", "agents", "commands", "output-styles", "hooks"];

fn text_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(o)) => o.get("name").or_else(|| o.get("url")).and_then(Value::as_str).unwrap_or("").to_string(),
        _ => String::new(),
    }
}

impl Build<'_> {
    pub(crate) fn scan_plugins(&mut self) {
        let root = self.inputs.root.dir.clone();
        let ip = root.join("plugins").join("installed_plugins.json");
        let Some(text) = read_head(&ip, 2 * 1024 * 1024) else { return };
        let Ok(v) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return };
        let plugins = v.get("plugins").and_then(Value::as_object).cloned().unwrap_or_default();
        let markets: BTreeMap<String, String> = read_head(&root.join("plugins").join("known_marketplaces.json"), 512 * 1024)
            .and_then(|t| serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')).ok())
            .and_then(|v| v.as_object().cloned())
            .map(|m| m.iter().map(|(k, v)| (k.clone(), value_text(v.get("source").unwrap_or(&Value::Null)))).collect())
            .unwrap_or_default();

        for (id, installs) in &plugins {
            let (name, market) = id.split_once('@').unwrap_or((id.as_str(), ""));
            let list: Vec<&Value> = match installs {
                Value::Array(a) => a.iter().collect(),
                other => vec![other],
            };
            let Some(install) = list.iter().find(|i| i.get("scope").and_then(Value::as_str) == Some("user")).or_else(|| list.first()) else { continue };
            let version = install.get("version").and_then(Value::as_str).unwrap_or("");
            let mut dir = install.get("installPath").and_then(Value::as_str).map(PathBuf::from).unwrap_or_default();
            if !dir.is_dir() {
                let alt = root.join("plugins").join("cache").join(market).join(name).join(version);
                if alt.is_dir() {
                    dir = alt;
                }
            }
            let exists = dir.is_dir();
            let manifest_path = dir.join(".claude-plugin").join("plugin.json");
            let manifest: Value = read_head(&manifest_path, 256 * 1024)
                .and_then(|t| serde_json::from_str(t.trim_start_matches('\u{feff}')).ok())
                .unwrap_or(Value::Null);

            let proj = install
                .get("projectPath")
                .and_then(Value::as_str)
                .filter(|_| install.get("scope").and_then(Value::as_str) == Some("project"))
                .and_then(|p| self.col.by_key.get(&norm_key(p)).map(|&i| self.col.projects[i].clone()));
            let pscope = match &proj {
                Some(p) => self.proj_scope(p, ScopeKind::Project),
                None => ScopeCtx::user(),
            };

            let mut it = SetupItem::new(ItemKind::Plugin, pscope.kind, id.clone());
            it.description = truncate_chars(&redact_inline(manifest.get("description").and_then(Value::as_str).unwrap_or("")), 400);
            if exists {
                it.path = Some(display_path(&manifest_path)).filter(|_| manifest_path.is_file());
                if let Ok(md) = fs::metadata(&manifest_path) {
                    it.size = Some(md.len());
                    it.modified_ms = Some(mtime_ms(&md));
                }
            } else {
                it.warnings.push("The install folder is missing".into());
            }
            let ver = manifest.get("version").and_then(Value::as_str).unwrap_or(version);
            if !ver.is_empty() {
                it.chips.push(format!("v{ver}"));
                it.detail.push(DetailRow { label: "Version".into(), value: ver.into() });
            }
            if !market.is_empty() {
                it.detail.push(DetailRow { label: "Marketplace".into(), value: market.into() });
                if let Some(src) = markets.get(market).filter(|s| !s.is_empty()) {
                    it.detail.push(DetailRow { label: "Marketplace source".into(), value: truncate_chars(&redact_inline(src), 200) });
                }
            }
            for (label, key) in [("Author", "author"), ("Homepage", "homepage"), ("Repository", "repository")] {
                let t = text_of(manifest.get(key));
                if !t.is_empty() {
                    it.detail.push(DetailRow { label: label.into(), value: truncate_chars(&redact_inline(&t), 200) });
                }
            }
            if exists {
                it.detail.push(DetailRow { label: "Installed at".into(), value: display_path(&dir) });
            }
            let first_child = self.items.len() + 1;
            let src = if manifest_path.is_file() { SourceRef::File { path: manifest_path.clone() } } else { SourceRef::Text(format!("{{\n  \"plugin\": \"{id}\"\n}}\n")) };
            let id_path = if manifest_path.is_file() { manifest_path.clone() } else { ip.clone() };
            let ptr = if manifest_path.is_file() { String::new() } else { format!("/plugins/{id}") };
            let Some(pidx) = self.add(it, &pscope, &id_path, &ptr, src) else { continue };
            if !exists {
                continue;
            }

            self.plugin_paths.insert(name.to_string(), dir.clone());
            let child_scope = ScopeCtx { kind: ScopeKind::Plugin, project: None, plugin: Some(name.to_string()), worktree: false, real_project: false };
            let ents = walk(&dir, &[], Some(PLUGIN_TOP));
            self.classify(ents, &child_scope, Mode::Plugin);
            let hooks_json = dir.join("hooks").join("hooks.json");
            if let Some(t) = read_head(&hooks_json, 512 * 1024) {
                if let Ok(hv) = serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')) {
                    if let Some(h) = hv.get("hooks") {
                        self.add_hooks(h, &hooks_json, &child_scope, "/hooks", true);
                    }
                }
            }
            let dot_mcp = dir.join(".mcp.json");
            if dot_mcp.is_file() {
                self.add_mcp_file(&dot_mcp, &child_scope, "mcpServers");
            }
            if let Some(Value::Object(servers)) = manifest.get("mcpServers") {
                let mt = fs::metadata(&manifest_path).ok().map(|m| mtime_ms(&m));
                for (n, sv) in servers {
                    let e = super::mcp::McpEntry::from_value(n, sv);
                    let shown = format!("plugin:{name}:{n}");
                    self.add_mcp_entry(&e, &shown, &child_scope, &manifest_path, &["mcpServers"], mt, false);
                }
            }

            // Child counts as chips.
            let mut counts: BTreeMap<&'static str, u32> = BTreeMap::new();
            for c in &self.items[first_child.min(self.items.len())..] {
                if c.scope == ScopeKind::Plugin && c.plugin.as_deref() == Some(name) {
                    let label = match c.kind {
                        ItemKind::Skill => "skills",
                        ItemKind::Agent => "agents",
                        ItemKind::Command => "commands",
                        ItemKind::Hook => "hooks",
                        ItemKind::McpServer => "MCP servers",
                        ItemKind::OutputStyle => "output styles",
                        _ => continue,
                    };
                    *counts.entry(label).or_default() += 1;
                }
            }
            for (label, n) in counts {
                self.items[pidx].chips.push(format!("{n} {label}"));
            }
        }
    }
}
