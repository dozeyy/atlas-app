// Release builds on Windows are a GUI app (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod history;
mod intro;
// Built everywhere so it stays compiled and linted; only macOS installs it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod macmenu;
mod now;
mod search;
mod setup_service;
mod state;
mod tour;
mod tray;
mod update;
mod usage;
#[cfg(windows)]
mod winframe;

use std::sync::Arc;
use std::time::Duration;

use atlas_core::launch::LaunchArgs;
use state::AppState;
use tauri::{Emitter, LogicalSize, Manager, RunEvent, WebviewWindow, WebviewWindowBuilder, WindowEvent};

/// Smallest window the layout is designed for (same as `minWidth`/`minHeight` in
/// tauri.conf.json). The OS only applies a minimum to dragging an edge, not to a
/// size that is set from code or restored from the last session, so it is also
/// enforced here.
const MIN_WIDTH: f64 = 900.0;
const MIN_HEIGHT: f64 = 600.0;

/// The page's caption button shows Restore while maximized. Told on change only, so an edge drag
/// sends nothing to the page (it used to ask over IPC on every resize step).
pub const MAXIMIZED_EVENT: &str = "atlas://window/maximized";
static WAS_MAXIMIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn on_resized(w: &WebviewWindow) {
    let max = w.is_maximized().unwrap_or(false);
    if WAS_MAXIMIZED.swap(max, std::sync::atomic::Ordering::Relaxed) != max {
        let _ = w.emit(MAXIMIZED_EVENT, max);
    }
    enforce_min_size(w);
}

fn enforce_min_size(w: &WebviewWindow) {
    if w.is_minimized().unwrap_or(false) || w.is_maximized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
        return;
    }
    let (Ok(scale), Ok(inner)) = (w.scale_factor(), w.inner_size()) else { return };
    let size = inner.to_logical::<f64>(scale);
    if size.width == 0.0 || size.height == 0.0 {
        return; // minimizing reports an empty size on some systems
    }
    if size.width + 0.5 < MIN_WIDTH || size.height + 0.5 < MIN_HEIGHT {
        let _ = w.set_size(LogicalSize::new(size.width.max(MIN_WIDTH), size.height.max(MIN_HEIGHT)));
    }
}

fn main() {
    let launch = LaunchArgs::parse(std::env::args_os().skip(1));
    for w in &launch.warnings {
        eprintln!("[atlas] {w}");
    }
    let state = AppState::new(launch);

    let mut builder = tauri::Builder::default();
    // One Atlas per user: a second launch focuses the running window and exits, and
    // never plays the intro (it dies before setup). Must be the first plugin.
    // ATLAS_MULTI=1 lifts the lock for parallel dev and test runs.
    if std::env::var_os("ATLAS_MULTI").is_none() {
        // (While the intro still owns the launch the main window is not shown yet;
        // `focus_main` leaves it alone then.)
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| tray::focus_main(app)));
    }
    // macOS: the standard menu bar (Atlas, Edit, View, Window, Help). Its Edit menu is what makes
    // Cmd+C / Cmd+V work in text fields. Windows has no menu bar (the page draws its own menu).
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(macmenu::build).on_menu_event(macmenu::on_event);
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                // The splash is a fixed overlay, never a window to remember.
                .with_denylist(&[intro::SPLASH])
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .build(),
        )
        .manage(Arc::clone(&state))
        .manage(Arc::new(setup_service::SetupHub::default()))
        .manage(Arc::new(update::Updates::default()))
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::update_settings,
            commands::set_sandbox,
            commands::choose_config_dir,
            commands::clear_config_dir,
            commands::open_config_dir,
            commands::open_data_dir,
            commands::uninstall_available,
            commands::uninstall_atlas,
            commands::frontend_ready,
            commands::window_control,
            commands::window_maximized,
            commands::frame_ack,
            commands::set_unsaved,
            commands::leave_app,
            usage::usage_status,
            usage::usage_dashboard,
            usage::usage_timeline,
            usage::sessions_list,
            usage::session_detail,
            usage::usage_agent_detail,
            usage::session_receipt,
            usage::usage_by_item,
            usage::usage_wrapped_habits,
            commands::wrapped_save_card,
            usage::session_transcript,
            usage::usage_filter_options,
            usage::usage_reindex,
            usage::pricing_get,
            usage::pricing_reveal,
            usage::session_open_folder,
            history::history_overview,
            history::history_events,
            history::history_item,
            history::history_diff,
            history::history_copy_version,
            history::history_save_copy,
            history::history_open_folder,
            history::settings_overview,
            now::now_snapshot,
            search::search_chats,
            search::search_status,
            intro::splash_ready,
            intro::splash_covered,
            intro::intro_skip,
            intro::intro_main_painted,
            intro::splash_done,
            update::update_check,
            update::update_install,
            tour::tour_step,
            setup_service::setup_snapshot,
            setup_service::setup_cost,
            setup_service::setup_read_source,
            setup_service::setup_reveal,
            setup_service::setup_item_raw,
            setup_service::setup_validate,
            setup_service::setup_skill_files,
            setup_service::setup_open_file,
            setup_service::setup_duplicate,
            setup_service::setup_save,
            setup_service::setup_delete,
            setup_service::setup_undo,
            setup_service::setup_create_draft,
            setup_service::setup_create,
            setup_service::setup_validate_draft,
        ])
        .on_window_event(|window, event| match event {
            WindowEvent::Focused(focused) => window.state::<Arc<AppState>>().usage.focus(*focused),
            // Windows: close-to-tray (opt-in) hides instead of quitting, but only when the icon
            // exists, or the window could never be brought back.
            // macOS: closing the window never quits (Cmd+Q does, as in every Mac app). Atlas stays
            // in the Dock and the Dock icon brings the window back (RunEvent::Reopen); with
            // "keep running when closed" on it also leaves the Dock and lives in the menu bar.
            WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                let state = window.state::<Arc<AppState>>();
                let tray = window.try_state::<tray::Tray>().is_some();
                let hides = cfg!(target_os = "macos") || (state.close_to_tray() && tray);
                // The close would end Atlas while an editor holds edits that are not saved:
                // keep the window and let the page ask. (Hiding loses nothing.)
                if crate::state::Leave::Ask == state.leave_decision(!hides) {
                    api.prevent_close();
                    tray::ask_quit(window.app_handle());
                } else if hides {
                    api.prevent_close();
                    let _ = window.hide();
                    state.usage.focus(false);
                    #[cfg(target_os = "macos")]
                    if state.close_to_tray() && tray {
                        let _ = window.app_handle().set_dock_visibility(false);
                    }
                }
            }
            _ => {}
        })
        .setup(|app| {
            let state = app.state::<Arc<AppState>>().inner().clone();

            // Window: the front end gets its settings in a script that runs before
            // any page code, so the first paint is already the right theme and view.
            let info = state.info();
            let boot = serde_json::to_string(&info)?;
            // Launch intro: the splash is built first so its page starts loading while
            // the main window is still being created.
            let want_intro = info.settings.launch_animation
                && std::env::var_os("ATLAS_NO_INTRO").is_none();
            app.manage(intro::Intro::new(false));
            let mut intro_on = false;
            if want_intro {
                eprintln!("[atlas] intro: setup begins at {}", intro::stamp(app.handle()));
                match intro::build_splash(app.handle()) {
                    Ok(_) => {
                        intro_on = true;
                        app.state::<intro::Intro>().activate();
                    }
                    Err(e) => eprintln!("[atlas] intro: splash window failed: {e}"),
                }
            }
            if intro_on {
                eprintln!("[atlas] intro: splash window built at {}", intro::stamp(app.handle()));
            }
            let mut cfg = app.config().app.windows[0].clone();
            if !info.backdrop {
                // No Mica (Windows 10): an opaque window, not a see-through one.
                cfg.transparent = false;
                cfg.window_effects = None;
            }
            let mut script = format!("window.__ATLAS_BOOT__ = {boot};");
            // The macOS proof run's screenshot tour (tour.rs). Debug builds only.
            #[cfg(debug_assertions)]
            if tour::folder().is_some() {
                script.push_str("window.__ATLAS_TOUR__ = true;");
            }
            if intro_on {
                script.push_str("window.__ATLAS_INTRO__ = true;");
                intro::arm(app.handle());
            }
            let window = WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                .initialization_script(script)
                .min_inner_size(MIN_WIDTH, MIN_HEIGHT)
                .build()?;
            commands::apply_window_theme(&window, info.settings.theme);
            if intro_on {
                eprintln!("[atlas] intro: main window built at {}", intro::stamp(app.handle()));
            }

            if intro_on {
                intro::fit_splash(app.handle(), &window, info.backdrop);
                intro::watch(app.handle());
            }

            // The window-state plugin may have restored a size from a session that
            // ended small, and a program can resize the window to anything.
            enforce_min_size(&window);
            // Edge drags keep the content still, as a native window does (winframe.rs).
            #[cfg(windows)]
            winframe::install(&window);
            // The window-state plugin can restore the window maximized inside `.build()`, before
            // this handler exists: start from what the window is now, or the first restore would
            // look like no change and the caption button would stay on Restore.
            WAS_MAXIMIZED.store(window.is_maximized().unwrap_or(false), std::sync::atomic::Ordering::Relaxed);
            let w = window.clone();
            window.on_window_event(move |e| {
                if matches!(e, WindowEvent::Resized(_)) {
                    on_resized(&w);
                }
            });

            // The Atlas installer asks a running Atlas to leave through this (the window's close
            // button only hides it when close-to-tray is on). It runs the normal quit: the same
            // path as the tray's Quit, so the cache is closed cleanly on the way out.
            if let Ok(exe) = std::env::current_exe() {
                let handle = app.handle().clone();
                if !atlas_core::quit_signal::listen(&exe, move || {
                    eprintln!("[atlas] quit requested by the installer");
                    handle.exit(0);
                }) {
                    eprintln!("[atlas] quit signal: not available");
                }
            }

            // Failsafe: never leave the window invisible if the page fails to load.
            let w = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(6));
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                }
            });

            // Background changes (a sandbox copy finishing) reach the page as events.
            state.usage.attach(app.handle().clone());
            // The tray readout and the chat index both follow the usage engine.
            search::wire(&state);
            if let Err(e) = tray::install(app.handle(), &state) {
                eprintln!("[atlas] tray: not available: {e}");
            }
            let handle = app.handle().clone();
            state.set_notifier(Arc::new(move |info| {
                let _ = handle.emit(state::INFO_EVENT, info);
            }));
            state.start_heartbeat();

            // Sandbox Mode copies in the background; the window never waits for it.
            let st = Arc::clone(&state);
            std::thread::spawn(move || {
                st.sweep_stale_sandboxes();
                if st.info().sandbox.enabled {
                    st.restart_sandbox_if_wanted();
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Atlas");

    app.run(move |handle, event| match event {
        // Cmd+Q / the last window closing, with edits not saved: hold it back and let the page ask.
        // (A quit the program asks for itself, `exit(code)`, is not held back here.)
        RunEvent::ExitRequested { api, code: None, .. } if state.has_unsaved() => {
            api.prevent_exit();
            tray::ask_quit(handle);
        }
        RunEvent::Exit => {
            tray::remove(handle);
            state.shutdown();
        }
        // macOS: a click on the Dock icon (or opening Atlas again) while its window is hidden.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { has_visible_windows: false, .. } => tray::focus_main(handle),
        _ => {}
    });
}
