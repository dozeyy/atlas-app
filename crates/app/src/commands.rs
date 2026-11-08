//! Tauri commands: the only door between the page and Rust.

use std::sync::Arc;

use atlas_core::settings::Theme;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::state::{AppInfo, AppState, SettingsPatch};

type Shared<'a> = State<'a, Arc<AppState>>;

/// System follows the OS; Light / Dark pin the window (and so Mica / vibrancy).
pub fn apply_window_theme(window: &WebviewWindow, theme: Theme) {
    let t = match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    };
    let _ = window.set_theme(t);
}

#[tauri::command]
pub fn get_app_info(state: Shared) -> AppInfo {
    state.info()
}

// `async` here means "not on the UI thread": these write files.
#[tauri::command(async)]
pub fn update_settings(app: AppHandle, state: Shared, patch: SettingsPatch) -> AppInfo {
    let theme = patch.theme;
    let info = state.update_settings(patch);
    if let (Some(t), Some(w)) = (theme, app.get_webview_window("main")) {
        apply_window_theme(&w, t);
    }
    info
}

#[tauri::command(async)]
pub fn set_sandbox(state: Shared, enabled: bool) -> AppInfo {
    state.set_sandbox(enabled)
}

/// Opens the folder picker. Returns the new info, or the unchanged info when the
/// picker is cancelled.
#[tauri::command]
pub async fn choose_config_dir(app: AppHandle, state: Shared<'_>) -> Result<AppInfo, String> {
    let picked = app
        .dialog()
        .file()
        .set_title("Choose your Claude folder")
        .blocking_pick_folder();
    match picked {
        Some(p) => {
            let path = p.into_path().map_err(|e| e.to_string())?;
            Ok(state.set_config_override(Some(path.to_string_lossy().into_owned())))
        }
        None => Ok(state.info()),
    }
}

#[tauri::command(async)]
pub fn clear_config_dir(state: Shared) -> AppInfo {
    state.set_config_override(None)
}

/// The page has painted: show the window and record the time.
#[tauri::command]
pub fn frontend_ready(app: AppHandle, state: Shared) -> u64 {
    let ms = state.mark_first_paint();
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
    eprintln!("[atlas] startup: {ms} ms to first paint");
    // The page booted with first_paint_ms unset; tell it the number now.
    let _ = app.emit(crate::state::INFO_EVENT, state.info());
    ms
}
