//! What the Library installed (D23), and what Claude Code's own plugin files say is installed.
//!
//! The ledger lives at `<data>/library/ledger.json` (`schemaVersion` 1, atomic writes, one writer:
//! the Library service, under the write lock). The plugin files are read, never written, by Atlas:
//! `plugins/installed_plugins.json`, `plugins/known_marketplaces.json` and `settings.json`'s
//! `enabledPlugins` belong to Claude Code.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    /// plugin | item
    pub kind: String,
    /// plugin: the plugin id. item: `<itemKind>:<name>`.
    pub id: String,
    /// item: skill | agent | command | outputStyle | mcpServer. plugin: empty.
    #[serde(default)]
    pub item_kind: String,
    pub name: String,
    /// item: the file or folder that was written (an MCP server has none).
    #[serde(default)]
    pub path: Option<String>,
    /// `owner/repo` the files came from.
    #[serde(default)]
    pub repo: String,
    #[serde(default)]
    pub sha: String,
    /// The hash of the files that were checked (D19).
    #[serde(default)]
    pub tree_hash: String,
    /// plugin: the hash of the installed tree right after install. A different one than `tree_hash`
    /// marks "Changed since you checked it".
    #[serde(default)]
    pub installed_hash: Option<String>,
    pub installed_ms: u64,
    #[serde(default)]
    pub backup_id: String,
}

impl LedgerEntry {
    pub fn changed(&self) -> bool {
        !self.tree_hash.is_empty() && self.installed_hash.as_deref().is_some_and(|h| h != self.tree_hash)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub entries: Vec<LedgerEntry>,
}

pub fn path(data: &Path) -> PathBuf {
    super::library_dir(data).join("ledger.json")
}

/// The ledger. A missing file is an empty ledger; a file that can't be read is kept aside
/// (`ledger.json.bad-<ms>`) so the next write does not destroy it, and the ledger starts empty.
pub fn read(data: &Path) -> Ledger {
    let p = path(data);
    let Ok(bytes) = fs::read(&p) else { return Ledger { schema_version: SCHEMA_VERSION, entries: vec![] } };
    match serde_json::from_slice::<Ledger>(&bytes) {
        Ok(mut l) => {
            l.schema_version = SCHEMA_VERSION;
            l
        }
        Err(_) => {
            let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
            let _ = fs::rename(&p, p.with_extension(format!("json.bad-{ms}")));
            Ledger { schema_version: SCHEMA_VERSION, entries: vec![] }
        }
    }
}

fn write(data: &Path, l: &Ledger) -> io::Result<()> {
    let p = path(data);
    if let Some(d) = p.parent() {
        fs::create_dir_all(d)?;
    }
    let text = serde_json::to_vec_pretty(l).map_err(io::Error::other)?;
    crate::fsutil::atomic_write(&p, &text)
}

/// Add an entry (a repeat of the same kind and id replaces the older one).
pub fn add(data: &Path, e: LedgerEntry) -> io::Result<()> {
    let mut l = read(data);
    l.entries.retain(|x| !(x.kind == e.kind && x.id == e.id));
    l.entries.push(e);
    write(data, &l)
}

/// Drop the entries matching `pred`; true when something was dropped.
pub fn remove(data: &Path, pred: impl Fn(&LedgerEntry) -> bool) -> io::Result<bool> {
    let mut l = read(data);
    let before = l.entries.len();
    l.entries.retain(|x| !pred(x));
    if l.entries.len() == before {
        return Ok(false);
    }
    write(data, &l)?;
    Ok(true)
}

pub fn find(data: &Path, kind: &str, id: &str) -> Option<LedgerEntry> {
    read(data).entries.into_iter().find(|e| e.kind == kind && e.id == id)
}

/// Mark a plugin's entry with the hash of the tree found on disk (after an install or a re-check).
pub fn set_installed_hash(data: &Path, id: &str, hash: &str) -> io::Result<()> {
    let mut l = read(data);
    let mut hit = false;
    for e in l.entries.iter_mut().filter(|e| e.kind == "plugin" && e.id == id) {
        e.installed_hash = Some(hash.to_string());
        hit = true;
    }
    if hit { write(data, &l) } else { Ok(()) }
}

/// "Check again" on an installed plugin: what is on disk now is what was just looked at, so the
/// "changed since you checked it" note goes away.
pub fn recheck(data: &Path, id: &str, tree_hash: &str) -> io::Result<()> {
    let mut l = read(data);
    let mut hit = false;
    for e in l.entries.iter_mut().filter(|e| e.kind == "plugin" && e.id == id) {
        e.tree_hash = tree_hash.to_string();
        e.installed_hash = Some(tree_hash.to_string());
        hit = true;
    }
    if hit { write(data, &l) } else { Ok(()) }
}

// ---------------------------------------------------------------------------
// Claude Code's own plugin files (read only)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub scope: String,
    pub install_path: Option<String>,
    pub version: Option<String>,
    pub git_sha: Option<String>,
    pub installed_at: Option<String>,
}

fn read_json(p: &Path) -> Option<Value> {
    let bytes = fs::read(p).ok()?;
    serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).ok()
}

/// `plugins/installed_plugins.json` (`{version:2, plugins:{id:[{scope, installPath, ...}]}}`).
/// `None` when the file exists but can't be read; an empty list when it does not exist.
pub fn installed_plugins(config_dir: &Path) -> Option<Vec<InstalledPlugin>> {
    let p = config_dir.join("plugins").join("installed_plugins.json");
    if !p.exists() {
        return Some(vec![]);
    }
    let v = read_json(&p)?;
    let plugins = v.get("plugins").and_then(Value::as_object);
    let mut out = Vec::new();
    for (id, list) in plugins.into_iter().flatten() {
        for rec in list.as_array().into_iter().flatten() {
            let s = |k: &str| rec.get(k).and_then(Value::as_str).map(str::to_string);
            out.push(InstalledPlugin { id: id.clone(), scope: s("scope").unwrap_or_else(|| "user".into()), install_path: s("installPath"), version: s("version"), git_sha: s("gitCommitSha"), installed_at: s("installedAt") });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Some(out)
}

/// The user-scope record of `id`, if any.
pub fn user_install(config_dir: &Path, id: &str) -> Option<InstalledPlugin> {
    installed_plugins(config_dir)?.into_iter().find(|p| p.id == id && p.scope == "user")
}

/// `settings.json` `enabledPlugins`: id -> on.
pub fn enabled_plugins(config_dir: &Path) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    if let Some(v) = read_json(&config_dir.join("settings.json"))
        && let Some(m) = v.get("enabledPlugins").and_then(Value::as_object)
    {
        for (k, on) in m {
            out.insert(k.clone(), on.as_bool().unwrap_or(false));
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    pub name: String,
    /// `owner/repo` for GitHub, the folder for a directory, else empty.
    pub source: String,
    pub install_location: Option<String>,
}

/// `plugins/known_marketplaces.json` (`{name:{source:{source:"github",repo}|{source:"directory",path}, installLocation}}`).
pub fn marketplaces(config_dir: &Path) -> Vec<Marketplace> {
    let Some(v) = read_json(&config_dir.join("plugins").join("known_marketplaces.json")) else { return vec![] };
    let mut out: Vec<Marketplace> = v
        .as_object()
        .into_iter()
        .flatten()
        .map(|(name, m)| {
            let src = m.get("source");
            let get = |k: &str| src.and_then(|s| s.get(k)).and_then(Value::as_str).unwrap_or("").to_string();
            let source = match src.and_then(|s| s.get("source")).and_then(Value::as_str) {
                Some("github") => get("repo"),
                Some("directory") => get("path"),
                _ => get("url"),
            };
            Marketplace { name: name.clone(), source, install_location: m.get("installLocation").and_then(Value::as_str).map(str::to_string) }
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// A thing in the Installed filter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledRow {
    /// plugin | item
    pub kind: String,
    pub id: String,
    pub name: String,
    pub item_kind: String,
    pub enabled: Option<bool>,
    pub version: Option<String>,
    pub path: Option<String>,
    pub repo: String,
    pub backup_id: String,
    /// D19: the installed files are not the ones that were checked.
    pub changed: bool,
}

/// Installed plugins (Claude Code's file) and Library-copied items that are still on disk.
pub fn installed_rows(config_dir: &Path, claude_json: &Path, data: &Path) -> Vec<InstalledRow> {
    let ledger = read(data);
    let enabled = enabled_plugins(config_dir);
    let mut rows: Vec<InstalledRow> = Vec::new();
    for p in installed_plugins(config_dir).unwrap_or_default().into_iter().filter(|p| p.scope == "user") {
        let l = ledger.entries.iter().find(|e| e.kind == "plugin" && e.id == p.id);
        let name = p.id.split('@').next().unwrap_or(&p.id).to_string();
        rows.push(InstalledRow {
            kind: "plugin".into(),
            enabled: Some(enabled.get(&p.id).copied().unwrap_or(true)),
            version: p.version.clone(),
            path: p.install_path.clone(),
            repo: l.map(|e| e.repo.clone()).unwrap_or_default(),
            backup_id: l.map(|e| e.backup_id.clone()).unwrap_or_default(),
            changed: l.is_some_and(|e| e.changed()),
            item_kind: String::new(),
            name,
            id: p.id,
        });
    }
    for e in ledger.entries.iter().filter(|e| e.kind == "item") {
        let present = match &e.path {
            Some(p) => fs::symlink_metadata(p).is_ok(),
            None => item_server_present(claude_json, e),
        };
        if !present {
            continue;
        }
        rows.push(InstalledRow { kind: "item".into(), id: e.id.clone(), name: e.name.clone(), item_kind: e.item_kind.clone(), enabled: None, version: None, path: e.path.clone(), repo: e.repo.clone(), backup_id: e.backup_id.clone(), changed: false });
    }
    rows
}

/// An MCP server copied from a repo is "still there" while `.claude.json` still lists its name.
fn item_server_present(claude_json: &Path, e: &LedgerEntry) -> bool {
    read_json(claude_json).and_then(|v| v.get("mcpServers").and_then(|m| m.get(&e.name)).cloned()).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(kind: &str, id: &str) -> LedgerEntry {
        LedgerEntry { kind: kind.into(), id: id.into(), item_kind: String::new(), name: id.into(), path: None, repo: "o/r".into(), sha: "abc".into(), tree_hash: "h1".into(), installed_hash: None, installed_ms: 1, backup_id: "b".into() }
    }

    #[test]
    fn the_ledger_round_trips_and_replaces_a_repeat() {
        let t = tempfile::tempdir().unwrap();
        assert!(read(t.path()).entries.is_empty());
        add(t.path(), entry("plugin", "a@m")).unwrap();
        let mut again = entry("plugin", "a@m");
        again.sha = "def".into();
        add(t.path(), again).unwrap();
        add(t.path(), entry("item", "skill:x")).unwrap();
        let l = read(t.path());
        assert_eq!(l.schema_version, 1);
        assert_eq!(l.entries.len(), 2);
        assert_eq!(find(t.path(), "plugin", "a@m").unwrap().sha, "def");
        assert!(remove(t.path(), |e| e.kind == "item").unwrap());
        assert!(!remove(t.path(), |e| e.kind == "item").unwrap());
        assert_eq!(read(t.path()).entries.len(), 1);
    }

    #[test]
    fn a_broken_ledger_is_kept_aside_not_overwritten() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(super::super::library_dir(t.path())).unwrap();
        fs::write(path(t.path()), b"{ not json").unwrap();
        assert!(read(t.path()).entries.is_empty());
        let kept: Vec<_> = fs::read_dir(super::super::library_dir(t.path())).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.contains(".bad-")).collect();
        assert_eq!(kept.len(), 1);
    }

    #[test]
    fn changed_means_the_installed_tree_differs_from_the_checked_one() {
        let t = tempfile::tempdir().unwrap();
        add(t.path(), entry("plugin", "a@m")).unwrap();
        assert!(!find(t.path(), "plugin", "a@m").unwrap().changed());
        set_installed_hash(t.path(), "a@m", "h1").unwrap();
        assert!(!find(t.path(), "plugin", "a@m").unwrap().changed());
        set_installed_hash(t.path(), "a@m", "h2").unwrap();
        assert!(find(t.path(), "plugin", "a@m").unwrap().changed());
    }

    #[test]
    fn claude_codes_plugin_files_are_read() {
        let t = tempfile::tempdir().unwrap();
        let plugins = t.path().join("plugins");
        fs::create_dir_all(&plugins).unwrap();
        assert_eq!(installed_plugins(t.path()), Some(vec![]));
        fs::write(plugins.join("installed_plugins.json"), r#"{"version":2,"plugins":{"fd@dir":[{"scope":"user","installPath":"C:/x/fd","version":"1.0.0","gitCommitSha":"abc","installedAt":"2026-11-09"}],"p@q":[{"scope":"project","installPath":"/y"}]}}"#).unwrap();
        fs::write(plugins.join("known_marketplaces.json"), r#"{"impeccable":{"source":{"source":"github","repo":"pbakaus/impeccable"},"installLocation":"C:/m"},"local":{"source":{"source":"directory","path":"D:/mk"}}}"#).unwrap();
        fs::write(t.path().join("settings.json"), r#"{"enabledPlugins":{"fd@dir":false}}"#).unwrap();
        let p = installed_plugins(t.path()).unwrap();
        assert_eq!(p.len(), 2);
        assert_eq!(user_install(t.path(), "fd@dir").unwrap().version.as_deref(), Some("1.0.0"));
        assert!(user_install(t.path(), "p@q").is_none());
        assert_eq!(enabled_plugins(t.path()).get("fd@dir"), Some(&false));
        let m = marketplaces(t.path());
        assert_eq!(m[0], Marketplace { name: "impeccable".into(), source: "pbakaus/impeccable".into(), install_location: Some("C:/m".into()) });
        assert_eq!(m[1].source, "D:/mk");
        fs::write(plugins.join("installed_plugins.json"), b"nope").unwrap();
        assert!(installed_plugins(t.path()).is_none());
    }

    #[test]
    fn the_installed_filter_lists_plugins_and_items_still_on_disk() {
        let cfg = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::create_dir_all(cfg.path().join("plugins")).unwrap();
        fs::write(cfg.path().join("plugins").join("installed_plugins.json"), r#"{"version":2,"plugins":{"fd@dir":[{"scope":"user","version":"1"}]}}"#).unwrap();
        let there = cfg.path().join("skills").join("kept");
        fs::create_dir_all(&there).unwrap();
        let mut kept = entry("item", "skill:kept");
        kept.item_kind = "skill".into();
        kept.name = "kept".into();
        kept.path = Some(there.to_string_lossy().into_owned());
        let mut gone = entry("item", "skill:gone");
        gone.item_kind = "skill".into();
        gone.path = Some(cfg.path().join("skills").join("gone").to_string_lossy().into_owned());
        add(data.path(), kept).unwrap();
        add(data.path(), gone).unwrap();
        let rows = installed_rows(cfg.path(), &cfg.path().join(".claude.json"), data.path());
        let names: Vec<_> = rows.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, ["fd", "kept"]);
        assert_eq!(rows[0].enabled, Some(true));
    }
}
