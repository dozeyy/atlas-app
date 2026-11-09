//! The screenshot tour for the macOS proof run (`tools/mac-check.sh`, `.github/workflows/mac-check.yml`).
//!
//! Debug builds only: with `ATLAS_SHOT_TOUR=<folder>` set, the page gets `window.__ATLAS_TOUR__`
//! and walks every page (`src/lib/shotTour.ts`), calling `tour_step` to size the window, to take a
//! picture of it (the driver script takes it, see `capture`) and, at the end, to write `done.txt`. A
//! release build compiles none of this: the flag is never set and the command only says no.

#[cfg(debug_assertions)]
use std::path::PathBuf;

/// Where the pictures go, when the tour was asked for. Never in a release build.
#[cfg(debug_assertions)]
pub fn folder() -> Option<PathBuf> {
    std::env::var_os("ATLAS_SHOT_TOUR").filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Turns the page's name for a picture into a safe file stem: letters, digits and dashes.
#[cfg(debug_assertions)]
fn stem(name: &str) -> Option<String> {
    let ok = !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| name.to_ascii_lowercase())
}

/// `action` is "size" (`arg` = "1280x800", logical), "capture" (`arg` = the picture's name),
/// "log" (`arg` = a line for the tour log) or "done".
#[tauri::command(async)]
pub fn tour_step(app: tauri::AppHandle, action: String, arg: String) -> Result<(), String> {
    #[cfg(debug_assertions)]
    {
        use std::io::Write;
        use tauri::Manager;
        let dir = folder().ok_or("The tour is off.")?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let log = |line: &str| {
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("tour.log")) {
                let _ = writeln!(f, "{line}");
            }
        };
        let w = app.get_webview_window("main").ok_or("No window.")?;
        match action.as_str() {
            "size" => {
                let (a, b) = arg.split_once('x').ok_or("Bad size.")?;
                let (Ok(width), Ok(height)) = (a.parse::<f64>(), b.parse::<f64>()) else { return Err("Bad size.".into()) };
                let _ = w.unmaximize();
                w.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
                let _ = w.center();
                let _ = w.set_focus();
                log(&format!("size {arg}"));
                Ok(())
            }
            "capture" => {
                let name = stem(&arg).ok_or("Bad name.")?;
                let _ = w.set_focus();
                capture(&w, &dir, &name)?;
                log(&format!("capture {name}"));
                Ok(())
            }
            "log" => {
                log(&arg.chars().filter(|c| !c.is_control()).take(300).collect::<String>());
                Ok(())
            }
            "done" => {
                log("done");
                std::fs::write(dir.join("done.txt"), b"done\n").map_err(|e| e.to_string())
            }
            _ => Err("Unknown step.".into()),
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = (app, action, arg);
        Err("Not available in this build.".into())
    }
}

/// Asks the driver script for a picture of the window and waits for it. The app never takes the
/// picture itself: `tools/mac-check.sh` watches `<folder>/req/` and runs `screencapture -R` from
/// the shell, which is the process macOS lets record the screen on a CI runner. The request is
/// the window's outer rectangle in screen points, "x,y,w,h", written whole (temp file + rename).
#[cfg(debug_assertions)]
fn capture(w: &tauri::WebviewWindow, dir: &std::path::Path, name: &str) -> Result<(), String> {
    let scale = w.scale_factor().map_err(|e| e.to_string())?;
    let pos = w.outer_position().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let size = w.outer_size().map_err(|e| e.to_string())?.to_logical::<f64>(scale);
    let rect = format!("{},{},{},{}", pos.x.round(), pos.y.round(), size.width.round(), size.height.round());
    let req = dir.join("req");
    std::fs::create_dir_all(&req).map_err(|e| e.to_string())?;
    let tmp = req.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, rect.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, req.join(format!("{name}.rect"))).map_err(|e| e.to_string())?;
    let png = dir.join(format!("{name}.png"));
    let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
    while std::time::Instant::now() < end {
        if png.is_file() && !req.join(format!("{name}.rect")).exists() {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    Err(format!("no picture for {name} after 20 s (is the driver watching {}?)", req.display()))
}
#[cfg(all(test, debug_assertions))]
mod tests {
    use super::stem;

    #[test]
    fn names_become_safe_file_stems() {
        assert_eq!(stem("01-Dashboard").as_deref(), Some("01-dashboard"));
        assert_eq!(stem("../etc/passwd"), None);
        assert_eq!(stem("a b"), None);
        assert_eq!(stem(""), None);
        assert_eq!(stem(&"x".repeat(65)), None);
    }
}
