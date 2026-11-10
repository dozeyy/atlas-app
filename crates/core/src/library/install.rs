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
    inspect_plugin_entry(base, name, check::EntryFields::Absent)
}

/// A catalog plugin: its files, and what the marketplace's own entry for it names.
pub fn inspect_plugin_entry(base: &Path, name: &str, entry: check::EntryFields<'_>) -> Inspected {
    let mut shaped = shape::detect_plugin(base, name);
    shaped.not_installed.clear();
    let check = check::check_tree_entry(base, &[], entry);
    Inspected { shaped, check }
}

/// A plugin Atlas can't read (another git host, an unusable branch name): nothing inside, one
/// plain flag, so the install is the deliberate two-click path and nothing is compared after it
/// (spec D20).
pub fn inspect_unchecked(name: &str) -> Inspected {
    let shaped = Shaped { shape: "plugin".into(), name: name.to_string(), description: String::new(), plugins: Vec::new(), items: Vec::new(), not_installed: Vec::new() };
    Inspected { shaped, check: check::unchecked() }
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

/// The same commit (a short hash is a prefix of the long one). Both must be known.
pub fn same_commit(a: &str, b: &str) -> bool {
    let (a, b) = (a.trim().to_ascii_lowercase(), b.trim().to_ascii_lowercase());
    !a.is_empty() && (a == b || (a.len() >= 7 && b.len() >= 7 && (a.starts_with(&b) || b.starts_with(&a))))
}

/// Said when the catalog (or the marketplace's entry) changed between the check and the click.
pub const LISTING_MOVED: &str = "This plugin was updated in the catalog since you checked it. Check it again first.";

/// What was checked has to be what the catalog lists now (review finding 3): a refresh between the
/// look and the click can point the plugin at another commit, branch or place, and Claude Code
/// would install that unchecked one. Differing listings are refused, never installed.
pub fn same_listing(checked: &Source, now: Option<&Source>) -> Result<(), String> {
    match now {
        Some(n) if n == checked => Ok(()),
        Some(_) => Err(LISTING_MOVED.into()),
        None => Err("That plugin is not in the catalog. Press Refresh.".into()),
    }
}

/// What Atlas downloads to look at, so that it is what Claude Code installs (review finding 2):
/// the pinned commit, else the named branch or tag (never HEAD when a ref is listed: a repo's
/// default branch can hold something else), else HEAD.
pub fn fetch_target(source: &Source) -> Option<&str> {
    match source {
        Source::Github { sha, git_ref, .. } => Some(sha.as_deref().or(git_ref.as_deref()).unwrap_or("HEAD")),
        _ => None,
    }
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
    install_plugin_locked(ctx, runner, id, source, checked)
}

/// `install_plugin` for a caller that already holds the write lock (it is not re-entrant).
pub fn install_plugin_locked(ctx: &Ctx, runner: &Runner, id: &str, source: &Source, checked: &Checked) -> Result<PluginOutcome, String> {
    if let Some(m) = blocked(source) {
        return Err(m.into());
    }
    if !super::cli::valid_plugin_id(id) {
        return Err("That plugin name can't be used.".into());
    }
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
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
    let landed_sha = landed.git_sha.clone().unwrap_or_default();
    let installed_sha = if landed_sha.is_empty() { checked.sha.to_string() } else { landed_sha.clone() };
    sw::tag_library_op(
        ctx.backups,
        &backup_id,
        &format!("Installed {name} from the Library"),
        sw::LibOp { op: "install".into(), id: id.into(), repo: checked.repo.into(), sha: installed_sha, tree_hash: checked.tree_hash.into(), undone: false },
    );
    let hash = landed.install_path.as_deref().map(Path::new).filter(|p| p.is_dir()).map(check::tree_hash);
    // Nothing was checked (files Atlas can't read): nothing to compare.
    let files_differ = !checked.tree_hash.is_empty() && hash.as_deref() != Some(checked.tree_hash);
    // The commit that landed is not the one that was checked (a branch moved in between).
    let commit_differs = !checked.sha.is_empty() && !landed_sha.is_empty() && !same_commit(&landed_sha, checked.sha);
    let changed = files_differ || commit_differs;
    if commit_differs {
        // Claude Code installed a commit nobody looked at (a branch moved after the check): take
        // it out again rather than leave it running. Both steps stay in History.
        return Err(take_out_again(ctx, runner, id, "Claude Code installed a newer version than the one Atlas checked", "Check it again and try once more."));
    }
    if files_differ && checked.sha.is_empty() {
        // No commit to pin it to (a plugin inside a marketplace folder): different files than the
        // ones Atlas looked at have nothing else vouching for them, so they do not stay.
        return Err(take_out_again(ctx, runner, id, "The files Claude Code installed are not the ones Atlas checked", "Check it again and try once more."));
    }
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

/// Take a plugin that just landed out again (what landed is not what was checked). The sentence
/// is only "took it out again" when the uninstall really worked; when it did not, it says the
/// plugin is still installed and where to remove it.
fn take_out_again(ctx: &Ctx, runner: &Runner, id: &str, why: &str, next: &str) -> String {
    let gone = uninstall_plugin_locked(ctx, runner, id).is_ok() && ledger::user_install(&ctx.root.dir, id).is_none();
    if gone {
        format!("{why}, so Atlas took it out again. {next}")
    } else {
        format!("{why}, and Atlas could not take it out again, so it is still installed. Open Toolkit, find it under Installed in the Library and press Uninstall.")
    }
}

/// Uninstall `id` (keeping the plugin's own data, so a reinstall brings it back).
pub fn uninstall_plugin(ctx: &Ctx, runner: &Runner, id: &str) -> Result<String, String> {
    if !super::cli::valid_plugin_id(id) {
        return Err("That plugin name can't be used.".into());
    }
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let _guard = ctx.lock()?;
    uninstall_plugin_locked(ctx, runner, id)
}

/// `uninstall_plugin` for a caller that already holds the write lock.
pub fn uninstall_plugin_locked(ctx: &Ctx, runner: &Runner, id: &str) -> Result<String, String> {
    if !super::cli::valid_plugin_id(id) {
        return Err("That plugin name can't be used.".into());
    }
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let Some(rec) = ledger::user_install(&ctx.root.dir, id) else {
        return Err("That plugin is not installed.".into());
    };
    // What Undo needs to bring it back as it was, read before it goes.
    let prior = ledger::find(ctx.data, "plugin", id);
    let op = sw::LibOp {
        op: "uninstall".into(),
        id: id.into(),
        repo: prior.as_ref().map(|p| p.repo.clone()).unwrap_or_default(),
        sha: rec.git_sha.clone().or_else(|| prior.as_ref().map(|p| p.sha.clone()).filter(|s| !s.is_empty())).unwrap_or_default(),
        tree_hash: prior.as_ref().map(|p| p.tree_hash.clone()).unwrap_or_default(),
        undone: false,
    };
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
    sw::tag_library_op(ctx.backups, &backup_id, &format!("Uninstalled {name} from the Library"), op);
    let _ = ledger::remove(ctx.data, |e| e.kind == "plugin" && e.id == id);
    Ok(backup_id)
}

/// What an Undo of a Library plugin change did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoDone {
    pub id: String,
    pub name: String,
    /// What was done now: `uninstall` (undoing an install) or `install` (undoing an uninstall).
    pub did: String,
    /// The backup of this undo (it can itself be undone).
    pub backup_id: String,
}

/// Undo a Library plugin install or removal (D21), through the same write path: undoing an install
/// uninstalls the plugin (only while it is still the commit that was installed); undoing an
/// uninstall installs it again at the commit it had, and takes it out again if what lands is any
/// other commit. `source_now` is the catalog's listing of the plugin, when it has one.
pub fn undo_plugin_backup(ctx: &Ctx, runner: &Runner, backup_id: &str, source_now: Option<&Source>) -> Result<UndoDone, String> {
    crate::fsutil::check_write_allowed(&ctx.root.dir).map_err(|e| e.to_string())?;
    let _guard = ctx.lock()?;
    undo_plugin_backup_locked(ctx, runner, backup_id, source_now)
}

/// `undo_plugin_backup` for a caller that already holds the write lock.
pub fn undo_plugin_backup_locked(ctx: &Ctx, runner: &Runner, backup_id: &str, source_now: Option<&Source>) -> Result<UndoDone, String> {
    let op = sw::library_op(ctx.backups, backup_id).ok_or("That change can't be undone from here.")?;
    if op.undone {
        return Err("That change was already undone.".into());
    }
    let name = op.id.split('@').next().unwrap_or(&op.id).to_string();
    let done = match op.op.as_str() {
        "install" => {
            let Some(rec) = ledger::user_install(&ctx.root.dir, &op.id) else {
                return Err("That plugin is already gone.".into());
            };
            // Only the commit that was installed is taken out: an update since is left alone.
            if let Some(now) = rec.git_sha.as_deref().filter(|s| !s.is_empty())
                && !op.sha.is_empty()
                && !same_commit(now, &op.sha)
            {
                return Err("That plugin has been updated since you installed it, so Atlas left it alone.".into());
            }
            let bid = uninstall_plugin_locked(ctx, runner, &op.id)?;
            sw::tag_library_op(
                ctx.backups,
                &bid,
                &format!("Uninstalled {name} (undo of an install)"),
                sw::LibOp { op: "uninstall".into(), id: op.id.clone(), repo: op.repo.clone(), sha: op.sha.clone(), tree_hash: op.tree_hash.clone(), undone: false },
            );
            UndoDone { id: op.id.clone(), name, did: "uninstall".into(), backup_id: bid }
        }
        "uninstall" => {
            if ledger::user_install(&ctx.root.dir, &op.id).is_some() {
                return Err("That plugin is already installed.".into());
            }
            let source = source_now.cloned().unwrap_or(Source::Other { url: String::new() });
            // A pinned listing that moved on can't give the old commit back.
            if let Source::Github { sha: Some(s), .. } = &source
                && !op.sha.is_empty()
                && !same_commit(s, &op.sha)
            {
                return Err("This plugin has been updated since you removed it, so Atlas can't bring back that exact version. Find it in the Library to check the new one.".into());
            }
            let out = install_plugin_locked(ctx, runner, &op.id, &source, &Checked { repo: &op.repo, sha: &op.sha, tree_hash: &op.tree_hash })?;
            if out.changed {
                // Not what was removed: take it out again rather than keep an unchecked commit.
                return Err(take_out_again(ctx, runner, &op.id, "What Claude Code installed is not the version you removed", "Find it in the Library to check the current one."));
            }
            sw::tag_library_op(
                ctx.backups,
                &out.backup_id,
                &format!("Installed {name} (undo of a removal)"),
                sw::LibOp { op: "install".into(), id: op.id.clone(), repo: op.repo.clone(), sha: op.sha.clone(), tree_hash: op.tree_hash.clone(), undone: false },
            );
            UndoDone { id: op.id.clone(), name, did: "install".into(), backup_id: out.backup_id }
        }
        _ => return Err("That change can't be undone from here.".into()),
    };
    sw::mark_library_undone(ctx.backups, backup_id);
    Ok(done)
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
        fake_claude_with(dir, tree, true)
    }

    /// The same, where `uninstall` can be made to fail (it leaves the plugin installed).
    fn fake_claude_with(dir: PathBuf, tree: &'static [(&'static str, &'static str)], uninstall_works: bool) -> Arc<Fake> {
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
                ["plugin", "uninstall", ..] if !uninstall_works => Ok(RawOutput { code: 1, stdout: r#"{"outcome":"failed","message":"It is locked."}"#.into(), stderr: String::new() }),
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
        let o = install_plugin(&e.ctx(), &runner, "fd@mk", &Source::Github { repo: "o/r".into(), sha: Some("abc".into()), path: None, git_ref: None }, &Checked { repo: "o/r", sha: "abc", tree_hash: &good }).unwrap();
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
    fn an_autocrlf_copy_is_the_same_plugin_and_an_undone_removal_stays_installed() {
        // Verifier V1/V2: a git clone with core.autocrlf wrote CRLF into every text file (a script
        // too); the checked archive had LF. That is not a change, so nothing is taken out, and
        // uninstall then Undo leaves the plugin installed.
        const LF: &[(&str, &str)] = &[(".claude-plugin/plugin.json", "{\n\"name\":\"fd\"\n}\n"), ("skills/fd/SKILL.md", "---\nname: fd\n---\nbody\n"), ("hooks/check.py", "import sys\nprint(1)\n")];
        const CRLF: &[(&str, &str)] = &[(".claude-plugin/plugin.json", "{\r\n\"name\":\"fd\"\r\n}\r\n"), ("skills/fd/SKILL.md", "---\r\nname: fd\r\n---\r\nbody\r\n"), ("hooks/check.py", "import sys\r\nprint(1)\r\n")];
        let e = env();
        let fake = fake_claude(e.dir.clone(), CRLF);
        let runner = Runner::with_exec("claude".into(), &e.root, fake);
        let good = tree_hash_of(LF);
        // No commit to pin it to: before the fix a mismatch here took the plugin out again.
        let src = Source::Local { path: "./x".into() };
        let o = install_plugin(&e.ctx(), &runner, "fd@mk", &src, &Checked { repo: "", sha: "", tree_hash: &good }).unwrap();
        assert!(!o.changed, "line endings alone are not a change");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_some());
        let rows = ledger::installed_rows(&e.dir, &e.root.claude_json, &e.data);
        assert!(!rows[0].changed);
        let removed = uninstall_plugin(&e.ctx(), &runner, "fd@mk").unwrap();
        assert!(ledger::user_install(&e.dir, "fd@mk").is_none());
        let undone = undo_plugin_backup(&e.ctx(), &runner, &removed, Some(&src)).unwrap();
        assert_eq!(undone.did, "install");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_some(), "Undo leaves it installed");
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

    fn gh(sha: &str) -> Source {
        Source::Github { repo: "o/r".into(), sha: Some(sha.into()), path: None, git_ref: None }
    }

    #[test]
    fn a_listing_that_moved_since_the_check_is_refused() {
        // Review finding 3: the sha (or ref) the catalog lists now must be the one that was checked.
        assert!(same_listing(&gh("aaaaaaa"), Some(&gh("aaaaaaa"))).is_ok());
        let err = same_listing(&gh("aaaaaaa"), Some(&gh("bbbbbbb"))).unwrap_err();
        assert!(err.contains("updated in the catalog"), "{err}");
        let branch = Source::Github { repo: "o/r".into(), sha: None, path: None, git_ref: Some("payload".into()) };
        assert!(same_listing(&gh("aaaaaaa"), Some(&branch)).is_err());
        assert!(same_listing(&branch, Some(&branch)).is_ok());
        assert!(same_listing(&gh("aaaaaaa"), None).is_err());
        // Hostile fixture: a plugin listed at a branch that holds different files than HEAD. Atlas
        // has to download that branch (what Claude Code installs), never HEAD.
        let on_branch = Source::Github { repo: "o/r".into(), sha: None, path: None, git_ref: Some("payload".into()) };
        assert_eq!(fetch_target(&on_branch), Some("payload"));
        let bare = Source::Github { repo: "o/r".into(), sha: None, path: None, git_ref: None };
        assert_eq!(fetch_target(&bare), Some("HEAD"));
        assert_eq!(fetch_target(&gh("abc1234")), Some("abc1234"));
        let both = Source::Github { repo: "o/r".into(), sha: Some("abc1234".into()), path: None, git_ref: Some("payload".into()) };
        assert_eq!(fetch_target(&both), Some("abc1234"));
        assert_eq!(fetch_target(&Source::Other { url: "x".into() }), None);
        // A short hash is a prefix of the long one, and an unknown one never matches.
        assert!(same_commit("0123456789abcdef", "0123456"));
        assert!(!same_commit("0123456789abcdef", "0123457"));
        assert!(!same_commit("", ""));
    }

    #[test]
    fn a_library_install_has_one_labelled_history_row_that_undoes_by_uninstalling() {
        let e = env();
        put(&e.dir, "settings.json", br#"{"model":"x"}"#);
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake.clone());
        let good = tree_hash_of(TREE);
        let o = install_plugin(&e.ctx(), &runner, "fd@mk", &gh("abc"), &Checked { repo: "o/r", sha: "abc", tree_hash: &good }).unwrap();
        let info = sw::list_backups_detailed(&e.backups, 5);
        assert_eq!(info.len(), 1, "one row per install");
        assert!(info[0].can_restore, "an install can be undone");
        assert!(info[0].summary.as_deref().unwrap_or("").contains("Installed fd from the Library"), "{}", info[0].summary.clone().unwrap_or_default());
        let op = sw::library_op(&e.backups, &o.backup_id).unwrap();
        assert_eq!((op.op.as_str(), op.sha.as_str(), op.tree_hash.as_str()), ("install", "abc", good.as_str()));

        let done = undo_plugin_backup(&e.ctx(), &runner, &o.backup_id, Some(&gh("abc"))).unwrap();
        assert_eq!(done.did, "uninstall");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_none());
        // Undone once: it can't be undone twice, and the undo itself has its own row that can be undone.
        assert!(undo_plugin_backup(&e.ctx(), &runner, &o.backup_id, None).unwrap_err().contains("already undone"));
        let rows = sw::list_backups_detailed(&e.backups, 5);
        assert_eq!(rows.len(), 2);
        let first = rows.iter().find(|r| r.backup_id == o.backup_id).unwrap();
        assert!(!first.can_restore && first.summary.as_deref().unwrap_or("").contains("(undone)"));
        let undo_row = rows.iter().find(|r| r.backup_id == done.backup_id).unwrap();
        assert!(undo_row.can_restore && undo_row.summary.as_deref().unwrap_or("").contains("undo of an install"), "{}", undo_row.summary.clone().unwrap_or_default());

        // Undoing the removal brings the same commit back.
        let back = undo_plugin_backup(&e.ctx(), &runner, &done.backup_id, Some(&gh("abc"))).unwrap();
        assert_eq!(back.did, "install");
        assert_eq!(ledger::user_install(&e.dir, "fd@mk").unwrap().git_sha.as_deref(), Some("abc"));
        assert_eq!(fake.log().iter().filter(|l| l.starts_with("plugin install")).count(), 2);
    }

    #[test]
    fn a_plain_uninstall_can_be_undone_and_a_moved_listing_blocks_it() {
        let e = env();
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake.clone());
        let good = tree_hash_of(TREE);
        install_plugin(&e.ctx(), &runner, "fd@mk", &gh("abc"), &Checked { repo: "o/r", sha: "abc", tree_hash: &good }).unwrap();
        let bid = uninstall_plugin(&e.ctx(), &runner, "fd@mk").unwrap();
        let op = sw::library_op(&e.backups, &bid).unwrap();
        assert_eq!((op.op.as_str(), op.sha.as_str(), op.repo.as_str()), ("uninstall", "abc", "o/r"));
        // The catalog moved on: the old version can't be given back, nothing is installed.
        let err = undo_plugin_backup(&e.ctx(), &runner, &bid, Some(&gh("def4567"))).unwrap_err();
        assert!(err.contains("updated since you removed it"), "{err}");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_none());
        // Still listed at the same commit: it comes back.
        undo_plugin_backup(&e.ctx(), &runner, &bid, Some(&gh("abc"))).unwrap();
        assert!(ledger::user_install(&e.dir, "fd@mk").is_some());
        // Undoing it again while installed is refused.
        assert!(undo_plugin_backup(&e.ctx(), &runner, &bid, Some(&gh("abc"))).is_err());
    }

    #[test]
    fn undoing_a_removal_that_lands_another_commit_takes_it_out_again() {
        let e = env();
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake.clone());
        let good = tree_hash_of(TREE);
        install_plugin(&e.ctx(), &runner, "fd@mk", &gh("abc"), &Checked { repo: "o/r", sha: "abc", tree_hash: &good }).unwrap();
        let bid = uninstall_plugin(&e.ctx(), &runner, "fd@mk").unwrap();
        // The removed version was another commit than the one Claude Code installs now (the fake lands "abc").
        sw::tag_library_op(&e.backups, &bid, "x", sw::LibOp { op: "uninstall".into(), id: "fd@mk".into(), repo: "o/r".into(), sha: "1234567890".into(), tree_hash: good.clone(), undone: false });
        let err = undo_plugin_backup(&e.ctx(), &runner, &bid, None).unwrap_err();
        assert!(err.contains("took it out again"), "{err}");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_none(), "no unchecked commit stays installed");
    }

    #[test]
    fn undoing_an_install_leaves_an_updated_plugin_alone() {
        let e = env();
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake.clone());
        let good = tree_hash_of(TREE);
        let o = install_plugin(&e.ctx(), &runner, "fd@mk", &gh("abc"), &Checked { repo: "o/r", sha: "abc", tree_hash: &good }).unwrap();
        // Claude Code updated it to another commit since.
        let p = e.dir.join("plugins/installed_plugins.json");
        let t = fs::read_to_string(&p).unwrap().replace("\"abc\"", "\"zzz9999\"");
        fs::write(&p, t).unwrap();
        let err = undo_plugin_backup(&e.ctx(), &runner, &o.backup_id, None).unwrap_err();
        assert!(err.contains("updated since you installed it"), "{err}");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_some());
    }

    #[test]
    fn a_commit_that_lands_other_than_the_checked_one_is_taken_out_again() {
        let e = env();
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake);
        let good = tree_hash_of(TREE);
        // Same files, but the commit Claude Code landed ("abc") is not the one that was checked.
        let err = install_plugin(&e.ctx(), &runner, "fd@mk", &gh("1234567890"), &Checked { repo: "o/r", sha: "1234567890", tree_hash: &good }).unwrap_err();
        assert!(err.contains("took it out again"), "{err}");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_none());
        assert!(ledger::read(&e.data).entries.is_empty(), "nothing is recorded as installed");
    }

    #[test]
    fn files_that_differ_with_no_commit_to_pin_them_to_are_taken_out_again() {
        let e = env();
        let fake = fake_claude(e.dir.clone(), TREE);
        let runner = Runner::with_exec("claude".into(), &e.root, fake);
        // A plugin inside a marketplace folder: no commit, and the files are not the ones checked.
        let local = Source::Local { path: "./fd".into() };
        let err = install_plugin(&e.ctx(), &runner, "fd@mk", &local, &Checked { repo: "", sha: "", tree_hash: "not-what-landed" }).unwrap_err();
        assert!(err.contains("took it out again") && err.contains("not the ones Atlas checked"), "{err}");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_none());
        assert!(ledger::read(&e.data).entries.is_empty());
        // The same files as checked stay.
        let good = tree_hash_of(TREE);
        assert!(install_plugin(&e.ctx(), &runner, "fd@mk", &local, &Checked { repo: "", sha: "", tree_hash: &good }).is_ok());
    }

    #[test]
    fn a_rollback_that_fails_says_the_plugin_is_still_installed() {
        let e = env();
        let fake = fake_claude_with(e.dir.clone(), TREE, false);
        let runner = Runner::with_exec("claude".into(), &e.root, fake);
        let good = tree_hash_of(TREE);
        let err = install_plugin(&e.ctx(), &runner, "fd@mk", &gh("1234567890"), &Checked { repo: "o/r", sha: "1234567890", tree_hash: &good }).unwrap_err();
        assert!(!err.contains("took it out again,") && !err.contains("so Atlas took it out"), "{err}");
        assert!(err.contains("could not take it out again") && err.contains("still installed") && err.contains("Uninstall"), "{err}");
        assert!(ledger::user_install(&e.dir, "fd@mk").is_some(), "it really is still installed");
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
