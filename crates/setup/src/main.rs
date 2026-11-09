//! Atlas Setup: one small styled window that installs Atlas and, from the moment it opens,
//! reads the Claude Code chats into Atlas's usage cache so Atlas opens already indexed.
//!
//! Flow: Ready (Install button, two quiet options, a live "already reading" line) ->
//! Installing -> Done (the window eases out as Atlas's own intro starts). The real installer
//! rides inside (`install.rs`); the reading is the app's own engine (`indexer.rs`).

#![cfg_attr(not(test), windows_subsystem = "windows")]

#[cfg(not(windows))]
compile_error!("Atlas Setup is the Windows installer. Build it on Windows (exclude it with --exclude atlas-setup elsewhere).");

mod indexer;
mod install;
mod state;
#[cfg(windows)]
mod winsys;

use std::sync::Arc;

use tauri::{Manager, WindowEvent};

use state::Setup;

/// Test hook: behave as if the WebView2 runtime were missing (no registry is touched).
const FORCE_NO_WEBVIEW2_ENV: &str = "ATLAS_SETUP_FORCE_NO_WEBVIEW2";

const WEBVIEW2_CLIENT: &str = r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/// The WebView2 runtime is installed when one of Microsoft's documented keys has a version.
fn webview2_installed() -> bool {
    if std::env::var_os(FORCE_NO_WEBVIEW2_ENV).is_some() {
        return false;
    }
    use winsys::Hive::{CurrentUser, LocalMachine};
    let has = |hive, wow32| {
        winsys::reg_string(hive, WEBVIEW2_CLIENT, "pv", wow32).is_some_and(|v| !v.is_empty() && v != "0.0.0.0")
    };
    has(LocalMachine, true) || has(LocalMachine, false) || has(CurrentUser, false)
}

/// No WebView2: the styled window cannot run, so hand over to the plain installer, which
/// installs the runtime itself. Returns the exit code.
fn plain_installer() -> i32 {
    match install::unpack() {
        Ok(u) => install::run_interactive(&u.exe).unwrap_or(1),
        Err(e) => {
            winsys::message("Atlas Setup", &e.message());
            1
        }
    }
}

fn main() {
    if !webview2_installed() {
        std::process::exit(plain_installer());
    }
    let setup = Setup::new();
    let for_events = Arc::clone(&setup);
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .manage(Arc::clone(&setup))
        .invoke_handler(tauri::generate_handler![
            state::setup_state,
            state::setup_ready,
            state::begin_install,
            state::close_atlas_and_continue,
            state::handoff,
            state::cancel,
            state::finish,
        ])
        .setup(move |app| {
            setup.attach(app.handle().clone());
            Ok(())
        })
        .on_window_event(move |_window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event
                && !for_events.on_close_requested()
            {
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!());
    if let Err(e) = result {
        winsys::message("Atlas Setup", &format!("Setup could not open its window ({e})."));
        std::process::exit(1);
    }
}
