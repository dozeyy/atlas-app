//! In-app updates: look for a newer release, and, only when the person says so, download it,
//! check its signature, install it and start the new version.
//!
//! Nothing here runs by itself. The page asks (`update_check`) a few seconds after its first
//! paint and every six hours after that; it installs only on a click (`update_install`). The
//! check is one small request for `latest.json` on the project's GitHub releases; it carries no
//! data about the person or their chats.
//!
//! The package is the same NSIS installer (Windows) or app archive (macOS) the release makes,
//! signed with the project's updater key. The public half of that key is in tauri.conf.json;
//! a download that does not match its signature is refused before anything is touched.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, Url};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

use crate::state::AppState;
use crate::tray;

/// The GitHub repository whose latest release carries `latest.json`. The one place to change
/// it if the project moves.
pub const REPO: &str = "dozeyy/atlas";

/// Download progress for the icon's ring: `{ downloaded, total }` (total is null when the
/// server does not say) and, once the file is down, `{ installing: true }`.
pub const PROGRESS_EVENT: &str = "atlas://update/progress";

fn endpoint() -> String {
    // Test hook: point the check at a local server. Debug builds, and release builds made with
    // the `dev-update` feature, honor it; the shipped build never does.
    #[cfg(any(debug_assertions, feature = "dev-update"))]
    if let Some(url) = std::env::var("ATLAS_UPDATE_URL").ok().filter(|u| !u.trim().is_empty()) {
        return url;
    }
    format!("https://github.com/{REPO}/releases/latest/download/latest.json")
}

#[derive(Default)]
pub struct Updates {
    /// The update the last check found, kept for the install click.
    found: Mutex<Option<Update>>,
    busy: AtomicBool,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    /// The release notes, if the release has any.
    pub notes: Option<String>,
    pub current: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    installing: bool,
}

/// One plain sentence per failure; the details go to the log, never to the screen.
fn plain(e: &Error) -> String {
    match e {
        Error::Minisign(_) | Error::Base64(_) | Error::SignatureUtf8(_) => {
            "The update did not pass its safety check, so it was not installed."
        }
        Error::Reqwest(_) | Error::Network(_) | Error::ReleaseNotFound | Error::TargetNotFound(_) | Error::TargetsNotFound(_) => {
            "Could not reach the update server."
        }
        _ => "The update did not work.",
    }
    .to_string()
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    let url: Url = endpoint().parse().map_err(|_| "The update address is not valid.".to_string())?;
    let handle = app.clone();
    app.updater_builder()
        .endpoints(vec![url])
        .map_err(|e| {
            eprintln!("[atlas] update: endpoint refused: {e}");
            "The update address is not allowed.".to_string()
        })?
        // The installer replaces the running program: put everything away first, the way a
        // normal quit does, so the new copy starts from a clean cache and no ghost tray icon.
        .on_before_exit(move || {
            if let Some(state) = handle.try_state::<Arc<AppState>>() {
                state.shutdown();
            }
            tray::remove(&handle);
        })
        .build()
        .map_err(|e| {
            eprintln!("[atlas] update: could not start the updater: {e}");
            "The update did not work.".to_string()
        })
}

/// Ask whether a newer version exists. `None` is "you are up to date". An error is one plain
/// sentence; the automatic checks ignore it, the Settings button shows it.
#[tauri::command]
pub async fn update_check(app: AppHandle, hub: State<'_, Arc<Updates>>) -> Result<Option<UpdateInfo>, String> {
    let updater = updater(&app)?;
    match updater.check().await {
        Ok(Some(u)) => {
            let info = UpdateInfo { version: u.version.clone(), notes: u.body.clone().filter(|b| !b.trim().is_empty()), current: u.current_version.clone() };
            *hub.found.lock().unwrap_or_else(|p| p.into_inner()) = Some(u);
            eprintln!("[atlas] update: {} is available (this is {})", info.version, info.current);
            Ok(Some(info))
        }
        Ok(None) => {
            *hub.found.lock().unwrap_or_else(|p| p.into_inner()) = None;
            Ok(None)
        }
        Err(e) => {
            eprintln!("[atlas] update: check failed: {e}");
            Err(plain(&e))
        }
    }
}

/// Download the update found by the last check, verify it, install it and start the new
/// version. On Windows the installer takes over (passive: a small progress window, no
/// questions) and Atlas exits; it comes back as the new version. Progress goes out as
/// `PROGRESS_EVENT`. Returns only on failure.
#[tauri::command]
pub async fn update_install(app: AppHandle, hub: State<'_, Arc<Updates>>) -> Result<(), String> {
    let Some(update) = hub.found.lock().unwrap_or_else(|p| p.into_inner()).clone() else {
        return Err("There is no update to install.".to_string());
    };
    if hub.busy.swap(true, Ordering::SeqCst) {
        return Err("An update is already on its way.".to_string());
    }
    let result = run_install(&app, &update).await;
    hub.busy.store(false, Ordering::SeqCst);
    result
}

async fn run_install(app: &AppHandle, update: &Update) -> Result<(), String> {
    let mut downloaded = 0u64;
    let sink = app.clone();
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = sink.emit(PROGRESS_EVENT, Progress { downloaded, total, installing: false });
            },
            || {},
        )
        .await
        .map_err(|e| {
            eprintln!("[atlas] update: download refused or failed: {e}");
            plain(&e)
        })?;
    let _ = app.emit(PROGRESS_EVENT, Progress { downloaded: bytes.len() as u64, total: Some(bytes.len() as u64), installing: true });
    let update = update.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = installed {
        eprintln!("[atlas] update: install failed: {e}");
        return Err("The update could not be installed.".to_string());
    }
    // Windows has already exited by now (the installer restarts Atlas). Elsewhere the new
    // version is in place and only needs a relaunch.
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_default_address_is_the_latest_release_of_the_repo() {
        // (Debug test builds honor ATLAS_UPDATE_URL; the test process does not set it.)
        if std::env::var_os("ATLAS_UPDATE_URL").is_none() {
            assert_eq!(endpoint(), "https://github.com/dozeyy/atlas/releases/latest/download/latest.json");
        }
    }

    #[test]
    fn failures_are_plain_sentences() {
        assert_eq!(plain(&Error::ReleaseNotFound), "Could not reach the update server.");
        assert_eq!(
            plain(&Error::SignatureUtf8("x".into())),
            "The update did not pass its safety check, so it was not installed."
        );
        assert_eq!(plain(&Error::EmptyEndpoints), "The update did not work.");
    }
}
