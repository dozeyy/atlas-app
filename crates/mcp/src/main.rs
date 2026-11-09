//! Atlas MCP server: Claude Code starts this program and talks to it over stdin/stdout.
//!
//! It never opens a network port. stdout carries the protocol, so everything else goes to
//! stderr. Flags: `--config-dir <dir>` (the Claude folder to manage), `--data-dir <dir>`
//! (Atlas's data folder: backups, pending changes, usage index) and
//! `--propose [queue-dir]` (queue every change for approval in Atlas instead of applying it).
//! Without flags it resolves the folders exactly like the app does.
//!
//! On Windows this is built as a windowed program (no console subsystem): Claude Code starts it
//! with pipes for stdin and stdout, which a windowed program still receives, and it can never
//! open a console window, however it was launched.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod server;
mod usage;

use std::ffi::OsString;
use std::path::PathBuf;

use atlas_core::habits::Habits;
use atlas_core::launch::LaunchArgs;
use atlas_core::ops::Ops;
use atlas_core::paths::{self, ConfigInputs, ConfigSource, resolve_config_root};
use atlas_core::setup::{DiscoveryInputs, default_managed_dir};
use rmcp::ServiceExt;
use rmcp::transport::stdio;

/// Splits `--propose [dir]` out of the arguments; the rest is the app's own launch flags.
fn split_args(args: Vec<OsString>) -> (Vec<OsString>, Option<Option<PathBuf>>) {
    let mut rest = Vec::new();
    let mut propose: Option<Option<PathBuf>> = None;
    let mut it = args.into_iter().peekable();
    while let Some(a) = it.next() {
        let text = a.to_string_lossy().into_owned();
        if text == "--propose" {
            let dir = match it.peek() {
                Some(n) if !n.to_string_lossy().starts_with("--") => it.next().map(PathBuf::from),
                _ => None,
            };
            propose = Some(dir);
        } else if let Some(v) = text.strip_prefix("--propose=") {
            propose = Some((!v.is_empty()).then(|| PathBuf::from(v)));
        } else {
            rest.push(a);
        }
    }
    (rest, propose)
}

fn main() {
    let (rest, propose) = split_args(std::env::args_os().skip(1).collect());
    let args = LaunchArgs::parse(rest);
    for w in &args.warnings {
        eprintln!("atlas-mcp: {w}");
    }
    let home = paths::home_dir().expect("no home directory");
    let cwd = std::env::current_dir().unwrap_or_else(|_| home.clone());
    let env_cfg = std::env::var_os("CLAUDE_CONFIG_DIR");
    let root = resolve_config_root(&ConfigInputs { flag: args.config_dir.as_deref(), settings_override: None, env: env_cfg.as_deref(), home: &home, cwd: &cwd });
    let atlas_env = std::env::var_os("ATLAS_DATA_DIR");
    let data_dir = paths::data_dir(args.data_dir.as_deref(), atlas_env.as_deref(), &home, &cwd).unwrap_or_else(|| std::env::temp_dir().join("atlas"));
    let local_data = paths::local_data_dir(args.data_dir.as_deref(), atlas_env.as_deref(), &home, &cwd).unwrap_or_else(|| data_dir.clone());

    let queue = propose.map(|d| d.map(|d| paths::absolutize(&d, &home, &cwd)).unwrap_or_else(|| data_dir.join("pending-changes")));
    // The chat index the app keeps (read-only here); a `--config-dir` folder has its own file.
    let index = atlas_core::search::db::search_file(&local_data, &root.projects_dir, root.source != ConfigSource::Flag);
    let habits = Habits::new(index, data_dir.clone());
    let usage = usage::Usage::new(root.projects_dir.clone(), root.dir.clone(), local_data);
    let inputs = DiscoveryInputs { root: root.clone(), home, managed_dir: default_managed_dir(), include_worktrees: false, sandboxed: false };
    // Direct mode ("mcp") may not plant anything that runs commands; propose mode records every
    // change as "assistant" and the user approves it in the app.
    let ops = match &queue {
        Some(_) => Ops::new(inputs, &data_dir, "assistant"),
        None => Ops::new(inputs, &data_dir, "mcp").deny_code_changes(),
    };
    eprintln!("atlas-mcp {}: managing {}{}", env!("CARGO_PKG_VERSION"), root.dir.display(), if queue.is_some() { " (propose mode)" } else { "" });

    let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("async runtime");
    let code = rt.block_on(async move {
        let server = server::AtlasServer::new(ops, queue, usage).with_habits(habits);
        match server.serve(stdio()).await {
            Ok(running) => match running.waiting().await {
                Ok(_) => 0,
                Err(e) => {
                    eprintln!("atlas-mcp: stopped: {e}");
                    1
                }
            },
            Err(e) => {
                eprintln!("atlas-mcp: could not start: {e}");
                1
            }
        }
    });
    std::process::exit(code);
}
