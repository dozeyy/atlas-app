// Release builds on Windows are a GUI app (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod state;
mod usage;

use std::sync::Arc;
use std::time::Duration;

use atlas_core::launch::LaunchArgs;
use state::AppState;
use tauri::{Manager, RunEvent, WebviewWindowBuilder, WindowEvent};

fn main() {
    let launch = LaunchArgs::parse(std::env::args_os().skip(1));
    for w in &launch.warnings {
        eprintln!("[atlas] {w}");
    }
    let state = AppState::new(launch);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
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
            usage::usage_status,
            usage::usage_dashboard,
            usage::usage_timeline,
            usage::sessions_list,
            usage::session_detail,
            usage::usage_agent_detail,
            usage::usage_by_item,
            usage::session_transcript,
            usage::usage_filter_options,
            usage::usage_reindex,
            usage::pricing_get,
            usage::pricing_reveal,
        ])
        .on_window_event(|window, event| {
            if let WindowEvent::Focused(focused) = event {
                window.state::<Arc<AppState>>().usage.focus(*focused);
            }
        })
        .setup(|app| {
            let state = app.state::<Arc<AppState>>().inner().clone();

            // Window: the front end gets its settings in a script that runs before
            // any page code, so the first paint is already the right theme and view.
            let info = state.info();
            let boot = serde_json::to_string(&info)?;
            let mut cfg = app.config().app.windows[0].clone();
            if !info.backdrop {
                // No Mica (Windows 10): an opaque window, not a see-through one.
                cfg.transparent = false;
                cfg.window_effects = None;
            }
            let window = WebviewWindowBuilder::from_config(app.handle(), &cfg)?
                .initialization_script(format!("window.__ATLAS_BOOT__ = {boot};"))
                .build()?;
            commands::apply_window_theme(&window, info.settings.theme);

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
