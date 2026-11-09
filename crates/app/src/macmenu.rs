//! The macOS menu bar: Atlas, Edit, View, Window and Help, the way every Mac app has them.
//!
//! Without an Edit menu, Cmd+C, Cmd+V, Cmd+X, Cmd+A and Cmd+Z do nothing in a text field of a
//! WKWebView, so the Edit items are the standard (predefined) ones that route to the focused
//! field. The Atlas items that open a page or a sheet send `MENU_EVENT` with their id to the page,
//! which does the same thing as the in-app menu (Settings, About and the Help sheets).
//!
//! On purpose there are no menu shortcuts for Cmd+1..7 or Cmd+B: the page owns those keys, and a
//! menu accelerator would take them before the page sees them.

use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter};

/// Sent to the page with the id of the picked item (see `src/lib/ipc.ts`).
pub const MENU_EVENT: &str = "atlas://menu";

/// Menu ids the page understands: "settings" and the Help sheet ids of `src/lib/appMenu.ts`.
const PREFIX: &str = "menu:";

fn item(app: &AppHandle, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<tauri::Wry>> {
    MenuItem::with_id(app, format!("{PREFIX}{id}"), text, true, accel)
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let sep = || PredefinedMenuItem::separator(app);
    let atlas = Submenu::with_items(
        app,
        "Atlas",
        true,
        &[
            &item(app, "about", "About Atlas", None)?,
            &sep()?,
            &item(app, "settings", "Settings...", Some("Cmd+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some("Hide Atlas"))?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &PredefinedMenuItem::quit(app, Some("Quit Atlas"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let view = Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, Some("Zoom"))?,
            &sep()?,
            &PredefinedMenuItem::close_window(app, None)?,
            &sep()?,
            &PredefinedMenuItem::bring_all_to_front(app, None)?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Help",
        true,
        &[
            &item(app, "guide", "How to use Atlas", None)?,
            &item(app, "shortcuts", "Keyboard shortcuts", None)?,
            &sep()?,
            &item(app, "privacy", "Privacy", None)?,
            &item(app, "terms", "Terms of service", None)?,
            &sep()?,
            &item(app, "report", "Report a problem", None)?,
        ],
    )?;
    Menu::with_items(app, &[&atlas, &edit, &view, &window, &help])
}

/// An Atlas item was picked: bring the window forward and tell the page.
pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let Some(id) = event.id().as_ref().strip_prefix(PREFIX) else { return };
    crate::tray::focus_main(app);
    let _ = app.emit(MENU_EVENT, id.to_string());
}
