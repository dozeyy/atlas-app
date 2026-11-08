// Release builds on Windows are a GUI app (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod intro;
mod state;

use std::sync::Arc;
use std::time::Duration;

use atlas_core::launch::LaunchArgs;
use state::AppState;
use tauri::{Manager, RunEvent, WebviewWindowBuilder};

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
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // While the intro still owns the launch, the main window is not shown yet.
            if app.try_state::<intro::Intro>().is_some_and(|i| i.is_active()) {
                return;
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }));
    }
    let app = builder
        .plugin(tauri_plugin_dialog::init())
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
        .invoke_handler(tauri::generate_handler![
            commands::get_app_info,
            commands::update_settings,
            commands::set_sandbox,
            commands::choose_config_dir,
            commands::clear_config_dir,
            commands::frontend_ready,
            intro::splash_ready,
            intro::splash_covered,
            intro::intro_skip,
            intro::intro_main_painted,
            intro::splash_done,
        ])
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
            if intro_on {
                script.push_str("window.__ATLAS_INTRO__ = true;");
                intro::arm(app.handle());
            }
            let window = WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                .initialization_script(script)
                .build()?;
            commands::apply_window_theme(&window, info.settings.theme);
            if intro_on {
                eprintln!("[atlas] intro: main window built at {}", intro::stamp(app.handle()));
            }

            if intro_on {
                intro::fit_splash(app.handle(), &window, info.backdrop);
                intro::watch(app.handle());
            }

            // Failsafe: never leave the window invisible if the page fails to load.
            let w = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(6));
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                }
            });

            // Sandbox Mode copies in the background; the window never waits for it.
            let handle = app.handle().clone();
            let st = Arc::clone(&state);
            std::thread::spawn(move || {
                st.sweep_stale_sandboxes();
                if st.info().sandbox.enabled {
                    st.restart_sandbox_if_wanted(&handle);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Atlas");

    app.run(move |_handle, event| {
        if let RunEvent::Exit = event {
            state.shutdown();
        }
    });
}
