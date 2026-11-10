//! What a staged folder is (D17): a marketplace, a plugin, loose items, or nothing Atlas can install.
//!
//! First match wins: `.claude-plugin/marketplace.json` > `.claude-plugin/plugin.json` > loose items
//! (a root `SKILL.md`, `*/SKILL.md` and `skills/*/SKILL.md` to depth 3, `agents/*.md`,
//! `commands/*.md`, `output-styles/*.md`, also under `.claude/`, and a root `.mcp.json`).
//! Hooks and language servers are noticed and listed as not installed (spec 1.2).

use std::fs;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

pub const NOTHING: &str = "This repo has nothing Atlas can install: no skills, agents, commands, output styles, MCP servers or plugins.";

/// One thing that can be copied into the user's Claude folder.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// skill | agent | command | outputStyle | mcpServer
    pub kind: String,
    /// The name it will have (lowercase letters, numbers, dashes).
    pub name: String,
    /// The file or folder, relative to the staged tree, with `/`.
    pub rel: String,
    pub is_dir: bool,
    /// For `mcpServer`: the key inside `.mcp.json`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

/// A plugin a marketplace lists.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarketPlugin {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shaped {
    /// marketplace | plugin | loose | nothing
    pub shape: String,
    pub name: String,
    pub description: String,
    /// marketplace: the plugins it lists.
    pub plugins: Vec<MarketPlugin>,
    /// plugin and loose: what can be copied.
    pub items: Vec<Item>,
    /// Hooks and language servers that are in it but are not installed: (what, where).
    pub not_installed: Vec<NotInstalled>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NotInstalled {
    pub what: String,
    pub path: String,
}

/// Lowercase letters, digits and dashes; `None` when nothing usable is left.
pub fn slug(s: &str) -> Option<String> {
    let t: String = s.trim().chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' { c.to_ascii_lowercase() } else { '-' }).collect();
    let t = t.trim_matches(['-', '_']).to_string();
    let mut out = String::new();
    for c in t.chars() {
        if c == '-' && out.ends_with('-') {
            continue;
        }
        out.push(c);
    }
    let out: String = out.chars().take(64).collect();
    (!out.is_empty()).then_some(out)
}

fn read_json(p: &Path) -> Option<Value> {
    let bytes = fs::read(p).ok()?;
    serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).ok()
}

fn header_name(p: &Path) -> Option<String> {
    let text = fs::read_to_string(p).ok()?;
    let (fm, _, closed) = crate::setup::frontmatter::split(text.trim_start_matches('\u{feff}'));
    if !closed {
        return None;
    }
    let map = crate::setup::frontmatter::parse_yaml(fm?).ok()?;
    map.get("name").and_then(Value::as_str).map(str::to_string)
}

const SKIP_DIRS: [&str; 6] = [".git", "node_modules", ".claude-plugin", "target", "dist", "build"];

fn skill_dirs(base: &Path, dir: &Path, depth: usize, out: &mut Vec<String>) {
    if dir.join("SKILL.md").is_file() {
        out.push(dir.strip_prefix(base).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default());
        return;
    }
    if depth >= 3 {
        return;
    }
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut names: Vec<_> = rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    for n in names {
        if SKIP_DIRS.contains(&n.as_str()) || (n.starts_with('.') && n != ".claude") {
            continue;
        }
        skill_dirs(base, &dir.join(&n), depth + 1, out);
    }
}

fn md_files(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    let mut v: Vec<String> = rd.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_file())).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.to_ascii_lowercase().ends_with(".md")).collect();
    v.sort();
    v
}

/// The copyable items of `base`. `fallback` names a root `SKILL.md` that has no name of its own.
fn items(base: &Path, fallback: &str) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::new();
    let mut push = |kind: &str, name: Option<String>, rel: String, is_dir: bool, key: Option<String>| {
        if let Some(name) = name
            && !out.iter().any(|i| i.kind == kind && i.name == name)
        {
            out.push(Item { kind: kind.into(), name, rel, is_dir, key });
        }
    };
    let mut skills = Vec::new();
    skill_dirs(base, base, 0, &mut skills);
    for rel in skills {
        let dir = if rel.is_empty() { base.to_path_buf() } else { base.join(&rel) };
        let name = if rel.is_empty() {
            header_name(&dir.join("SKILL.md")).and_then(|n| slug(&n)).or_else(|| slug(fallback))
        } else {
            slug(rel.rsplit('/').next().unwrap_or(""))
        };
        push("skill", name, rel, true, None);
    }
    for prefix in ["", ".claude/"] {
        for (folder, kind) in [("agents", "agent"), ("commands", "command"), ("output-styles", "outputStyle")] {
            for f in md_files(&base.join(format!("{prefix}{folder}"))) {
                let stem = f.rsplit_once('.').map(|(s, _)| s).unwrap_or(&f);
                push(kind, slug(stem), format!("{prefix}{folder}/{f}"), false, None);
            }
        }
    }
    if let Some(v) = read_json(&base.join(".mcp.json")) {
        let servers = v.get("mcpServers").and_then(Value::as_object).or_else(|| v.as_object());
        if let Some(m) = servers {
            for (k, e) in m {
                if e.is_object() && (e.get("command").is_some() || e.get("url").is_some()) {
                    push("mcpServer", slug(k), ".mcp.json".into(), false, Some(k.clone()));
                }
            }
        }
    }
    out
}

fn not_installed(base: &Path, plugin_json: Option<&Value>) -> Vec<NotInstalled> {
    let mut out = Vec::new();
    let mut add = |what: &str, path: &str| out.push(NotInstalled { what: what.into(), path: path.into() });
    for p in ["hooks/hooks.json", ".claude/settings.json", ".claude/hooks.json"] {
        let f = base.join(p);
        if f.is_file() && (p != ".claude/settings.json" || read_json(&f).is_some_and(|v| v.get("hooks").is_some())) {
            add("hooks", p);
        }
    }
    if let Some(v) = plugin_json {
        if v.get("hooks").is_some() {
            add("hooks", ".claude-plugin/plugin.json");
        }
        if v.get("lspServers").is_some() {
            add("language servers", ".claude-plugin/plugin.json");
        }
    }
    if base.join(".lsp.json").is_file() {
        add("language servers", ".lsp.json");
    }
    out
}

/// Look at the staged tree (or the folder of it a link named).
pub fn detect(base: &Path, repo_name: &str) -> Shaped {
    let mut s = Shaped { shape: "nothing".into(), name: repo_name.to_string(), description: String::new(), plugins: Vec::new(), items: Vec::new(), not_installed: Vec::new() };
    if let Some(v) = read_json(&base.join(".claude-plugin").join("marketplace.json")) {
        s.shape = "marketplace".into();
        if let Some(n) = v.get("name").and_then(Value::as_str) {
            s.name = n.to_string();
        }
        s.description = v.pointer("/metadata/description").or_else(|| v.get("description")).and_then(Value::as_str).unwrap_or("").to_string();
        for p in v.get("plugins").and_then(Value::as_array).into_iter().flatten() {
            if let Some(n) = p.get("name").and_then(Value::as_str) {
                s.plugins.push(MarketPlugin { name: n.to_string(), description: p.get("description").and_then(Value::as_str).unwrap_or("").to_string() });
            }
        }
        return s;
    }
    rest(base, s, false)
}

/// A plugin from the catalog, looked at as what it is: a marketplace file inside it is not
/// what it installs. Always the `plugin` shape.
pub fn detect_plugin(base: &Path, name: &str) -> Shaped {
    let s = Shaped { shape: "plugin".into(), name: name.to_string(), description: String::new(), plugins: Vec::new(), items: Vec::new(), not_installed: Vec::new() };
    rest(base, s, true)
}

fn rest(base: &Path, mut s: Shaped, force_plugin: bool) -> Shaped {
    let pj = read_json(&base.join(".claude-plugin").join("plugin.json"));
    let is_plugin = force_plugin || pj.is_some();
    if let Some(v) = &pj {
        if let Some(n) = v.get("name").and_then(Value::as_str) {
            s.name = n.to_string();
        }
        s.description = v.get("description").and_then(Value::as_str).unwrap_or("").to_string();
    }
    s.items = items(base, &s.name);
    s.not_installed = not_installed(base, pj.as_ref());
    if is_plugin || !s.items.is_empty() {
        s.shape = if is_plugin { "plugin".into() } else { "loose".into() };
    }
    if s.shape == "nothing" {
        s.not_installed.clear();
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(root: &Path, rel: &str, text: &str) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, text).unwrap();
    }

    #[test]
    fn a_marketplace_beats_everything_else() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), ".claude-plugin/marketplace.json", r#"{"name":"mkt","plugins":[{"name":"a","description":"A"},{"name":"b"}]}"#);
        put(t.path(), ".claude-plugin/plugin.json", r#"{"name":"p"}"#);
        put(t.path(), "skills/x/SKILL.md", "x");
        let s = detect(t.path(), "repo");
        assert_eq!((s.shape.as_str(), s.name.as_str()), ("marketplace", "mkt"));
        assert_eq!(s.plugins.len(), 2);
        assert!(s.items.is_empty());
    }

    #[test]
    fn a_plugin_json_repo_with_hooks_and_skills() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), ".claude-plugin/plugin.json", r#"{"name":"hooky","description":"d","hooks":{"Stop":[]}}"#);
        put(t.path(), "skills/pdf/SKILL.md", "---\nname: pdf\n---\n");
        put(t.path(), "agents/Helper One.md", "a");
        put(t.path(), "hooks/hooks.json", "{}");
        let s = detect(t.path(), "repo");
        assert_eq!(s.shape, "plugin");
        let names: Vec<_> = s.items.iter().map(|i| (i.kind.as_str(), i.name.as_str())).collect();
        assert_eq!(names, [("skill", "pdf"), ("agent", "helper-one")]);
        let what: Vec<_> = s.not_installed.iter().map(|n| (n.what.as_str(), n.path.as_str())).collect();
        assert_eq!(what, [("hooks", "hooks/hooks.json"), ("hooks", ".claude-plugin/plugin.json")]);
    }

    #[test]
    fn loose_items_of_every_kind() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), "SKILL.md", "---\nname: Root Skill\n---\nbody");
        put(t.path(), "skills/a/SKILL.md", "a");
        put(t.path(), "tools/b/SKILL.md", "b");
        put(t.path(), ".claude/skills/c/SKILL.md", "c");
        put(t.path(), "node_modules/z/SKILL.md", "never");
        put(t.path(), "commands/go.md", "c");
        put(t.path(), ".claude/agents/rev.md", "a");
        put(t.path(), "output-styles/terse.md", "o");
        put(t.path(), ".mcp.json", r#"{"mcpServers":{"web":{"type":"http","url":"https://x.test/mcp"},"junk":5}}"#);
        let s = detect(t.path(), "My Repo");
        assert_eq!(s.shape, "loose");
        let mut got: Vec<_> = s.items.iter().map(|i| format!("{}:{}", i.kind, i.name)).collect();
        got.sort();
        // A root SKILL.md stops the walk, so only it is found as a skill; the rest are other kinds.
        assert_eq!(got, ["agent:rev", "command:go", "mcpServer:web", "outputStyle:terse", "skill:root-skill"]);
    }

    #[test]
    fn skills_nested_in_folders_are_found_to_depth_three() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), "skills/a/SKILL.md", "a");
        put(t.path(), "tools/b/SKILL.md", "b");
        put(t.path(), ".claude/skills/c/SKILL.md", "c");
        put(t.path(), "x/y/z/w/SKILL.md", "too deep");
        let s = detect(t.path(), "repo");
        let mut got: Vec<_> = s.items.iter().map(|i| i.rel.clone()).collect();
        got.sort();
        assert_eq!(got, [".claude/skills/c", "skills/a", "tools/b"]);
    }

    #[test]
    fn nothing_and_a_bare_readme() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), "README.md", "hi");
        put(t.path(), "src/main.rs", "fn main(){}");
        let s = detect(t.path(), "repo");
        assert_eq!(s.shape, "nothing");
        assert!(s.items.is_empty() && s.plugins.is_empty());
    }

    #[test]
    fn slugs() {
        assert_eq!(slug("Root Skill").as_deref(), Some("root-skill"));
        assert_eq!(slug("a__b").as_deref(), Some("a__b"));
        assert_eq!(slug("--x--").as_deref(), Some("x"));
        assert_eq!(slug("!!!"), None);
    }
}
