//! History: a quiet record of how the Claude setup changed.
//!
//! Atlas keeps its own copy of every tracked config file (content-addressed, in its own
//! data folder), notices when one changes, and also reads the copies Claude Code leaves
//! behind (`.claude.json` backups, `file-history/`). Nothing here ever writes to the Claude
//! folder; the store lives under Atlas's local data dir and nothing else is written.
//!
//! - `store`  the SQLite index and the blob folder (the only writer)
//! - `scan`   baseline / rescan, rename pairing, pruning
//! - `import` Claude Code's own backups and file-history copies
//! - `diff`   line diff plus plain-words summaries, with secrets masked
//! - `query`  what the page asks for

pub mod diff;
pub mod import;
pub mod query;
pub mod scan;
pub mod store;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::setup::model::{ItemKind, ScopeKind, SetupItem, SetupSnapshot};

/// The one pseudo item that stands for the redacted MCP part of `.claude.json`.
pub const MCP_KEY: &str = "mcp-view";

/// A file worth keeping versions of.
#[derive(Debug, Clone)]
pub struct Tracked {
    pub key: String,
    pub kind: String,
    pub scope: String,
    pub project: Option<String>,
    pub name: String,
    pub path: PathBuf,
}

/// Slash-separated path text, used for keys and matching.
pub fn norm_path(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

pub fn file_key(p: &Path) -> String {
    format!("f:{}", norm_path(p))
}

/// How well an item's kind describes the file it points at (several items can share one file,
/// e.g. every hook points at `settings.json`).
fn rank(k: ItemKind) -> u8 {
    match k {
        ItemKind::Settings => 0,
        ItemKind::Skill | ItemKind::Agent | ItemKind::Command | ItemKind::Instructions | ItemKind::Rule | ItemKind::Keybindings | ItemKind::Theme | ItemKind::StatusLine | ItemKind::OutputStyle | ItemKind::HookScript | ItemKind::AgentMemory | ItemKind::Workflow => 1,
        ItemKind::Hook | ItemKind::Permission => 2,
        _ => 3,
    }
}

/// The files to keep: one entry per real file in the user's own folder or a project, from a
/// Setup snapshot. Nothing from plugins or sync folders, agent worktrees or backup copies,
/// and nothing the deny list covers.
pub fn tracked_from(snapshot: &SetupSnapshot) -> Vec<Tracked> {
    let names: HashMap<&str, &str> = snapshot.projects.iter().map(|p| (p.id.as_str(), p.name.as_str())).collect();
    let mut by_path: HashMap<String, (u8, Tracked)> = HashMap::new();
    for it in &snapshot.items {
        if let Some(t) = tracked_item(it, &names) {
            let r = rank(it.kind);
            let k = t.key.clone();
            match by_path.get(&k) {
                Some((old, _)) if *old <= r => {}
                _ => {
                    by_path.insert(k, (r, t));
                }
            }
        }
    }
    let mut out: Vec<Tracked> = by_path.into_values().map(|(_, t)| t).collect();
    out.sort_by(|a, b| a.key.cmp(&b.key));
    out
}

fn tracked_item(it: &SetupItem, names: &HashMap<&str, &str>) -> Option<Tracked> {
    if it.backup || it.worktree || it.real_project_file || !matches!(it.scope, ScopeKind::User | ScopeKind::Project) {
        return None;
    }
    let path = PathBuf::from(it.path.as_ref()?);
    let name = path.file_name()?.to_string_lossy().into_owned();
    if crate::layout::is_denied_name(&name) || !path.is_absolute() {
        return None;
    }
    let project = it.project_id.as_deref().and_then(|id| names.get(id)).map(|s| s.to_string());
    let label = if it.name.is_empty() { name } else { it.name.clone() };
    Some(Tracked {
        key: file_key(&path),
        kind: it.kind.as_str().to_string(),
        scope: match it.scope {
            ScopeKind::User => "user",
            _ => "project",
        }
        .to_string(),
        project,
        name: label,
        path,
    })
}

/// Kind groups the page filters by, as the item kinds each one holds.
pub fn kind_group(group: &str) -> Option<&'static [&'static str]> {
    Some(match group {
        "settings" => &["settings", "keybindings", "statusLine", "permission", "theme"],
        "skills" => &["skill"],
        "agents" => &["agent", "agentMemory"],
        "hooks" => &["hook", "hookScript"],
        "mcp" => &["mcpServer"],
        "instructions" => &["instructions", "rule"],
        _ => return None,
    })
}

/// Every kind that belongs to a named group (the rest is "other").
pub const GROUPED_KINDS: &[&str] = &["settings", "keybindings", "statusLine", "permission", "theme", "skill", "agent", "agentMemory", "hook", "hookScript", "mcpServer", "instructions", "rule"];

/// Where the store for one Claude folder lives: `<local data>/history/<hash of the folder>`.
pub fn store_dir(local_data_dir: &Path, config_dir: &Path) -> PathBuf {
    let h = crate::setup::model::fnv1a64(&norm_path(config_dir).to_lowercase());
    local_data_dir.join("history").join(format!("{h:016x}"))
}

/// Refuse to save a copy somewhere that would change Claude's setup: inside the Claude
/// folder, inside any `.claude` folder, or over `.claude.json`.
pub fn save_copy_guard(dest: &Path, config_dir: &Path) -> Result<(), String> {
    let d = norm_path(dest).to_lowercase();
    let c = norm_path(config_dir).to_lowercase();
    let c = c.trim_end_matches('/');
    let inside_root = d == c || d.starts_with(&format!("{c}/"));
    let in_dot_claude = d.split('/').any(|p| p == ".claude");
    let claude_json = d.rsplit('/').next().is_some_and(|n| n == ".claude.json" || n.starts_with(".claude.json."));
    if inside_root || in_dot_claude || claude_json {
        return Err("A copy can't be saved into a Claude folder. Pick somewhere else.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_never_land_in_claude_folders() {
        let root = Path::new("C:/Users/Will/.claude");
        assert!(save_copy_guard(Path::new("C:/Users/Will/.claude/skills/x.md"), root).is_err());
        assert!(save_copy_guard(Path::new("D:/proj/.claude/settings.json"), root).is_err());
        assert!(save_copy_guard(Path::new("C:/Users/Will/.claude.json"), root).is_err());
        assert!(save_copy_guard(Path::new("C:/Users/Will/Desktop/settings.json"), root).is_ok());
    }
}
