//! Launch intro: a transparent splash window over the desktop plays the logo
//! animation while the (hidden) main window loads, then hands over to it.
//!
//! Flow (cold launch only; a second launch is stopped by the single-instance lock
//! before any of this runs):
//!  1. setup builds the splash hidden, then the main window hidden (the window-state
//!     plugin restores its rect), and fits the splash to the main window's visible
//!     rect (DWM extended frame bounds, so the invisible resize border is excluded).
//!  2. the splash page paints nothing yet and calls `splash_ready`: Rust shows the
//!     splash and the page starts its timeline.
//!  3. the page reaches the flat clay screen and calls `splash_covered`.
//!  4. once the clay screen is up AND the main page has painted (`frontend_ready`),
//!     Rust shows the main window UNDER the topmost splash, the main page lands its
//!     first frame and calls `intro_main_painted`, and Rust tells the splash to
//!     finish (a hole opens in the clay from the middle, or a fade, or a cut).
//!  5. the splash reports its frame timing with `splash_done` and Rust closes it.
//!
//! Anything that goes wrong (splash page never loads, never finishes) is caught by
//! watchdogs that close the splash and show the main window: the app never waits on
//! the animation. Something of Atlas is on screen at every moment: the main window is
//! shown before the splash closes, and a splash abandoned before the main page is ready
//! stays up until it is (bounded by `ORPHAN_LIMIT`).

use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::state::AppState;
use std::sync::Arc;

pub const SPLASH: &str = "splash";

/// The splash page must have loaded by then (counted from setup) or the intro is abandoned.
/// Windows shows it ~250 ms after launch; a first launch on macOS needs ~1.6 s just to start
/// WebKit for it (GitHub macOS runner, 2026-11-10), so 1.5 s abandoned every first launch there.
const SPLASH_SHOW_DEADLINE: Duration = Duration::from_millis(3000);
/// The intro must be over this long after the splash showed (it takes ~2.2 s; a GitHub macOS
/// runner needs 1.5-3 s more just to get the first frames of each newly shown window, and the
/// splash waits out up to 2.5 s of stalls, `STALL_HOLD_MAX` in src/splash/timeline.ts), however
/// it got stuck. Counted from the show, not from setup: a slow WebKit start must not eat into it.
const INTRO_RUN_LIMIT: Duration = Duration::from_millis(10500);
/// An abandoned splash waits at most this long for the main page before both give way.
const ORPHAN_LIMIT: Duration = Duration::from_millis(3000);

#[derive(Default)]
struct Flow {
    /// The intro is running (or about to). False once it ended or never started.
    active: bool,
    /// The main window was built with the "pending" intro state.
    armed: bool,
    rect_set: bool,
    splash_shown: bool,
    shown_at: Option<std::time::Instant>,
    /// The intro was abandoned before the main page was ready: the splash stays up (covering
    /// the desktop) until the main window can be shown, so nothing blinks out in between.
    orphan: bool,
    main_ready: bool,
    covered: bool,
    reduced: bool,
    skipped: bool,
    revealing: bool,
    radius: f64,
    /// The splash's size in physical pixels (the page waits for its viewport to match).
    size: (u32, u32),
}

pub struct Intro {
    flow: Mutex<Flow>,
}

impl Intro {
    pub fn new(active: bool) -> Intro {
        Intro { flow: Mutex::new(Flow { active, ..Flow::default() }) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Flow> {
        self.flow.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Called once from setup when the splash window exists.
    pub fn activate(&self) {
        self.lock().active = true;
    }

    /// The intro is running or holding the screen: it shows the main window itself.
    pub fn owns_window(&self) -> bool {
        let f = self.lock();
        f.active || f.orphan
    }
}

/// "<ms since AppState was created> ms, epoch <unix ms>": the epoch lets a screen
/// capture's wall-clock timestamps line up with these log lines.
pub fn stamp(app: &AppHandle) -> String {
    let ms = app.state::<Arc<AppState>>().started.elapsed().as_millis();
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{ms} ms, epoch {epoch}")
}

fn since_start(app: &AppHandle) -> String {
    stamp(app)
}

/// Build the splash window, hidden. It is shown by `splash_ready`.
pub fn build_splash(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    // Test hook: force the reduced-motion path (or, with "0", the full one) without touching
    // the OS setting.
    let mut script = String::new();
    match std::env::var("ATLAS_REDUCE_MOTION").as_deref() {
        Ok("0") => script.push_str("window.__ATLAS_REDUCE__ = false;"),
        Ok(_) => script.push_str("window.__ATLAS_REDUCE__ = true;"),
        Err(_) => {}
    }
    // Diagnostics: the page logs its clock and frames through `intro_trace`.
    if tracing() {
        script.push_str("window.__ATLAS_INTRO_TRACE__ = true;");
    }
    WebviewWindowBuilder::new(app, SPLASH, WebviewUrl::App("splash.html".into()))
        .initialization_script(&script)
        .title("Atlas")
        .inner_size(480.0, 320.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .closable(false)
        .visible(false)
        .focused(true)
        .build()
}

/// The main window's visible rect in physical pixels: x, y, width, height.
fn visible_bounds(main: &WebviewWindow) -> Option<(i32, i32, u32, u32)> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::RECT;
        use windows_sys::Win32::Graphics::Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute};
        if let Ok(hwnd) = main.hwnd() {
            let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
            // SAFETY: `r` is a valid RECT and the size passed is its size.
            let hr = unsafe {
                DwmGetWindowAttribute(
                    hwnd.0 as _,
                    DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                    &mut r as *mut RECT as *mut _,
                    std::mem::size_of::<RECT>() as u32,
                )
            };
            if hr == 0 && r.right > r.left && r.bottom > r.top {
                return Some((r.left, r.top, (r.right - r.left) as u32, (r.bottom - r.top) as u32));
            }
        }
    }
    let p = main.outer_position().ok()?;
    let s = main.outer_size().ok()?;
    Some((p.x, p.y, s.width, s.height))
}

/// Put the splash exactly over the (hidden) main window and let it show.
pub fn fit_splash(app: &AppHandle, main: &WebviewWindow, backdrop: bool) {
    let intro = app.state::<Intro>();
    let Some(splash) = app.get_webview_window(SPLASH) else {
        abort(app);
        return;
    };
    let size = match visible_bounds(main) {
        Some((x, y, w, h)) => {
            // Position, size, position again: a move between monitors of different
            // scale can re-scale the window once.
            let _ = splash.set_position(PhysicalPosition::new(x, y));
            let _ = splash.set_size(PhysicalSize::new(w, h));
            let _ = splash.set_position(PhysicalPosition::new(x, y));
            eprintln!("[atlas] intro: splash rect {w}x{h} at {x},{y} ({})", stamp(app));
            (w, h)
        }
        None => {
            abort(app);
            return;
        }
    };
    let maximized = main.is_maximized().unwrap_or(false) || main.is_fullscreen().unwrap_or(false);
    let radius = if maximized {
        0.0
    } else if cfg!(target_os = "macos") {
        10.0
    } else if backdrop {
        8.0 // Windows 11 rounds its windows; Windows 10 does not
    } else {
        0.0
    };
    let mut f = intro.lock();
    f.radius = radius;
    f.size = size;
    f.rect_set = true;
}

/// Spawn the watchdogs. Call once, from setup.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SPLASH_SHOW_DEADLINE);
        {
            let intro = app.state::<Intro>();
            let f = intro.lock();
            if f.active && !f.splash_shown {
                drop(f);
                eprintln!("[atlas] intro: splash never painted, abandoning");
                abort(&app);
                return;
            }
        }
        loop {
            let left = {
                let intro = app.state::<Intro>();
                let f = intro.lock();
                if !f.active {
                    return;
                }
                let shown = f.shown_at.unwrap_or_else(std::time::Instant::now);
                INTRO_RUN_LIMIT.saturating_sub(shown.elapsed())
            };
            if left.is_zero() {
                eprintln!("[atlas] intro: overran {} ms after the splash showed, abandoning", INTRO_RUN_LIMIT.as_millis());
                abort(&app);
                return;
            }
            std::thread::sleep(left.min(Duration::from_millis(250)));
        }
    });
}

/// `ATLAS_INTRO_TRACE=1`: log the splash page's clock and the main thread's latency.
pub fn tracing() -> bool {
    std::env::var_os("ATLAS_INTRO_TRACE").is_some()
}

/// Diagnostics: how long the main (UI) thread takes to run a task, every 50 ms for 10 s.
/// On macOS WebKit composites and drives requestAnimationFrame from this thread.
pub fn probe_main_thread(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let end = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < end {
            let (tx, rx) = std::sync::mpsc::channel();
            let t = std::time::Instant::now();
            if app.run_on_main_thread(move || { let _ = tx.send(()); }).is_err() {
                return;
            }
            let _ = rx.recv();
            let ms = t.elapsed().as_millis();
            if ms >= 30 {
                eprintln!("[atlas] intro trace: main thread busy {ms} ms, answered at {}", stamp(&app));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

/// Diagnostics: one line from the splash page (only sent when tracing).
#[tauri::command(async)]
pub fn intro_trace(app: AppHandle, msg: String) {
    eprintln!("[atlas] intro trace: {msg} at {}", stamp(&app));
}

/// Stop the intro at once: close the splash and let the main window through.
pub fn abort(app: &AppHandle) {
    let intro = app.state::<Intro>();
    let (main_ready, armed) = {
        let mut f = intro.lock();
        if !f.active {
            return;
        }
        f.active = false;
        // Set in the same lock: a `main_ready` landing right after must see the hold.
        f.orphan = !f.main_ready;
        (f.main_ready, f.armed)
    };
    eprintln!("[atlas] intro: abort (main page ready: {main_ready}) at {}", stamp(app));
    if armed {
        eval_main(app, "window.__atlasIntroReveal&&window.__atlasIntroReveal(true,false)");
    }
    if main_ready {
        // The window first, then the splash: never a moment with neither on screen.
        show_main(app);
        close_splash(app);
        return;
    }
    // The main page is not ready: the splash stays until it is (`main_ready`), bounded.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(ORPHAN_LIMIT);
        let held = std::mem::take(&mut app.state::<Intro>().lock().orphan);
        if held {
            eprintln!("[atlas] intro: main page still not ready, showing the window anyway");
            show_main(&app);
            close_splash(&app);
        }
    });
}

fn close_splash(app: &AppHandle) {
    if let Some(s) = app.get_webview_window(SPLASH) {
        let _ = s.destroy();
    }
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn eval_main(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(js);
    }
}

fn eval_splash(app: &AppHandle, js: &str) {
    if let Some(w) = app.get_webview_window(SPLASH) {
        let _ = w.eval(js);
    }
}

/// The main page painted. Returns true when the intro will show the window itself.
pub fn main_ready(app: &AppHandle) -> bool {
    let intro = app.state::<Intro>();
    let (owns, armed, orphan) = {
        let mut f = intro.lock();
        f.main_ready = true;
        (f.active, f.armed, std::mem::take(&mut f.orphan))
    };
    if orphan {
        // The intro was abandoned while this page loaded; the splash held the screen.
        eprintln!("[atlas] intro: main page ready after the intro ended, at {}", since_start(app));
        if armed {
            eval_main(app, "window.__atlasIntroReveal&&window.__atlasIntroReveal(true,false)");
        }
        show_main(app);
        close_splash(app);
        return true;
    }
    if owns {
        eprintln!("[atlas] intro: main page ready at {}", since_start(app));
        handoff_if_ready(app);
        return true;
    }
    if armed {
        eval_main(app, "window.__atlasIntroReveal&&window.__atlasIntroReveal(true,false)");
    }
    false
}

/// Mark the main window as built with the pending-intro state.
pub fn arm(app: &AppHandle) {
    app.state::<Intro>().lock().armed = true;
}

fn handoff_if_ready(app: &AppHandle) {
    let intro = app.state::<Intro>();
    let instant = {
        let mut f = intro.lock();
        if !f.active || f.revealing || !f.covered || !f.main_ready {
            return;
        }
        f.revealing = true;
        f.skipped || f.reduced
    };
    eprintln!("[atlas] intro: handoff at {}", since_start(app));
    show_main(app);
    // The main page lands its first frame, then answers with `intro_main_painted`.
    eval_main(
        app,
        &format!("window.__atlasIntroReveal&&window.__atlasIntroReveal({instant},true)"),
    );
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SplashConfig {
    pub radius: f64,
    pub width: u32,
    pub height: u32,
}

/// The splash page is loaded and has laid itself out: fit, show, start the timeline.
#[tauri::command]
pub async fn splash_ready(app: AppHandle) -> Result<SplashConfig, String> {
    let intro = app.state::<Intro>();
    eprintln!("[atlas] intro: splash page ready, asking to show at {}", since_start(&app));
    // setup may still be building the main window; wait for the rect (bounded).
    for _ in 0..300 {
        {
            let f = intro.lock();
            if !f.active {
                return Err("intro is not running".into());
            }
            if f.rect_set {
                break;
            }
        }
        tokio_sleep(5).await;
    }
    let (radius, width, height) = {
        let f = intro.lock();
        if !f.rect_set {
            return Err("splash rect was never set".into());
        }
        (f.radius, f.size.0, f.size.1)
    };
    if let Some(s) = app.get_webview_window(SPLASH) {
        let _ = s.show();
        let _ = s.set_focus();
    }
    {
        let mut f = intro.lock();
        f.splash_shown = true;
        f.shown_at = Some(std::time::Instant::now());
    }
    eprintln!("[atlas] intro: splash shown at {}", since_start(&app));
    Ok(SplashConfig { radius, width, height })
}

async fn tokio_sleep(ms: u64) {
    // Commands run on Tauri's async runtime; a blocking sleep here would stall it.
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
        .await
        .ok();
}

/// The splash reached the flat clay screen.
#[tauri::command]
pub fn splash_covered(app: AppHandle, reduced: bool) {
    let intro = app.state::<Intro>();
    {
        let mut f = intro.lock();
        f.covered = true;
        f.reduced = reduced;
    }
    eprintln!("[atlas] intro: clay screen at {}", since_start(&app));
    handoff_if_ready(&app);
}

/// A click or key on the splash: straight to the app.
#[tauri::command]
pub fn intro_skip(app: AppHandle) {
    let intro = app.state::<Intro>();
    {
        let mut f = intro.lock();
        if !f.active {
            return;
        }
        f.skipped = true;
        // Nothing left to wait for on the splash side.
        f.covered = true;
    }
    eprintln!("[atlas] intro: skipped at {}", since_start(&app));
    handoff_if_ready(&app);
}

/// The main page has painted its first frame under the splash.
#[tauri::command]
pub fn intro_main_painted(app: AppHandle) {
    let intro = app.state::<Intro>();
    let mode = {
        let f = intro.lock();
        if !f.active {
            return;
        }
        if f.skipped {
            "cut"
        } else if f.reduced {
            "fade"
        } else {
            "wipe"
        }
    };
    if mode == "cut" {
        finish(&app);
    } else {
        eval_splash(&app, &format!("window.__atlasSplashFinish&&window.__atlasSplashFinish('{mode}')"));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrameReport {
    pub frames: u32,
    pub worst_ms: f64,
    #[serde(default)]
    pub worst_at_ms: f64,
    #[serde(default)]
    pub start_ms: f64,
    pub over_20: u32,
    pub over_33: u32,
    pub p95_ms: f64,
    pub total_ms: f64,
}

/// The splash finished its last animation: log its frame timing and close it.
#[tauri::command]
pub fn splash_done(app: AppHandle, report: FrameReport) {
    eprintln!(
        "[atlas] intro: done at {} ms; splash frames {} (rAF), start gap {:.1} ms, worst {:.1} ms at +{:.0} ms, p95 {:.1} ms, >20 ms: {}, >33 ms: {}, splash run {:.0} ms",
        since_start(&app),
        report.frames,
        report.start_ms,
        report.worst_ms,
        report.worst_at_ms,
        report.p95_ms,
        report.over_20,
        report.over_33,
        report.total_ms
    );
    finish(&app);
}

fn finish(app: &AppHandle) {
    let intro = app.state::<Intro>();
    {
        let mut f = intro.lock();
        if !f.active {
            return;
        }
        f.active = false;
    }
    eprintln!("[atlas] intro: splash closed at {}", stamp(app));
    close_splash(app);
}
