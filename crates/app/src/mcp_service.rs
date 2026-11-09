//! Connect / Disconnect for the Atlas MCP server (`atlas-mcp`), from Settings.
//!
//! The program ships next to the app (`atlas-mcp.exe` beside `atlas.exe`; on macOS inside the
//! bundle's Resources). Connecting registers its absolute path with Claude Code at user scope;
//! what is shown is always read back from Claude's own settings file. Sandbox Mode never
//! connects: the sandbox is a copy, and a registration there would go nowhere.

use std::path::PathBuf;
use std::sync::Arc;

use atlas_core::connect::{self, CliChoice, ConnectCtx, ConnectOutcome, ConnectState};
use serde::Serialize;
use tauri::State;

use crate::state::AppState;

type Shared<'a> = State<'a, Arc<AppState>>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    #[serde(flatten)]
    state: ConnectState,
    /// Sandbox Mode is on (or still copying): Connect is off.
    sandbox: bool,
}

/// Where the shipped `atlas-mcp` is: beside the running program, or in the macOS bundle.
pub fn server_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let name = if cfg!(windows) { "atlas-mcp.exe" } else { "atlas-mcp" };
    [dir.join(name), dir.join("..").join("Resources").join(name)].into_iter().find(|p| p.is_file()).map(|p| p.canonicalize().map(strip_verbatim).unwrap_or(p))
}

/// `\\?\C:\...` is how Windows spells a canonical path; Claude's settings should hold `C:\...`.
fn strip_verbatim(p: PathBuf) -> PathBuf {
    match p.to_string_lossy().strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

fn cli_found() -> bool {
    CliChoice::Auto.found()
}

fn status_of(state: &AppState) -> McpStatus {
    let server = server_path();
    match state.history_root() {
        Some(root) => McpStatus { state: connect::state(&root, server.as_deref(), cli_found()), sandbox: false },
        None => McpStatus {
            state: ConnectState { state: "notConnected".into(), command: None, server: server.as_deref().map(atlas_core::setup::display_path), cli_found: cli_found(), config_readable: true },
            sandbox: true,
        },
    }
}

#[tauri::command(async)]
pub fn mcp_status(state: Shared) -> McpStatus {
    status_of(&state)
}

fn with_ctx(state: &AppState, f: impl FnOnce(&ConnectCtx) -> Result<ConnectOutcome, String>) -> Result<ConnectOutcome, String> {
    let root = state.history_root().ok_or("Turn Sandbox Mode off first. Connecting changes your real Claude settings.")?;
    let server = server_path().ok_or("The Atlas connector program is missing from this install, so there is nothing to connect. Reinstalling Atlas puts it back.")?;
    let backups = state.data_dir.join("setup-backups");
    f(&ConnectCtx { root: &root, server: &server, backups: &backups, data_dir_flag: state.launch.data_dir.as_deref(), cli: CliChoice::Auto })
}

/// Turning "Let Claude Code use Atlas" on: remember the choice (the page hears about it through
/// the usual settings announcement), then connect now. If the choice cannot be saved, nothing
/// else happens.
#[tauri::command(async)]
pub fn mcp_connect(state: Shared) -> Result<ConnectOutcome, String> {
    let done = state.save_mcp_choice(true).and_then(|()| with_ctx(&state, connect::connect));
    state.announce();
    done
}

/// Turning it off: remember the choice first (so Atlas never reconnects by itself, whatever
/// happens next), then remove the registration. If the choice cannot be saved the registration
/// stays and the page is told so, rather than promising an off the next launch would undo. An
/// `atlas` entry that is another program's is never removed.
#[tauri::command(async)]
pub fn mcp_disconnect(state: Shared) -> Result<ConnectOutcome, String> {
    let done = state.save_mcp_choice(false).and_then(|()| with_ctx(&state, connect::disconnect));
    state.announce();
    done
}

/// After the first paint, on its own thread, once per run: connect Atlas to Claude Code if it
/// should be, and repair a registration whose program no longer exists. Never shows anything; a
/// missing `claude` command just means a later launch tries again. All spawns are quiet (no
/// window), and a debug build refuses to touch the real Claude folder, so development never
/// changes it. A `--config-dir` or `--data-dir` launch, and a program in a place that will not
/// last (a build folder, a temp folder, a macOS translocated copy), never registers itself.
pub fn auto_connect_in_background(state: &Arc<AppState>) {
    if !state.claim_auto_connect() {
        return;
    }
    let state = Arc::clone(state);
    std::thread::spawn(move || {
        // Let the first screen and the usage index settle before a child process starts.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let (Some(root), Some(server)) = (state.history_root(), server_path()) else { return };
        if !connect::auto_allowed(root.source, state.launch.data_dir.as_deref()) {
            eprintln!("[atlas] claude code connection: skipped (a --config-dir or --data-dir launch)");
            return;
        }
        if !connect::is_stable_install(&server) {
            eprintln!("[atlas] claude code connection: skipped (this copy runs from a folder that will not stay)");
            return;
        }
        let backups = state.data_dir.join("setup-backups");
        let ctx = ConnectCtx { root: &root, server: &server, backups: &backups, data_dir_flag: state.launch.data_dir.as_deref(), cli: CliChoice::Auto };
        let out = connect::auto_connect(&ctx, &|| state.mcp_auto_connect());
        eprintln!("[atlas] claude code connection: {out:?}");
    });
}
