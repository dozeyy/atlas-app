//! Atlas Setup: one small styled window that installs Atlas by itself the moment it opens and,
//! from that moment, reads the Claude Code chats into Atlas's usage cache so Atlas opens already
//! indexed. The same program, renamed `Uninstall Atlas.exe` and kept beside Atlas, is the remover.
//!
//! Install: the window opens, the trail plays while the real installer runs silently, Atlas is
//! started the moment its files are written, and the window eases out as Atlas's own intro
//! begins. Uninstall: one screen with one box (also remove Atlas's saved data), then the same
//! trail backwards. The real installer rides inside (`install.rs`); the reading is the app's own
//! engine (`indexer.rs`); the remover's disk work is `uninstall.rs`.

#![cfg_attr(not(test), windows_subsystem = "windows")]

#[cfg(not(windows))]
compile_error!("Atlas Setup is the Windows installer. Build it on Windows (exclude it with --exclude atlas-setup elsewhere).");

mod indexer;
mod install;
mod state;
mod uninstall;
#[cfg(windows)]
mod winsys;

use std::path::PathBuf;
use std::sync::Arc;

use tauri::{Manager, WindowEvent};

use state::{Mode, Setup};
use uninstall::Launch;

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

/// No WebView2: the styled window cannot run, so do the same work with no window at all. The
/// Atlas installer fetches the runtime itself (silently) when it is missing. Nothing Windows-made
/// is shown, and Atlas opens at the end. Returns the exit code.
///
/// `quiet` is a deliberate `/S`: no message boxes at all (the exit code says how it went), and
/// Atlas is opened only when `/R` came with it, the same convention as the installer inside.
fn windowless_install(quiet: bool, open_after: bool) -> i32 {
    let say = |text: &str| {
        if !quiet {
            winsys::message("Atlas Setup", text);
        }
    };
    let dir = install::install_dir();
    let unpacked = match install::unpack() {
        Ok(u) => u,
        Err(e) => {
            say(&e.message());
            return 1;
        }
    };
    let result = install::run_silent(&unpacked.exe, |_| {});
    drop(unpacked);
    if let Err(e) = result {
        say(&e.message());
        return 1;
    }
    let _ = install::place_remover(&dir);
    if quiet && !open_after {
        return 0;
    }
    match install::launch(&dir) {
        Err(_) => {
            say("Atlas is installed but would not start. Open it from the Start menu.");
            1
        }
        Ok(install::Launched::SkippedElevated) => {
            say("Atlas is installed. Setup was run as administrator, so it did not open Atlas. Open it from the Start menu.");
            0
        }
        Ok(install::Launched::Started) => 0,
    }
}

/// A switch on the command line, in any letter case (`/S`, `/s`).
fn has_switch(args: &[std::ffi::OsString], name: &str) -> bool {
    args.iter().any(|a| a.to_string_lossy().eq_ignore_ascii_case(name))
}

/// The same for removing: no window, the installer's own uninstaller does the work.
fn windowless_remove(dir: &std::path::Path) -> i32 {
    let mut removed = false;
    let code = match uninstall::run_installer_uninstaller(dir, |_| {}) {
        Ok(()) => {
            removed = true;
            // Only after the installer's uninstaller finished: a failed one leaves the removers
            // in place so the person can run it again.
            uninstall::tidy(dir);
            0
        }
        Err(e) => {
            winsys::message("Uninstall Atlas", &e.message());
            1
        }
    };
    if let Ok(me) = std::env::current_exe() {
        uninstall::erase_my_copy_later(&me, removed.then_some(dir));
    }
    code
}

fn main() {
    // First, before Tauri or anything else loads a library by name: only System32 is searched,
    // never this program's folder, the current folder or PATH.
    winsys::search_safe_dirs_only();
    let me = std::env::current_exe().unwrap_or_default();
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match uninstall::launch_for(&me, &args) {
        Launch::PassOn => std::process::exit(uninstall::pass_on(&me, &winsys::command_line())),
        Launch::RemoverFirstStep => {
            // The folder comes from where Atlas is installed, never from where this file runs.
            let Some(dir) = uninstall::remove_target(&me) else {
                winsys::message("Uninstall Atlas", &uninstall::RemoveError::NotInstalledHere.message());
                std::process::exit(1);
            };
            if uninstall::hand_on(&me, &dir).is_ok() {
                return;
            }
            // Could not make the temporary copy: remove from here (this file stays behind).
            window(Mode::Uninstall, dir);
        }
        Launch::RemoverWindow(dir) => window(Mode::Uninstall, dir),
        Launch::Install => {
            let quiet = has_switch(&args, "/S");
            if quiet || !webview2_installed() {
                std::process::exit(windowless_install(quiet, has_switch(&args, "/R")));
            }
            window(Mode::Install, install::install_dir());
        }
    }
}

fn window(mode: Mode, dir: PathBuf) {
    if mode == Mode::Uninstall {
        // This process must not keep the folder it is about to remove as its working folder.
        install::leave_folder(&dir);
    }
    if mode == Mode::Uninstall && !uninstall::is_install_dir(&dir) {
        winsys::message("Uninstall Atlas", &uninstall::RemoveError::NotInstalledHere.message());
        std::process::exit(1);
    }
    if mode == Mode::Uninstall && !webview2_installed() {
        std::process::exit(windowless_remove(&dir));
    }
    let setup = Setup::new(mode, dir);
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
            state::retry,
            state::close_atlas_and_continue,
            state::begin_uninstall,
            state::cancel,
            state::finish,
        ])
        .setup(move |app| {
            // Here, not before the builder: this hook runs only once the single-instance check
            // has passed, so a second Setup that is about to exit never reads or writes anything.
            setup.start();
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
