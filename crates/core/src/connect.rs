//! Connect / Disconnect: register the `atlas-mcp` server with Claude Code at user scope.
//!
//! The way in is Claude Code's own command (`claude mcp add-json -s user atlas <json>` and
//! `claude mcp remove -s user atlas`), because it is the owner of `.claude.json`. When the
//! command is missing, or ran but the file does not show the change, the fallback is the
//! one-key edit from the recon (`setup_write::edit_json_keys`): back up, change only
//! `mcpServers.atlas`, look again right before the swap, read it back and prove every other
//! key is untouched. The connected state is always read from the file, never remembered.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::paths::{ConfigRoot, ConfigSource};
use crate::setup_write::{self as sw, WriteError};

/// The name the server is registered under.
pub const SERVER_NAME: &str = "atlas";
const CLI_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectState {
    /// connected | notConnected | moved (registered, but to a different program path)
    pub state: String,
    /// The program the registration points at.
    pub command: Option<String>,
    /// The Atlas MCP program that ships with this app (None if it is missing).
    pub server: Option<String>,
    /// Claude Code's command was found on this computer.
    pub cli_found: bool,
    /// `.claude.json` could be read (false: the file is missing or unreadable).
    pub config_readable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOutcome {
    pub state: ConnectState,
    /// cli | file: which way made the change.
    pub via: String,
    /// The backup made first, when the file was edited directly.
    pub backup_id: Option<String>,
}

/// What `connect` and `disconnect` need to know.
pub struct ConnectCtx<'a> {
    pub root: &'a ConfigRoot,
    /// The Atlas MCP program (absolute).
    pub server: &'a Path,
    /// Where backups go (Atlas's `setup-backups`).
    pub backups: &'a Path,
    /// Atlas's data folder when it was chosen on the command line (passed on to the server).
    pub data_dir_flag: Option<&'a Path>,
    /// Which `claude` command to use.
    pub cli: CliChoice,
}

/// Where Claude Code's command comes from.
pub enum CliChoice {
    /// Look on `PATH` and in the installers' usual places.
    Auto,
    /// This exact program.
    Path(PathBuf),
    /// Pretend there is none (the file edit is used).
    Missing,
}

impl CliChoice {
    /// Is there a command to use?
    pub fn found(&self) -> bool {
        self.resolve().is_some()
    }

    fn resolve(&self) -> Option<PathBuf> {
        match self {
            CliChoice::Auto => {
                let home = crate::paths::home_dir().unwrap_or_default();
                find_claude_cli(std::env::var_os("PATH").as_deref(), &home)
            }
            CliChoice::Path(p) => Some(p.clone()),
            CliChoice::Missing => None,
        }
    }
}

fn norm(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

fn read_cj(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&bytes)).ok()
}

/// Where `claude` lives: the first match on `PATH`, then the places the installers use.
pub fn find_claude_cli(path_var: Option<&OsStr>, home: &Path) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd", "claude.bat"] } else { &["claude"] };
    let mut dirs: Vec<PathBuf> = path_var.map(|p| std::env::split_paths(p).collect()).unwrap_or_default();
    dirs.push(home.join(".local").join("bin"));
    dirs.push(home.join(".claude").join("local"));
    if let Some(app) = std::env::var_os("APPDATA") {
        dirs.push(PathBuf::from(app).join("npm"));
    }
    for d in dirs {
        for n in names {
            let p = d.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// The registration as read from the file, for the Settings card.
pub fn state(root: &ConfigRoot, server: Option<&Path>, cli: bool) -> ConnectState {
    let cj = read_cj(&root.claude_json);
    let command = cj.as_ref().and_then(|v| v.get("mcpServers")).and_then(|m| m.get(SERVER_NAME)).and_then(|e| e.get("command")).and_then(Value::as_str).map(str::to_string);
    let registered = cj.as_ref().and_then(|v| v.get("mcpServers")).and_then(|m| m.get(SERVER_NAME)).is_some();
    let state = match (&command, server) {
        (Some(c), Some(s)) if norm(c) == norm(&crate::setup::display_path(s)) => "connected",
        (Some(_), _) => "moved",
        (None, _) if registered => "moved",
        _ => "notConnected",
    };
    ConnectState { state: state.into(), command, server: server.map(crate::setup::display_path), cli_found: cli, config_readable: cj.is_some() || !root.claude_json.exists() }
}

/// The JSON Claude Code stores for the server.
pub fn server_json(ctx: &ConnectCtx) -> Value {
    let mut args: Vec<String> = Vec::new();
    // A config folder that is not the default is passed along, so the server reads the same one.
    if !matches!(ctx.root.source, ConfigSource::Default) {
        args.push("--config-dir".into());
        args.push(crate::setup::display_path(&ctx.root.dir));
    }
    if let Some(d) = ctx.data_dir_flag {
        args.push("--data-dir".into());
        args.push(crate::setup::display_path(d));
    }
    json!({ "type": "stdio", "command": crate::setup::display_path(ctx.server), "args": args, "env": {} })
}

/// Run `claude mcp ...` quietly. Ok when it exits 0 within the time limit.
fn run_cli(cli: &Path, args: &[&str], root: &ConfigRoot) -> Result<(), String> {
    let mut cmd = Command::new(cli);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // The command finds `.claude.json` from this variable, so a custom folder is passed on.
    if !matches!(root.source, ConfigSource::Default) {
        cmd.env("CLAUDE_CONFIG_DIR", &root.dir);
    }
    crate::proc::quiet(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Could not start Claude Code's command: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(s)) if s.success() => return Ok(()),
            Ok(Some(_)) => {
                let mut msg = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut e, &mut msg);
                }
                return Err(msg.lines().next().unwrap_or("Claude Code's command did not finish.").to_string());
            }
            Ok(None) if start.elapsed() > CLI_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Claude Code's command took too long.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// Register an MCP server at user scope through Claude Code's own command. `Err` when there is
/// no command or it failed (the caller then falls back to the guarded file edit).
pub fn cli_add_json(cli: &CliChoice, root: &ConfigRoot, name: &str, entry: &Value) -> Result<(), String> {
    let cli = cli.resolve().ok_or("Claude Code's command was not found.")?;
    let text = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    run_cli(&cli, &["mcp", "add-json", "-s", "user", name, &text], root)
}

fn lock_dir(ctx: &ConnectCtx) -> Option<PathBuf> {
    ctx.backups.parent().map(Path::to_path_buf)
}

/// The cross-process write lock. Without it nothing is changed: two writers could clobber each other.
fn lock(ctx: &ConnectCtx, wait: Duration) -> Result<crate::writelock::WriteGuard, String> {
    const BUSY: &str = "Another Atlas change is in progress. Nothing was changed; please try again in a moment.";
    let dir = lock_dir(ctx).ok_or(BUSY)?;
    crate::writelock::acquire(&dir, wait).map_err(|_| BUSY.to_string())
}

/// How long Connect and Disconnect wait for another Atlas change to finish.
const LOCK_WAIT: Duration = Duration::from_secs(15);

/// Is the `atlas` entry absent from `.claude.json`? A missing file counts as absent; a file
/// that exists but can't be read or parsed is an error (never "it's gone").
fn entry_gone(path: &Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(true);
    }
    let v = read_cj(path).ok_or("Claude's settings file can't be read, so Atlas can't tell whether it is connected. Nothing was changed.")?;
    Ok(v.get("mcpServers").and_then(|m| m.get(SERVER_NAME)).is_none())
}

/// Register the server. Returns the new state, read back from the file.
pub fn connect(ctx: &ConnectCtx) -> Result<ConnectOutcome, String> {
    connect_waiting(ctx, LOCK_WAIT)
}

/// `connect`, waiting at most `wait` for another Atlas change to finish.
pub fn connect_waiting(ctx: &ConnectCtx, wait: Duration) -> Result<ConnectOutcome, String> {
    crate::fsutil::check_write_allowed(&ctx.root.claude_json).map_err(|e| e.to_string())?;
    if !ctx.server.is_file() {
        return Err("The Atlas connector program is missing from this install, so there is nothing to connect. Reinstalling Atlas puts it back.".into());
    }
    let _guard = lock(ctx, wait)?;
    let cli = ctx.cli.resolve();
    let want =crate::setup::display_path(ctx.server);
    let json = server_json(ctx);
    let ok = |c: &ConnectCtx| state(c.root, Some(c.server), cli.is_some()).state == "connected";
    let mut via = "file";
    let mut backup_id = None;
    if let Some(cli) = &cli {
        // A registration that points elsewhere has to go first (add-json refuses a name in use).
        if state(ctx.root, Some(ctx.server), true).command.is_some() {
            let _ = run_cli(cli, &["mcp", "remove", "-s", "user", SERVER_NAME], ctx.root);
        }
        let text = serde_json::to_string(&json).map_err(|e| e.to_string())?;
        if run_cli(cli, &["mcp", "add-json", "-s", "user", SERVER_NAME, &text], ctx.root).is_ok() && ok(ctx) {
            via = "cli";
        }
    }
    if via != "cli" {
        let entry = json.clone();
        let id = sw::edit_json_keys(&ctx.root.claude_json, ctx.backups, "connect-atlas", "mcpServer", SERVER_NAME, &["mcpServers"], |root| {
            let obj = root.as_object_mut().ok_or_else(|| WriteError::Refused("The file is not a JSON object.".into()))?;
            let servers = obj.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
            servers.as_object_mut().ok_or_else(|| WriteError::Refused("\"mcpServers\" in the file is not an object.".into()))?.insert(SERVER_NAME.into(), entry);
            Ok(())
        })
        .map_err(|e| e.message())?;
        sw::tag_backup(ctx.backups, &id, "user", "Connected Atlas to Claude Code");
        backup_id = Some(id);
    }
    let st = state(ctx.root, Some(ctx.server), cli.is_some());
    if st.state != "connected" {
        return Err(format!("Atlas asked, but Claude's settings do not show it as connected (it points at {}). Please check {}.", st.command.as_deref().unwrap_or("nothing"), want));
    }
    Ok(ConnectOutcome { state: st, via: via.into(), backup_id })
}

/// What `auto_connect` did (or why it did nothing). Nothing here is an error the user is shown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AutoOutcome {
    /// The user turned it off in Settings.
    Off,
    /// Claude Code's command was not found: try again on a later launch.
    NoCli,
    /// The connector program is missing from this install.
    NoServer,
    /// Already registered to this install, with the right arguments: nothing was touched.
    Current,
    /// An `atlas` entry that is someone else's program: left alone.
    Foreign,
    /// Registered for the first time.
    Connected,
    /// The registration pointed at a moved or old copy (or had stale arguments): pointed here.
    Repaired,
    /// A guard said no (a debug build near the real Claude folder, an unreadable file, a busy
    /// lock). Nothing was changed; the reason is for the log.
    Skipped(String),
}

fn registered_entry(path: &Path) -> Result<Option<Value>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let v = read_cj(path).ok_or("Claude's settings file can't be read, so Atlas left it alone.")?;
    Ok(v.get("mcpServers").and_then(|m| m.get(SERVER_NAME)).cloned())
}

/// Is this entry the one Atlas would write for this install (same program, same arguments)?
fn entry_is_current(entry: &Value, ctx: &ConnectCtx) -> bool {
    let want = server_json(ctx);
    let same_cmd = entry.get("command").and_then(Value::as_str).is_some_and(|c| norm(c) == norm(&crate::setup::display_path(ctx.server)));
    same_cmd && entry.get("args").cloned().unwrap_or(Value::Array(vec![])) == want["args"]
}

/// Is this entry Atlas's own connector (an old or moved copy), as opposed to another program a
/// person registered under the same name? A program that no longer exists is stale too.
fn entry_is_ours(entry: &Value) -> bool {
    let Some(cmd) = entry.get("command").and_then(Value::as_str) else { return false };
    let stem = Path::new(&cmd.replace('\\', "/")).file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    stem.starts_with("atlas-mcp") || !Path::new(cmd).exists()
}

/// Make sure Claude Code can use Atlas without anyone pressing a button. Runs after the first
/// paint, off the UI thread. It registers the server when it is absent and the `claude` command
/// is there, repairs a registration that points at a moved or old copy, and does nothing when
/// the user turned it off, when everything is already right, or when the command is missing (a
/// later launch tries again). Writes go through `connect`, so the backup, the lock, the debug-build
/// guard and the quiet (no window) spawns all apply.
pub fn auto_connect(ctx: &ConnectCtx, enabled: bool) -> AutoOutcome {
    if !enabled {
        return AutoOutcome::Off;
    }
    if !ctx.server.is_file() {
        return AutoOutcome::NoServer;
    }
    if !ctx.cli.found() {
        return AutoOutcome::NoCli;
    }
    if let Err(e) = crate::fsutil::check_write_allowed(&ctx.root.claude_json) {
        return AutoOutcome::Skipped(e.to_string());
    }
    let repair = match registered_entry(&ctx.root.claude_json) {
        Err(e) => return AutoOutcome::Skipped(e),
        Ok(None) => false,
        Ok(Some(e)) if entry_is_current(&e, ctx) => return AutoOutcome::Current,
        Ok(Some(e)) if entry_is_ours(&e) => true,
        Ok(Some(_)) => return AutoOutcome::Foreign,
    };
    match connect_waiting(ctx, Duration::from_secs(3)) {
        Ok(_) if repair => AutoOutcome::Repaired,
        Ok(_) => AutoOutcome::Connected,
        Err(e) => AutoOutcome::Skipped(e),
    }
}

/// Remove the registration. Only the `atlas` entry is touched.
pub fn disconnect(ctx: &ConnectCtx) -> Result<ConnectOutcome, String> {
    disconnect_waiting(ctx, LOCK_WAIT)
}

/// `disconnect`, waiting at most `wait` for another Atlas change to finish.
pub fn disconnect_waiting(ctx: &ConnectCtx, wait: Duration) -> Result<ConnectOutcome, String> {
    crate::fsutil::check_write_allowed(&ctx.root.claude_json).map_err(|e| e.to_string())?;
    let _guard = lock(ctx, wait)?;
    let cli = ctx.cli.resolve();
    let gone = |c: &ConnectCtx| entry_gone(&c.root.claude_json);
    let mut via = "file";
    let mut backup_id = None;
    if gone(ctx)? {
        let st = state(ctx.root, Some(ctx.server), cli.is_some());
        return Ok(ConnectOutcome { state: st, via: "none".into(), backup_id: None });
    }
    if let Some(cli) = &cli
        && run_cli(cli, &["mcp", "remove", "-s", "user", SERVER_NAME], ctx.root).is_ok()
        && gone(ctx).unwrap_or(false)
    {
        via = "cli";
    }
    if via != "cli" {
        let id = sw::edit_json_keys(&ctx.root.claude_json, ctx.backups, "disconnect-atlas", "mcpServer", SERVER_NAME, &["mcpServers"], |root| {
            if let Some(m) = root.get_mut("mcpServers").and_then(Value::as_object_mut) {
                m.shift_remove(SERVER_NAME);
            }
            Ok(())
        })
        .map_err(|e| e.message())?;
        sw::tag_backup(ctx.backups, &id, "user", "Disconnected Atlas from Claude Code");
        backup_id = Some(id);
    }
    if !gone(ctx)? {
        return Err("Atlas asked, but Claude's settings still list it. Please check .claude.json.".into());
    }
    Ok(ConnectOutcome { state: state(ctx.root, Some(ctx.server), cli.is_some()), via: via.into(), backup_id })
}
