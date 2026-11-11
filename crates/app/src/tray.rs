//! The tray icon (Windows notification area, macOS menu bar): a menu that reads "Today: N
//! tokens" and a tooltip that adds "~$X est." (see `atlas_core::readout`), a left click that opens
//! Atlas, and the opt-in close-to-tray.
//!
//! The numbers come from the usage engine's own queries (headline tokens, estimated
//! cost). They refresh when the usage cache says it changed, with a slow timer as the
//! fallback (it also carries the readout across midnight). All of it runs on one small
//! background thread; the UI thread only builds the icon once.

use std::sync::mpsc::{channel, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use atlas_core::readout;
use atlas_core::usage::State as UsageState;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::{AppState, Leave};
use crate::usage::Signal;

pub const TRAY_ID: &str = "atlas";
/// Refresh even when nothing announced a change (midnight, a missed event).
const FALLBACK: Duration = Duration::from_secs(60);
/// A burst of change events becomes one refresh.
const DEBOUNCE: Duration = Duration::from_millis(400);
const MAX_BURST: Duration = Duration::from_secs(2);

/// Managed state; present only when the icon was created (close-to-tray needs it).
pub struct Tray;

/// Bring the main window forward, the way a second launch does. Ignored while the launch
/// intro still owns the start (the window is not shown yet).
pub fn focus_main(app: &AppHandle) {
    if app.try_state::<crate::intro::Intro>().is_some_and(|i| i.owns_window()) {
        return;
    }
    if let Some(w) = app.get_webview_window("main") {
        // macOS: a window closed with "keep running when closed" on also left the Dock.
        #[cfg(target_os = "macos")]
        let _ = app.set_dock_visibility(true);
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// An editor holds edits that are not saved and a quit was asked for: bring the window forward and
/// let the page ask. "Discard" there calls `leave_app`.
pub fn ask_quit(app: &AppHandle) {
    focus_main(app);
    let _ = app.emit(crate::state::QUIT_ASK_EVENT, ());
}

/// Quit from the tray menu, asking first when there are unsaved edits.
fn quit_or_ask(app: &AppHandle) {
    let ask = app.try_state::<Arc<AppState>>().is_some_and(|s| s.leave_decision(true) == Leave::Ask);
    if ask {
        ask_quit(app);
    } else {
        app.exit(0);
    }
}

/// The text for right now: (menu line, tooltip). The menu shows tokens only; the tooltip is
/// the hover and adds the estimated money.
fn line_for(state: &AppState) -> (String, String) {
    let same = |s: &str| (s.to_string(), s.to_string());
    let Ok(engine) = state.usage.engine() else { return same(readout::WAITING) };
    let status = engine.status();
    if status.state == UsageState::Error && !status.first_index_done {
        return same("Atlas: usage is unavailable");
    }
    if !status.first_index_done {
        return same(readout::WAITING);
    }
    match engine.today() {
        Ok(p) => (readout::today_line(&p), readout::today_hover(&p)),
        Err(_) => same(readout::WAITING),
    }
}

pub fn install(app: &AppHandle, state: &Arc<AppState>) -> tauri::Result<()> {
    let today = MenuItem::with_id(app, "today", readout::WAITING, false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Atlas", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", if cfg!(target_os = "macos") { "Quit Atlas" } else { "Quit" }, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&today, &PredefinedMenuItem::separator(app)?, &open, &quit])?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(readout::WAITING)
        .menu(&menu)
        // Windows: a left click opens Atlas and the menu is the right click. macOS: a click on a
        // menu-bar icon opens its menu (Open Atlas is in it), as every menu-bar item does.
        .show_menu_on_left_click(cfg!(target_os = "macos"))
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "open" => focus_main(app),
            "quit" => quit_or_ask(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if cfg!(target_os = "macos") {
                return; // the click opened the menu
            }
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                focus_main(tray.app_handle());
            }
        });
    // macOS draws the menu-bar icon from the shape alone (a template image).
    #[cfg(target_os = "macos")]
    let builder = builder.icon(Image::from_bytes(include_bytes!("../icons/tray-template.png"))?).icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.icon(Image::from_bytes(include_bytes!("../icons/tray.png"))?);
    let icon = builder.build(app)?;
    app.manage(Tray);

    let (tx, rx) = channel::<()>();
    let tx = Mutex::new(tx);
    state.usage.signals.subscribe(move |sig| {
        if matches!(sig, Signal::Changed | Signal::Idle | Signal::Restarted | Signal::Recounted) {
            let _ = tx.lock().unwrap_or_else(|p| p.into_inner()).send(());
        }
    });

    let st = Arc::clone(state);
    std::thread::Builder::new()
        .name("tray-readout".into())
        .spawn(move || {
            let mut shown = (String::new(), String::new());
            loop {
                let text = line_for(&st);
                if text != shown {
                    let _ = icon.set_tooltip(Some(text.1.as_str()));
                    let _ = today.set_text(&text.0);
                    shown = text;
                }
                match rx.recv_timeout(FALLBACK) {
                    Ok(()) => {
                        let burst = Instant::now();
                        while burst.elapsed() < MAX_BURST && rx.recv_timeout(DEBOUNCE).is_ok() {}
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map(|_| ())
        .map_err(tauri::Error::Io)
}

/// Remove the icon at exit so Windows does not leave a ghost in the notification area.
pub fn remove(app: &AppHandle) {
    let _ = app.remove_tray_by_id(TRAY_ID);
}
