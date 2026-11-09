//! Setup's one shared state and the commands the window calls.
//!
//! The window is a view: it renders the `Snapshot` and sends the few things the person can do
//! (install, close Atlas, hand off, cancel). Everything that takes time runs on a thread here,
//! and the snapshot is pushed to the window only when it changed.

use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::indexer::{self, Env, Indexer, Reading};
use crate::install::{self, Options};

pub const STATE_EVENT: &str = "setup:state";

/// Test hooks: a file that gets one line per step (no chat text, only counts and step names),
/// and a switch for the fades-only look.
const LOG_ENV: &str = "ATLAS_SETUP_LOG";
const REDUCE_ENV: &str = "ATLAS_REDUCE_MOTION";

/// Once the files are installed, the reading is given time to finish so the trail can follow it
/// all the way to the mark: it is waited for while it keeps moving, and given up on when it
/// stalls for `READING_STALL`, or in any case after `READING_CAP` (Atlas reads the rest itself).
const READING_STALL: Duration = Duration::from_secs(10);
const READING_CAP: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Ready,
    /// Atlas is running and would be in the way.
    CloseAtlas,
    Installing,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: Phase,
    /// While installing: "unpack", "install" or "reading".
    pub stage: &'static str,
    /// 0 to 1, how far the installer is.
    pub install: f32,
    pub error: Option<String>,
    pub reading: Reading,
    pub reduce_motion: bool,
}

struct Inner {
    phase: Phase,
    stage: &'static str,
    install: f32,
    error: Option<String>,
    opts: Options,
    indexer: Option<Indexer>,
    /// The reading as it stood when it ended or was stopped.
    settled: Option<Reading>,
    /// Nothing to read ahead of time (no chats yet, or a private copy in use).
    nothing_to_read: bool,
    busy: bool,
    closed: bool,
}

pub struct Setup {
    inner: Mutex<Inner>,
    app: Mutex<Option<AppHandle>>,
    last_sent: Mutex<Option<Snapshot>>,
    shown: AtomicBool,
    started: Instant,
}

impl Setup {
    /// Create the state and start reading the chats right away, before any window exists.
    pub fn new() -> Arc<Setup> {
        let setup = Arc::new(Setup {
            inner: Mutex::new(Inner {
                phase: Phase::Ready,
                stage: "",
                install: 0.0,
                error: None,
                opts: Options::default(),
                indexer: None,
                settled: None,
                nothing_to_read: false,
                busy: false,
                closed: false,
            }),
            app: Mutex::new(None),
            last_sent: Mutex::new(None),
            shown: AtomicBool::new(false),
            started: Instant::now(),
        });
        let s = Arc::clone(&setup);
        std::thread::spawn(move || s.start_reading());
        let s = Arc::clone(&setup);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(150));
            if s.lock().closed {
                break;
            }
            s.emit();
        });
        setup
    }

    pub fn attach(self: &Arc<Self>, app: AppHandle) {
        *self.app.lock().unwrap_or_else(|p| p.into_inner()) = Some(app.clone());
        // If the page never says it is ready, show the window anyway.
        let s = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(4));
            if let Some(w) = app.get_webview_window("main") {
                s.show(&w);
            }
        });
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    fn log(&self, msg: &str) {
        if let Some(path) = std::env::var_os(LOG_ENV).filter(|p| !p.is_empty())
            && let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path)
        {
            let _ = writeln!(f, "{:>7} ms  {msg}", self.started.elapsed().as_millis());
        }
    }

    fn start_reading(self: &Arc<Self>) {
        let plan = indexer::plan(&Env::from_process());
        match plan {
            Err(why) => {
                self.log(&format!("reading skipped: {why:?}"));
                self.lock().nothing_to_read = true;
            }
            Ok(plan) => {
                let ix = Indexer::start(&plan);
                self.log("reading started");
                let mut g = self.lock();
                if g.closed {
                    drop(g);
                    ix.stop_and_clean();
                } else {
                    g.indexer = Some(ix);
                }
            }
        }
        self.emit();
    }

    /// The current picture. Asks the reader only while it still works; once it ended the
    /// answer is kept.
    pub fn snapshot(&self) -> Snapshot {
        let mut g = self.lock();
        let reading = if let Some(r) = &g.settled {
            r.clone()
        } else if let Some(ix) = &g.indexer {
            let r = ix.reading();
            if r.finished {
                if let Some(line) = ix.timing_line() {
                    self.log(&line);
                }
                self.log(&format!("reading finished: {} files, {} tokens", r.done, r.tokens));
                g.settled = Some(r.clone());
            }
            r
        } else {
            Reading { available: !g.nothing_to_read && !g.closed, ..Reading::default() }
        };
        Snapshot {
            phase: g.phase,
            stage: g.stage,
            install: g.install,
            error: g.error.clone(),
            reading,
            reduce_motion: std::env::var_os(REDUCE_ENV).is_some(),
        }
    }

    /// Push the snapshot to the window when it differs from the last one sent.
    fn emit(&self) {
        let app = self.app.lock().unwrap_or_else(|p| p.into_inner()).clone();
        let Some(app) = app else { return };
        let snap = self.snapshot();
        let mut last = self.last_sent.lock().unwrap_or_else(|p| p.into_inner());
        if last.as_ref() != Some(&snap) {
            let _ = app.emit(STATE_EVENT, &snap);
            *last = Some(snap);
        }
    }

    fn update(&self, f: impl FnOnce(&mut Inner)) {
        f(&mut self.lock());
        self.emit();
    }

    fn fail(&self, msg: &str) {
        self.log(&format!("error: {msg}"));
        self.update(|g| {
            g.phase = Phase::Error;
            g.stage = "";
            g.error = Some(msg.to_string());
            g.busy = false;
        });
    }

    fn show(&self, w: &WebviewWindow) {
        if !self.shown.swap(true, Ordering::SeqCst) {
            let _ = w.show();
            let _ = w.set_focus();
            self.log("window shown");
        }
    }

    // ------------------------------------------------------------- the install

    fn begin(self: &Arc<Self>, close_first: bool) {
        {
            let mut g = self.lock();
            if g.busy || !matches!(g.phase, Phase::Ready | Phase::Error | Phase::CloseAtlas) {
                return;
            }
            g.busy = true;
        }
        let s = Arc::clone(self);
        std::thread::spawn(move || {
            s.run_install(close_first);
            s.lock().busy = false;
        });
    }

    fn run_install(self: &Arc<Self>, close_first: bool) {
        let dir = install::install_dir();
        let exe = install::atlas_exe(&dir);
        self.update(|g| {
            g.phase = Phase::Installing;
            g.stage = "unpack";
            g.install = 0.04;
            g.error = None;
        });
        self.log("install: start");

        let running = crate::winsys::processes_running(&exe);
        if !running.is_empty() {
            if !close_first {
                self.log("install: atlas is running");
                self.update(|g| {
                    g.phase = Phase::CloseAtlas;
                    g.stage = "";
                    g.install = 0.0;
                });
                return;
            }
            if crate::winsys::ask_to_close(&running) == 0 {
                // No window to ask: Atlas is living in the tray, and only its own menu quits it.
                self.fail("Atlas is running in the tray. Quit it from the tray icon, then try again.");
                return;
            }
            // The window closes at once, but the program finishes what it was in the middle of
            // (a cold first read of the chats) before it ends, so give it room.
            let closed = install::wait_for(Duration::from_secs(45), || crate::winsys::processes_running(&exe).is_empty());
            if !closed {
                self.fail("Atlas is still finishing what it was doing. Give it a minute, then try again.");
                return;
            }
        }

        let unpacked = match install::unpack() {
            Ok(u) => u,
            Err(e) => return self.fail(&e.message()),
        };
        let opts = self.lock().opts;
        self.update(|g| {
            g.stage = "install";
            g.install = 0.15;
        });
        let result = install::run_silent(&unpacked.exe, &opts, |p| {
            let moved = {
                let mut g = self.lock();
                let m = p > g.install;
                if m {
                    g.install = p;
                }
                m
            };
            if moved {
                self.emit();
            }
        });
        drop(unpacked);
        if let Err(e) = result {
            return self.fail(&e.message());
        }
        self.log("install: files written");

        // The installer is quick; the reading may not be. Give it a moment, then hand off anyway.
        self.update(|g| {
            g.install = 1.0;
            g.stage = "reading";
        });
        let finished = self.wait_for_reading();
        self.log(&format!("install: reading {} at hand-off", if finished { "finished" } else { "still running" }));

        // Close the cache before Atlas can open it: one writer at a time.
        let ix = self.lock().indexer.take();
        if let Some(ix) = ix {
            let r = ix.reading();
            ix.stop();
            self.lock().settled.get_or_insert(r);
            self.log("reading stopped and cache closed");
        }
        self.update(|g| {
            g.phase = Phase::Done;
            g.stage = "";
        });
        self.log("install: done");
    }

    /// Wait for the reading to end, as long as it keeps getting through files. True when it ended.
    fn wait_for_reading(&self) -> bool {
        let start = Instant::now();
        let mut last_done = 0;
        let mut last_move = Instant::now();
        loop {
            let reading = self.snapshot().reading;
            if reading.finished || reading.failed || !reading.available {
                return true;
            }
            if reading.done != last_done {
                last_done = reading.done;
                last_move = Instant::now();
            }
            if last_move.elapsed() >= READING_STALL || start.elapsed() >= READING_CAP {
                return false;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    /// The window is closing. False keeps it open (never in the middle of an install).
    pub fn on_close_requested(&self) -> bool {
        let (ix, done) = {
            let mut g = self.lock();
            if g.phase == Phase::Installing {
                return false;
            }
            g.closed = true;
            (g.indexer.take(), g.phase == Phase::Done)
        };
        if let Some(ix) = ix {
            if done {
                ix.stop();
            } else {
                // Cancelled: whatever setup made for the cache goes away again.
                ix.stop_and_clean();
                self.log("cancelled: cache folder removed if setup made it");
            }
        }
        true
    }
}

// ------------------------------------------------------------------- commands

type Shared<'a> = State<'a, Arc<Setup>>;

#[tauri::command]
pub fn setup_state(s: Shared<'_>) -> Snapshot {
    s.snapshot()
}

/// The page has painted its first frame: show the window now, never before.
#[tauri::command]
pub fn setup_ready(s: Shared<'_>, window: WebviewWindow) {
    s.show(&window);
}

#[tauri::command]
pub fn begin_install(s: Shared<'_>, options: Options) {
    s.lock().opts = options;
    s.begin(false);
}

#[tauri::command]
pub fn close_atlas_and_continue(s: Shared<'_>) {
    s.begin(true);
}

/// The spark has popped: start Atlas (when asked), so its own intro begins as this window eases out.
#[tauri::command]
pub fn handoff(s: Shared<'_>, open: bool) {
    if !open {
        return;
    }
    let dir = install::install_dir();
    s.log("hand-off: starting Atlas");
    if install::launch(&dir).is_err() {
        s.fail("Atlas is installed but would not start. Open it from the Start menu.");
    }
}

#[tauri::command]
pub fn cancel(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn finish(app: AppHandle) {
    app.exit(0);
}
