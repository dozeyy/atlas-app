//! Installs and removals (D19-D23).
//!
//! Two ways in, both under the cross-process write lock:
//! - **Plugins** go through Claude Code's own command (`library::cli`): the plugin files it keeps
//!   (`settings.json`, `plugins/installed_plugins.json`, `plugins/known_marketplaces.json`) are
//!   backed up first, the result is read back from them, and the files that landed are hashed and
//!   compared with the ones that were checked.
//! - **Loose items** from a pasted repo (skills, agents, commands, output styles, MCP servers) are
//!   copied through `setup_write`: backup, atomic write, History, Undo.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;

use super::catalog::Source;
use super::check::{self, Check};
use super::cli::{CliError, Runner, COMMAND_SOURCE};
use super::ledger::{self, LedgerEntry};
use super::shape::{self, Item, Shaped};
use crate::paths::ConfigRoot;
use crate::setup_write::{self as sw, Confine, CreateCtx, McpAdder};

const LOCK_WAIT: Duration = Duration::from_secs(15);
const BUSY: &str = "Another Atlas change is in progress. Nothing was changed; please try again in a moment.";

/// Where Library writes go and where its records live.
pub struct Ctx<'a> {
    pub root: &'a ConfigRoot,
    /// Atlas's data folder (the ledger and the catalog live under it).
    pub data: &'a Path,
    /// Atlas's `setup-backups` folder.
    pub backups: &'a Path,
}

impl Ctx<'_> {
    fn create_ctx(&self) -> CreateCtx<'_> {
        CreateCtx { root: &self.root.dir, claude_json: &self.root.claude_json }
    }

    fn lock(&self) -> Result<crate::writelock::WriteGuard, String> {
        let dir = self.backups.parent().ok_or(BUSY)?;
        crate::writelock::acquire(dir, LOCK_WAIT).map_err(|_| BUSY.to_string())
    }

    fn plugin_files(&self) -> (PathBuf, PathBuf, PathBuf) {
        let p = self.root.dir.join("plugins");
        (self.root.dir.join("settings.json"), p.join("installed_plugins.json"), p.join("known_marketplaces.json"))
    }
}

/// D7, criterion 19: a plugin whose install runs a command is not offered.
pub fn blocked(source: &Source) -> Option<&'static str> {
    matches!(source, Source::Command).then_some(COMMAND_SOURCE)
}

// ---------------------------------------------------------------------------
// Finding and looking at the files
// ---------------------------------------------------------------------------

/// `staged` joined with `sub` (a folder inside it), proven to stay inside.
pub fn resolve_base(staged: &Path, sub: Option<&str>) -> Result<PathBuf, String> {
    let sub = sub.map(|s| s.trim_matches(['/', '\\'])).filter(|s| !s.is_empty() && *s != ".");
    let Some(sub) = sub else { return Ok(staged.to_path_buf()) };
    let joined = sw::safe_join(staged, sub).map_err(|_| "That folder is not inside the repo.".to_string())?;
    if !joined.is_dir() {
        return Err(format!("The repo has no folder called {sub}."));
    }
    Ok(joined)
}

/// A plugin that lives inside its marketplace's own folder (`./plugin`): found in the clone
/// Claude Code keeps, never outside it.
pub fn local_base(config_dir: &Path, marketplace: &str, rel: &str) -> Result<PathBuf, String> {
    let m = ledger::marketplaces(config_dir).into_iter().find(|m| m.name == marketplace).ok_or("Atlas could not find that marketplace's files.")?;
    let loc = m.install_location.map(PathBuf::from).ok_or("Atlas could not find that marketplace's files.")?;
    let base = fs::canonicalize(&loc).map_err(|_| "That marketplace's files are not on this computer.".to_string())?;
    let rel = rel.trim_start_matches("./").trim_matches(['/', '\\']);
    let target = if rel.is_empty() || rel == "." { base.clone() } else { sw::safe_join(&base, rel).map_err(|_| "That plugin's folder is not inside its marketplace.".to_string())? };
    let target = fs::canonicalize(&target).map_err(|_| "That plugin's folder is missing from its marketplace.".to_string())?;
    if !target.starts_with(&base) || !target.is_dir() {
        return Err("That plugin's folder is not inside its marketplace.".into());
    }
    Ok(target)
}

/// What a folder of files holds and what it could do (what the detail sheet and Add from GitHub show).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspected {
    pub shaped: Shaped,
    pub check: Check,
}

/// A pasted link's folder: marketplace, plugin, loose items or nothing, with the safety check.
pub fn inspect_link(base: &Path, repo_name: &str) -> Inspected {
    let shaped = shape::detect(base, repo_name);
    let check = check::check_tree(base, &shaped.not_installed);
    Inspected { shaped, check }
}

/// A catalog plugin's folder. Claude Code installs all of it, hooks and language servers included,
/// so nothing is "not installed".
pub fn inspect_plugin(base: &Path, name: &str) -> Inspected {
    let mut shaped = shape::detect_plugin(base, name);
    shaped.not_installed.clear();
    let check = check::check_tree(base, &[]);
    Inspected { shaped, check }
}

// ---------------------------------------------------------------------------
// Plugins (through Claude Code's command)
// ---------------------------------------------------------------------------

/// What was checked, to compare with what lands (D19).
pub struct Checked<'a> {
    /// `owner/repo`.
    pub repo: &'a str,
    pub sha: &'a str,
    pub tree_hash: &'a str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOutcome {
    pub id: String,
    pub backup_id: String,
    pub install_path: Option<String>,
    pub version: Option<String>,
    /// The installed files are not the ones that were checked (D19).
    pub changed: bool,
}

fn cli_words(e: CliError) -> String {
    e.message()
}

/// `s` as a sentence that ends with a full stop ("" stays a generic one).
fn sentence(s: &str) -> String {
    let t = s.trim();
    if t.is_empty() {
        "Claude Code's command reported a problem.".into()
    } else if t.ends_with(['.', '!', '?']) {
        t.into()
    } else {
        format!("{t}.")
    }
}

fn bytes_of(p: &Path) -> Option<Vec<u8>> {
    fs::read(p).ok()
}

/// Back up the three plugin files, run `op`, and decide what to do with the backup: a command that
/// changed nothing leaves no backup behind.
fn with_snapshot<T>(ctx: &Ctx, label: &str, kind: &str, name: &str, op: impl FnOnce() -> Result<T, String>) -> (String, Result<T, String>, bool) {
    let (settings, installed, known) = ctx.plugin_files();
    let before = (bytes_of(&settings), bytes_of(&installed), bytes_of(&known));
    let id = match sw::snapshot_files(ctx.backups, label, kind, name, &settings, &[("installed_plugins.json", installed.as_path()), ("known_marketplaces.json", known.as_path())]) {
        Ok(id) => id,
        Err(_) => return (String::new(), Err("Atlas could not make its backup first, so nothing was changed.".into()), false),
    };
    let r = op();
    let after = (bytes_of(&settings), bytes_of(&installed), bytes_of(&known));
    (id, r, before != after)
}

/// Install `id` for the user through Claude Code's command.
pub fn install_plugin(ctx: &Ctx, runner: &Runner, id: &str, source: &Source, checked: &Checked) -> Result<PluginOutcome, String> {
    if let Some(m) = blocked(source) {
        return Err(m.into());
    }
    if !super::cli::valid_plugin_id(id) {
        return Err("That plugin name can't be used.".into());
    }
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let _guard = ctx.lock()?;
    if ledger::user_install(&ctx.root.dir, id).is_some() {
        return Err("That plugin is already installed.".into());
    }
    let name = id.split('@').next().unwrap_or(id).to_string();
    let (backup_id, result, changed_files) = with_snapshot(ctx, &format!("install-plugin-{name}"), "plugin", id, || {
        let out = runner.install(id).map_err(cli_words)?;
        let landed = ledger::user_install(&ctx.root.dir, id);
        if !out.ok {
            let said = sentence(&out.message);
            return Err(if landed.is_none() { format!("{said} Nothing was changed.") } else { format!("{said} Please check the plugin list.") });
        }
        landed.ok_or_else(|| "Claude Code said it installed the plugin, but its plugin list does not show it. Please check the plugin list.".to_string())
    });
    let landed = match result {
        Ok(l) => l,
        Err(e) => {
            if !changed_files {
                sw::drop_backup(ctx.backups, &backup_id);
            }
            return Err(e);
        }
    };
    sw::tag_backup(ctx.backups, &backup_id, "library", &format!("Installed {name} from the Library"));
    let hash = landed.install_path.as_deref().map(Path::new).filter(|p| p.is_dir()).map(check::tree_hash);
    // Nothing was checked (files Atlas can't read): nothing to compare.
    let changed = !checked.tree_hash.is_empty() && hash.as_deref() != Some(checked.tree_hash);
    let entry = LedgerEntry {
        kind: "plugin".into(),
        id: id.into(),
        item_kind: String::new(),
        name,
        path: landed.install_path.clone(),
        repo: checked.repo.into(),
        sha: checked.sha.into(),
        tree_hash: checked.tree_hash.into(),
        installed_hash: hash.or_else(|| Some(String::new())),
        installed_ms: now_ms(),
        backup_id: backup_id.clone(),
    };
    ledger::add(ctx.data, entry).map_err(|_| "The plugin is installed, but Atlas could not note it in its own list.".to_string())?;
    Ok(PluginOutcome { id: id.into(), backup_id, install_path: landed.install_path, version: landed.version, changed })
}

/// Uninstall `id` (keeping the plugin's own data, so a reinstall brings it back).
pub fn uninstall_plugin(ctx: &Ctx, runner: &Runner, id: &str) -> Result<String, String> {
    if !super::cli::valid_plugin_id(id) {
        return Err("That plugin name can't be used.".into());
    }
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let _guard = ctx.lock()?;
    if ledger::user_install(&ctx.root.dir, id).is_none() {
        return Err("That plugin is not installed.".into());
    }
    let name = id.split('@').next().unwrap_or(id).to_string();
    let (backup_id, result, changed_files) = with_snapshot(ctx, &format!("uninstall-plugin-{name}"), "plugin", id, || {
        let out = runner.uninstall(id).map_err(cli_words)?;
        let still = ledger::user_install(&ctx.root.dir, id).is_some();
        if !out.ok || still {
            return Err(if still { format!("{} The plugin is still installed.", sentence(&out.message)) } else { sentence(&out.message) });
        }
        Ok(())
    });
    if let Err(e) = result {
        if !changed_files {
            sw::drop_backup(ctx.backups, &backup_id);
        }
        return Err(e);
    }
    sw::tag_backup(ctx.backups, &backup_id, "library", &format!("Uninstalled {name} from the Library"));
    let _ = ledger::remove(ctx.data, |e| e.kind == "plugin" && e.id == id);
    Ok(backup_id)
}

/// Turn an installed plugin on or off.
pub fn set_plugin_enabled(ctx: &Ctx, runner: &Runner, id: &str, on: bool) -> Result<(), String> {
    if !super::cli::valid_plugin_id(id) {
        return Err("That plugin name can't be used.".into());
    }
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let _guard = ctx.lock()?;
    let name = id.split('@').next().unwrap_or(id).to_string();
    let (backup_id, result, changed_files) = with_snapshot(ctx, &format!("toggle-plugin-{name}"), "plugin", id, || {
        let out = runner.set_enabled(id, on).map_err(cli_words)?;
        if !out.ok {
            return Err(sentence(&out.message));
        }
        if ledger::enabled_plugins(&ctx.root.dir).get(id).copied().unwrap_or(true) != on {
            return Err("Claude Code's settings do not show the change. Please check the plugin list.".into());
        }
        Ok(())
    });
    match result {
        Ok(()) => {
            sw::tag_backup(ctx.backups, &backup_id, "library", &format!("{} {name} (Library)", if on { "Turned on" } else { "Turned off" }));
            Ok(())
        }
        Err(e) => {
            if !changed_files {
                sw::drop_backup(ctx.backups, &backup_id);
            }
            Err(e)
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketOutcome {
    pub name: String,
    pub backup_id: String,
}

/// Add a marketplace (`owner/repo`) through Claude Code's command. A failure says one sentence and
/// leaves nothing behind.
pub fn add_marketplace(ctx: &Ctx, runner: &Runner, source: &str) -> Result<MarketOutcome, String> {
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let _guard = ctx.lock()?;
    let (backup_id, result, changed_files) = with_snapshot(ctx, "add-marketplace", "marketplace", source, || {
        let out = runner.marketplace_add(source).map_err(cli_words)?;
        if !out.ok {
            return Err(sentence(&out.message));
        }
        Ok(out.subject.unwrap_or_default())
    });
    match result {
        Ok(name) => {
            sw::tag_backup(ctx.backups, &backup_id, "library", &format!("Added the marketplace {source}"));
            Ok(MarketOutcome { name, backup_id })
        }
        Err(e) => {
            if !changed_files {
                sw::drop_backup(ctx.backups, &backup_id);
                return Err(format!("{e} Nothing was changed."));
            }
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Loose items (through the setup write path)
// ---------------------------------------------------------------------------

/// Where a pick would be written, when it is a file or folder.
pub fn dest(ctx: &Ctx, kind: &str, name: &str) -> Option<PathBuf> {
    let r = &ctx.root.dir;
    match kind {
        "skill" => Some(r.join("skills").join(name)),
        "agent" => Some(r.join("agents").join(format!("{name}.md"))),
        "command" => Some(r.join("commands").join(format!("{name}.md"))),
        "outputStyle" => Some(r.join("output-styles").join(format!("{name}.md"))),
        _ => None,
    }
}

/// "You already have one called <name>" when the name is taken (nothing is ever replaced).
pub fn conflict(ctx: &Ctx, item: &Item) -> Option<String> {
    let taken = match dest(ctx, &item.kind, &item.name) {
        Some(p) => fs::symlink_metadata(p).is_ok(),
        None => fs::read(&ctx.root.claude_json).ok().and_then(|b| serde_json::from_slice::<serde_json::Value>(b.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&b)).ok()).is_some_and(|v| v.get("mcpServers").and_then(|m| m.get(&item.name)).is_some()),
    };
    taken.then(|| format!("You already have one called {}", item.name))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemResult {
    pub kind: String,
    pub name: String,
    pub ok: bool,
    pub backup_id: String,
    pub path: Option<String>,
    /// One sentence when it did not install.
    pub message: String,
}

/// What an install of loose items came from.
pub struct Origin<'a> {
    pub repo: &'a str,
    pub sha: &'a str,
    /// The hash of the whole checked folder.
    pub tree_hash: &'a str,
}

/// Install the picked items from `base`. Each one is its own backup, so each is its own Undo. An
/// item that fails does not stop the others and leaves nothing behind.
pub fn install_items(ctx: &Ctx, base: &Path, picks: &[Item], origin: &Origin, adder: Option<McpAdder>) -> Result<Vec<ItemResult>, String> {
    let _guard = ctx.lock()?;
    let cctx = ctx.create_ctx();
    let mut out = Vec::new();
    for item in picks {
        let res = install_one(ctx, &cctx, base, item, adder);
        let r = match res {
            Ok(o) => {
                let path = dest(ctx, &item.kind, &item.name).map(|p| p.to_string_lossy().into_owned());
                sw::tag_backup(ctx.backups, &o.backup_id, "library", &format!("Installed {} {} from {}", item.kind, item.name, origin.repo));
                let e = LedgerEntry {
                    kind: "item".into(),
                    id: format!("{}:{}", item.kind, item.name),
                    item_kind: item.kind.clone(),
                    name: item.name.clone(),
                    path: path.clone(),
                    repo: origin.repo.into(),
                    sha: origin.sha.into(),
                    tree_hash: origin.tree_hash.into(),
                    installed_hash: None,
                    installed_ms: now_ms(),
                    backup_id: o.backup_id.clone(),
                };
                let note = ledger::add(ctx.data, e).err().map(|_| "Installed, but Atlas could not note it in its own list.".to_string()).unwrap_or_default();
                ItemResult { kind: item.kind.clone(), name: item.name.clone(), ok: true, backup_id: o.backup_id, path, message: note }
            }
            Err(m) => ItemResult { kind: item.kind.clone(), name: item.name.clone(), ok: false, backup_id: String::new(), path: None, message: m },
        };
        out.push(r);
    }
    Ok(out)
}

fn install_one(ctx: &Ctx, cctx: &CreateCtx, base: &Path, item: &Item, adder: Option<McpAdder>) -> Result<sw::DeleteOutcome, String> {
    if let Some(c) = conflict(ctx, item) {
        return Err(c);
    }
    let words = |e: sw::WriteError| e.message();
    match item.kind.as_str() {
        "skill" => {
            let dir = if item.rel.is_empty() { base.to_path_buf() } else { sw::safe_join(base, &item.rel).map_err(words)? };
            sw::install_skill_folder(&dir, &item.name, cctx, ctx.backups).map_err(words)
        }
        "agent" | "command" | "outputStyle" => {
            let file = sw::safe_join(base, &item.rel).map_err(words)?;
            let bytes = fs::read(&file).map_err(|_| "Atlas could not read that file.".to_string())?;
            sw::create_apply_bytes(&item.kind, &item.name, &bytes, cctx, ctx.backups).map_err(words)
        }
        "mcpServer" => {
            let file = sw::safe_join(base, &item.rel).map_err(words)?;
            let bytes = fs::read(&file).map_err(|_| "Atlas could not read that file.".to_string())?;
            let v: serde_json::Value = serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).map_err(|_| "That server's file is not valid JSON.".to_string())?;
            let key = item.key.as_deref().unwrap_or(&item.name);
            let servers = v.get("mcpServers").and_then(|m| m.as_object()).or_else(|| v.as_object());
            let entry = servers.and_then(|m| m.get(key)).ok_or("That server is not in the file.")?;
            let text = serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?;
            sw::create_apply_with("mcpServer", &item.name, None, &text, cctx, ctx.backups, adder).map_err(words)
        }
        _ => Err("Atlas cannot install that kind of item.".into()),
    }
}

/// Undo a Library install of loose items (the Remove X, or History's Undo): a folder is removed
/// only while it is exactly what was installed; what is removed is itself backed up first, so this
/// can be undone too.
pub fn undo_install(ctx: &Ctx, backup_id: &str, confine: &Confine, to_trash: bool) -> Result<sw::UndoOutcome, String> {
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let _guard = ctx.lock()?;
    let out = sw::restore_any_with(ctx.backups, backup_id, confine, to_trash).map_err(|e| e.message())?;
    let _ = ledger::remove(ctx.data, |e| e.backup_id == backup_id);
    Ok(out)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::super::cli::tests::{Fake, ok, root};
    use super::super::cli::{RawOutput, Request};
    use super::*;
    use crate::paths::ConfigSource;
    use std::collections::BTreeMap;
    use std::sync::Arc;

    struct Env {
        _t: tempfile::TempDir,
        dir: PathBuf,
        data: PathBuf,
        backups: PathBuf,
        root: ConfigRoot,
    }

    fn env() -> Env {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("claude");
        let data = t.path().join("data");
        let backups = data.join("setup-backups");
        fs::create_dir_all(&dir).unwrap();
        fs::create_dir_all(&backups).unwrap();
        let r = root(&dir, ConfigSource::Flag);
        Env { _t: t, dir, data, backups, root: r }
    }

    impl Env {
        fn ctx(&self) -> Ctx<'_> {
            Ctx { root: &self.root, data: &self.data, backups: &self.backups }
        }
    }

    fn put(root: &Path, rel: &str, bytes: &[u8]) {
        let p = root.join(rel);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, bytes).unwrap();
    }

    /// (path, size, mtime) of the things Library writes could touch in the real Claude folder.
    /// `.claude.json` is left out: Claude Code rewrites it all the time, and the debug guard that
    /// refuses to write it is tested on its own.
    fn real_snapshot() -> BTreeMap<String, (u64, u128)> {
        let mut out = BTreeMap::new();
        let Some(home) = crate::paths::home_dir() else { return out };
        let real = home.join(".claude");
        fn walk(p: &Path, out: &mut BTreeMap<String, (u64, u128)>, depth: usize) {
            let Ok(md) = fs::symlink_metadata(p) else { return };
            let m = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
            out.insert(p.to_string_lossy().into_owned(), (md.len(), m));
            if md.is_dir() && depth < 6
                && let Ok(rd) = fs::read_dir(p)
            {
                for e in rd.flatten() {
                    walk(&e.path(), out, depth + 1);
                }
            }
        }
        for d in ["skills", "agents", "commands", "output-styles"] {
            walk(&real.join(d), &mut out, 0);
        }
        for f in ["settings.json", "plugins/installed_plugins.json", "plugins/known_marketplaces.json"] {
            walk(&real.join(f), &mut out, 0);
        }
        out
    }

    /// A fake `claude plugin ...` that behaves like the real one: install writes the three files and a tree.
    fn fake_claude(dir: PathBuf, tree: &'static [(&'static str, &'static str)]) -> Arc<Fake> {
        Fake::new(move |req: &Request| {
            let a: Vec<&str> = req.args.iter().map(String::as_str).collect();
            assert_eq!(req.config_dir.as_deref(), Some(dir.as_path()), "the folder is passed on");
            let plugins = dir.join("plugins");
            let installed = plugins.join("installed_plugins.json");
            match a.as_slice() {
                ["plugin", "install", id, ..] => {
                    let name = id.split('@').next().unwrap();
                    let path = plugins.join("cache").join("mk").join(name).join("1.0.0");
                    for (rel, text) in tree {
                        put(&path, rel, text.as_bytes());
                    }
                    put(&path, ".in_use", b"pid");
                    fs::write(&installed, format!(r#"{{"version":2,"plugins":{{"{id}":[{{"scope":"user","installPath":{},"version":"1.0.0","gitCommitSha":"abc"}}]}}}}"#, serde_json::to_string(&path.to_string_lossy()).unwrap())).unwrap();
                    fs::write(dir.join("settings.json"), format!(r#"{{"enabledPlugins":{{"{id}":true}}}}"#)).unwrap();
                    ok(&format!(r#"{{"command":"install","outcome":"ok","pluginId":"{id}","message":"Installed."}}"#))
                }
                ["plugin", "uninstall", ..] => {
                    fs::write(&installed, r#"{"version":2,"plugins":{}}"#).unwrap();
                    ok(r#"{"command":"uninstall","outcome":"ok","message":"Uninstalled."}"#)
                }
                ["plugin", "marketplace", "add", ..] => Ok(RawOutput { code: 1, stdout: r#"{"outcome":"failed","failureCode":"manifest_missing","message":"No marketplace.json found in that folder."}"#.into(), stderr: String::new() }),
                _ => ok("[]"),
            }
        })
    }

    const TREE: &[(&str, &str)] = &[(".claude-plugin/plugin.json", r#"{"name":"fd"}"#), ("skills/fd/SKILL.md", "---\nname: fd\n---\nbody\n")];

    fn tree_hash_of(entries: &[(&str, &str)]) -> String {
        let t = tempfile::tempdir().unwrap();
        for (rel, text) in entries {
            put(t.path(), rel, text.as_bytes());
        }
        check::tree_hash(t.path())
    }

    #[test]
    fn a_plugin_install_is_backed_up_read_back_and_noted() {
        let before = real_snapshot();
        let e = env();
        put(&e.dir, "settings.json", br#"{"model":"x"}"#);
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake.clone());
        let good = tree_hash_of(TREE);
        let o = install_plugin(&e.ctx(), &runner, "fd@mk", &Source::Github { repo: "o/r".into(), sha: Some("abc".into()), path: None }, &Checked { repo: "o/r", sha: "abc", tree_hash: &good }).unwrap();
        assert!(!o.changed);
        assert_eq!(fake.log(), ["plugin install fd@mk --scope user --json"]);
        // The backup holds the three files as they were.
        let b = &e.backups.join(&o.backup_id);
        assert_eq!(fs::read(b.join("file-before")).unwrap(), br#"{"model":"x"}"#);
        let info = sw::list_backups_detailed(&e.backups, 5);
        assert_eq!((info[0].action.as_str(), info[0].source.as_str()), ("library", "library"));
        // The ledger has it, and the filter lists it.
        assert_eq!(ledger::find(&e.data, "plugin", "fd@mk").unwrap().repo, "o/r");
        let rows = ledger::installed_rows(&e.dir, &e.root.claude_json, &e.data);
        assert_eq!(rows.len(), 1);
        assert!(!rows[0].changed);
        // Installing it again is refused, and uninstalling brings the list back to empty.
        assert!(install_plugin(&e.ctx(), &runner, "fd@mk", &Source::Local { path: "./x".into() }, &Checked { repo: "o/r", sha: "abc", tree_hash: &good }).is_err());
        uninstall_plugin(&e.ctx(), &runner, "fd@mk").unwrap();
        assert!(ledger::user_install(&e.dir, "fd@mk").is_none());
        assert!(ledger::read(&e.data).entries.is_empty());
        assert_eq!(fake.log()[1], "plugin uninstall fd@mk --scope user --keep-data --json");
        assert_eq!(real_snapshot(), before, "the real Claude folder was not touched");
    }

    #[test]
    fn a_tree_that_differs_from_the_checked_one_is_marked_changed() {
        let e = env();
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake);
        let o = install_plugin(&e.ctx(), &runner, "fd@mk", &Source::Local { path: "./x".into() }, &Checked { repo: "o/r", sha: "abc", tree_hash: "not-the-same-hash" }).unwrap();
        assert!(o.changed);
        let rows = ledger::installed_rows(&e.dir, &e.root.claude_json, &e.data);
        assert!(rows[0].changed, "the row says Changed since you checked it");
    }

    #[test]
    fn a_command_source_is_refused_before_anything_runs() {
        let e = env();
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake.clone());
        let err = install_plugin(&e.ctx(), &runner, "x@mk", &Source::Command, &Checked { repo: "", sha: "", tree_hash: "" }).unwrap_err();
        assert_eq!(err, "This plugin installs by running a command. Atlas does not run those.");
        assert_eq!(runner.spawns(), 0);
        assert!(fs::read_dir(&e.backups).unwrap().next().is_none());
    }

    #[test]
    fn a_marketplace_without_a_manifest_says_one_sentence_and_changes_nothing() {
        let e = env();
        put(&e.dir, "settings.json", b"{}");
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake.clone());
        let err = add_marketplace(&e.ctx(), &runner, "o/r").unwrap_err();
        assert_eq!(err, "No marketplace.json found in that folder. Nothing was changed.");
        assert_eq!(fake.log(), ["plugin marketplace add o/r --json"]);
        assert!(fs::read_dir(&e.backups).unwrap().next().is_none(), "no backup is left for a change that did not happen");
        assert_eq!(fs::read(e.dir.join("settings.json")).unwrap(), b"{}");
    }

    fn loose_repo() -> tempfile::TempDir {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), "skills/alpha/SKILL.md", b"---\nname: alpha\ndescription: A\n---\r\nbody\r\n");
        put(t.path(), "skills/alpha/scripts/run.py", b"#!/usr/bin/env python3\nprint('hi')\n");
        put(t.path(), "skills/beta/SKILL.md", b"---\nname: beta\ndescription: B\n---\nbody\n");
        put(t.path(), "skills/beta/data.bin", &[0u8, 159, 146, 150, 255]);
        put(t.path(), "agents/Rev One.md", b"---\nname: rev-one\ndescription: R\n---\nbody \xc3\xa9\n");
        t
    }

    fn picks(base: &Path) -> Vec<Item> {
        shape::detect(base, "repo").items
    }

    fn hash(p: &Path) -> String {
        check::tree_hash(p)
    }

    #[test]
    fn a_copy_install_is_byte_identical_and_a_taken_name_is_left_alone() {
        let before = real_snapshot();
        let e = env();
        let repo = loose_repo();
        // A skill called beta already exists and must stay as it is.
        put(&e.dir, "skills/beta/SKILL.md", b"mine");
        let items = picks(repo.path());
        assert_eq!(items.len(), 3);
        let taken: Vec<_> = items.iter().filter_map(|i| conflict(&e.ctx(), i).map(|m| (i.name.clone(), m))).collect();
        assert_eq!(taken, [("beta".to_string(), "You already have one called beta".to_string())]);
        let res = install_items(&e.ctx(), repo.path(), &items, &Origin { repo: "o/r", sha: "abc", tree_hash: "h" }, None).unwrap();
        let by_name = |n: &str| res.iter().find(|r| r.name == n).unwrap();
        assert!(by_name("alpha").ok && by_name("rev-one").ok);
        assert!(!by_name("beta").ok);
        assert_eq!(by_name("beta").message, "You already have one called beta");
        assert_eq!(fs::read(e.dir.join("skills/beta/SKILL.md")).unwrap(), b"mine");
        assert_eq!(hash(&e.dir.join("skills/alpha")), hash(&repo.path().join("skills/alpha")));
        assert_eq!(fs::read(e.dir.join("agents/rev-one.md")).unwrap(), fs::read(repo.path().join("agents/Rev One.md")).unwrap());
        assert_eq!(fs::read(e.dir.join("skills/alpha/SKILL.md")).unwrap(), b"---\nname: alpha\ndescription: A\n---\r\nbody\r\n", "line endings are kept");
        assert_eq!(ledger::read(&e.data).entries.len(), 2);
        let info = sw::list_backups_detailed(&e.backups, 10);
        assert!(info.iter().all(|b| b.source == "library"));
        assert_eq!(real_snapshot(), before);
    }

    #[test]
    fn undo_removes_the_folder_into_a_backup_and_undoing_that_restores_it_byte_for_byte() {
        let e = env();
        let repo = loose_repo();
        let items: Vec<Item> = picks(repo.path()).into_iter().filter(|i| i.name == "alpha").collect();
        let res = install_items(&e.ctx(), repo.path(), &items, &Origin { repo: "o/r", sha: "abc", tree_hash: "h" }, None).unwrap();
        let installed = e.dir.join("skills/alpha");
        let h = hash(&installed);
        let confine = Confine::new(&e.dir, &e.root.claude_json, []);
        let undo = undo_install(&e.ctx(), &res[0].backup_id, &confine, false).unwrap();
        assert!(!installed.exists());
        assert!(ledger::read(&e.data).entries.is_empty());
        // The removal is a backup of its own; undoing it puts the folder back exactly.
        let again = sw::restore_any(&e.backups, undo.backup_id.as_deref().unwrap(), &confine).unwrap();
        assert!(again.name == "alpha");
        assert_eq!(hash(&installed), h);
        assert_eq!(fs::read(installed.join("scripts/run.py")).unwrap(), b"#!/usr/bin/env python3\nprint('hi')\n");
    }

    #[test]
    fn a_changed_folder_is_not_removed_by_undo() {
        let e = env();
        let repo = loose_repo();
        let items: Vec<Item> = picks(repo.path()).into_iter().filter(|i| i.name == "alpha").collect();
        let res = install_items(&e.ctx(), repo.path(), &items, &Origin { repo: "o/r", sha: "abc", tree_hash: "h" }, None).unwrap();
        put(&e.dir, "skills/alpha/notes.txt", b"my edit");
        let confine = Confine::new(&e.dir, &e.root.claude_json, []);
        let err = undo_install(&e.ctx(), &res[0].backup_id, &confine, false).unwrap_err();
        assert!(err.contains("changed since"), "{err}");
        assert!(e.dir.join("skills/alpha/notes.txt").exists());
    }

    #[test]
    fn a_plugin_json_only_repo_installs_its_skills_and_leaves_settings_hooks_alone() {
        let e = env();
        let settings = br#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}"#;
        put(&e.dir, "settings.json", settings);
        let repo = tempfile::tempdir().unwrap();
        put(repo.path(), ".claude-plugin/plugin.json", br#"{"name":"hooky","hooks":{"Stop":[{"hooks":[{"type":"command","command":"python3 evil.py"}]}]}}"#);
        put(repo.path(), "hooks/hooks.json", b"{}");
        put(repo.path(), "skills/pdf/SKILL.md", b"---\nname: pdf\ndescription: p\n---\nbody\n");
        let ins = inspect_link(repo.path(), "hooky");
        assert_eq!(ins.shaped.shape, "plugin");
        assert!(ins.check.flags.iter().any(|f| f.code == "not_installed"));
        let res = install_items(&e.ctx(), repo.path(), &ins.shaped.items, &Origin { repo: "o/hooky", sha: "abc", tree_hash: &ins.check.tree_hash }, None).unwrap();
        assert!(res.iter().all(|r| r.ok), "{res:?}");
        assert!(e.dir.join("skills/pdf/SKILL.md").exists());
        assert_eq!(fs::read(e.dir.join("settings.json")).unwrap(), settings, "settings.json is byte-identical");
    }

    #[test]
    fn an_mcp_server_from_a_repo_uses_the_guarded_edit_when_there_is_no_command() {
        let e = env();
        let repo = tempfile::tempdir().unwrap();
        put(repo.path(), ".mcp.json", br#"{"mcpServers":{"docs":{"type":"http","url":"https://mcp.example.com/mcp"}}}"#);
        put(&e.dir, ".claude.json", br#"{"numStartups":3,"mcpServers":{"keep":{"command":"x"}}}"#);
        let items = picks(repo.path());
        assert_eq!(items.len(), 1);
        let res = install_items(&e.ctx(), repo.path(), &items, &Origin { repo: "o/r", sha: "abc", tree_hash: "h" }, None).unwrap();
        assert!(res[0].ok, "{res:?}");
        let v: serde_json::Value = serde_json::from_slice(&fs::read(&e.root.claude_json).unwrap()).unwrap();
        assert_eq!(v["numStartups"], 3);
        assert_eq!(v["mcpServers"]["keep"]["command"], "x");
        assert_eq!(v["mcpServers"]["docs"]["url"], "https://mcp.example.com/mcp");
        // A second time: the name is taken.
        assert_eq!(conflict(&e.ctx(), &items[0]).as_deref(), Some("You already have one called docs"));
    }

    #[test]
    fn no_command_on_this_computer_still_lets_loose_items_install() {
        // `find_claude_cli` returning None: plugin installs report it, loose installs do not need it.
        assert!(matches!(Runner::new(&crate::connect::CliChoice::Missing, &root(Path::new("x"), ConfigSource::Flag)), Err(CliError::NoCli)));
        let e = env();
        let repo = loose_repo();
        let items = picks(repo.path());
        let res = install_items(&e.ctx(), repo.path(), &items, &Origin { repo: "o/r", sha: "abc", tree_hash: "h" }, None).unwrap();
        assert!(res.iter().all(|r| r.ok));
    }

    #[test]
    fn bases_stay_inside_their_folders() {
        let t = tempfile::tempdir().unwrap();
        put(t.path(), "plugin/a.txt", b"x");
        assert!(resolve_base(t.path(), Some("plugin")).is_ok());
        assert_eq!(resolve_base(t.path(), None).unwrap(), t.path());
        assert!(resolve_base(t.path(), Some("../x")).is_err());
        assert!(resolve_base(t.path(), Some("nope")).is_err());
        let cfg = tempfile::tempdir().unwrap();
        let mk = t.path().to_path_buf();
        fs::create_dir_all(cfg.path().join("plugins")).unwrap();
        fs::write(cfg.path().join("plugins/known_marketplaces.json"), format!(r#"{{"mk":{{"source":{{"source":"directory","path":"x"}},"installLocation":{}}}}}"#, serde_json::to_string(&mk.to_string_lossy()).unwrap())).unwrap();
        assert!(local_base(cfg.path(), "mk", "./plugin").unwrap().ends_with("plugin"));
        assert!(local_base(cfg.path(), "mk", "../outside").is_err());
        assert!(local_base(cfg.path(), "other", "./plugin").is_err());
    }
}
