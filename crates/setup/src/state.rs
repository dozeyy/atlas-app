//! Setup's one shared state and the commands the window calls.
//!
//! The window is a view: it renders the `Snapshot` and sends the few things the person can do
//! (install, close Atlas, hand off, cancel). Everything that takes time runs on a thread here,
//! and the snapshot is pushed to the window only when it changed.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use crate::indexer::{self, Env, Indexer, Reading};
use crate::install;
use crate::uninstall;

pub const STATE_EVENT: &str = "setup:state";

/// Test hooks: a file that gets one line per step (no chat text, only counts and step names),
/// and a switch for the fades-only look.
const LOG_ENV: &str = "ATLAS_SETUP_LOG";
const REDUCE_ENV: &str = "ATLAS_REDUCE_MOTION";

/// The longest the hand-off waits for a reader that is in the middle of starting.
const STARTING_WAIT: Duration = Duration::from_secs(10);

/// How often the reader looks for a running Atlas before it starts.
const ATLAS_POLL: Duration = Duration::from_millis(300);

/// Poll until `atlas_open()` says no. `on_change` hears each new answer (the first included).
/// False when `give_up()` ended the wait first.
fn wait_until_closed(
    poll: Duration,
    mut atlas_open: impl FnMut() -> bool,
    mut on_change: impl FnMut(bool),
    give_up: impl Fn() -> bool,
) -> bool {
    let mut last = None;
    loop {
        if give_up() {
            return false;
        }
        let open = atlas_open();
        if last != Some(open) {
            on_change(open);
            last = Some(open);
        }
        if !open {
            return true;
        }
        std::thread::sleep(poll);
    }
}

/// What to do with a reader that finished starting after the window moved on.
#[derive(Debug, PartialEq, Eq)]
enum Late {
    Keep,
    /// The install is over: let the pass end and close the cache, keep what it wrote.
    Stop,
    /// Setup was cancelled: take back what it made.
    StopAndClean,
}

fn late_reader(closed: bool, handoff_started: bool) -> Late {
    if closed {
        Late::StopAndClean
    } else if handoff_started {
        Late::Stop
    } else {
        Late::Keep
    }
}

/// What this window is for: putting Atlas on, or taking it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    Install,
    Uninstall,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    /// Install: never seen (it starts by itself). Uninstall: waiting for the person's yes.
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
    pub mode: Mode,
    pub phase: Phase,
    /// While working: "unpack", "install" or "opening" (installing); "closing", "removing" or
    /// "data" (uninstalling).
    pub stage: &'static str,
    /// 0 to 1, how far the installer is.
    pub install: f32,
    pub error: Option<String>,
    pub reading: Reading,
    pub reduce_motion: bool,
    /// Uninstall, done: removal of saved data was asked for but some folder was left whole.
    pub data_kept: bool,
}

/// The one piece of work the window asked for.
#[derive(Debug, Clone, Copy)]
enum Job {
    Install { close_first: bool },
    Uninstall { remove_data: bool },
}

struct Inner {
    phase: Phase,
    stage: &'static str,
    install: f32,
    error: Option<String>,
    /// What a retry runs again.
    last_job: Option<Job>,
    indexer: Option<Indexer>,
    /// A reader is in the middle of starting (it has no handle to give back yet).
    starting: bool,
    /// The reading as it stood when it ended or was stopped.
    settled: Option<Reading>,
    /// Nothing to read ahead of time (no chats yet, or a private copy in use).
    nothing_to_read: bool,
    /// Uninstall: saved data was asked to go but a folder without Atlas's marker was left whole.
    data_kept: bool,
    busy: bool,
    closed: bool,
    /// An older Atlas is running, so the reading has not started: the cache is the one thing it
    /// would be writing too, and a newer engine may change its layout under it.
    waiting_atlas: bool,
    /// The install is over and the cache has been (or is being) handed back: no reader may start.
    handoff_started: bool,
}

pub struct Setup {
    mode: Mode,
    /// Install: where Atlas goes. Uninstall: where it is.
    dir: PathBuf,
    inner: Mutex<Inner>,
    app: Mutex<Option<AppHandle>>,
    last_sent: Mutex<Option<Snapshot>>,
    shown: AtomicBool,
    cleaned_up: AtomicBool,
    started: Instant,
}

impl Setup {
    /// Create the state. Nothing runs yet (`start` does that).
    pub fn new(mode: Mode, dir: PathBuf) -> Arc<Setup> {
        Arc::new(Setup {
            mode,
            dir,
            inner: Mutex::new(Inner {
                phase: Phase::Ready,
                stage: "",
                install: 0.0,
                error: None,
                last_job: None,
                indexer: None,
                starting: false,
                settled: None,
                nothing_to_read: false,
                data_kept: false,
                busy: false,
                closed: false,
                waiting_atlas: false,
                handoff_started: false,
            }),
            app: Mutex::new(None),
            last_sent: Mutex::new(None),
            shown: AtomicBool::new(false),
            cleaned_up: AtomicBool::new(false),
            started: Instant::now(),
        })
    }

    /// Start the work and the window updates. Called from the app's setup hook, which runs only
    /// after the single-instance check, so a second Setup that is about to exit never touches
    /// the cache. Installing begins by itself, right now: opening Setup is the person's yes.
    /// Uninstalling waits for its button.
    pub fn start(self: &Arc<Self>) {
        if self.mode == Mode::Install {
            let s = Arc::clone(self);
            std::thread::spawn(move || s.start_reading());
            self.begin(Job::Install { close_first: false });
        }
        let s = Arc::clone(self);
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(150));
            if s.lock().closed {
                break;
            }
            s.emit();
        });
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
            // One write per line: two threads logging at once never cut each other's lines.
            let _ = f.write_all(format!("{:>7} ms  {msg}\n", self.started.elapsed().as_millis()).as_bytes());
        }
    }

    fn start_reading(self: &Arc<Self>) {
        let exe = install::atlas_exe(&self.dir);
        self.start_reading_in(&Env::from_process(), || !crate::winsys::processes_running(&exe).is_empty());
    }

    fn start_reading_in(self: &Arc<Self>, env: &Env, atlas_open: impl FnMut() -> bool) {
        let plan = match indexer::plan(env) {
            Ok(plan) => plan,
            Err(why) => {
                self.log(&format!("reading skipped: {why:?}"));
                self.lock().nothing_to_read = true;
                self.emit();
                return;
            }
        };
        // An Atlas that is already running keeps the cache open and may be an older version:
        // read only once it has closed, so Setup is the cache's only writer.
        let go = wait_until_closed(
            ATLAS_POLL,
            atlas_open,
            |open| {
                self.log(if open { "reading waits: atlas is open" } else { "atlas is closed" });
                self.update(|g| g.waiting_atlas = open);
            },
            || {
                let g = self.lock();
                g.closed || g.handoff_started
            },
        );
        if !go {
            return;
        }
        // Checked and marked in one step: the hand-off waits for `starting` to clear before it
        // takes the reader, so a reader can never begin after the cache was handed to Atlas.
        {
            let mut g = self.lock();
            if g.closed || g.handoff_started {
                return;
            }
            g.starting = true;
        }
        let ix = Indexer::start(&plan);
        self.log("reading started");
        let mut g = self.lock();
        g.starting = false;
        match late_reader(g.closed, g.handoff_started) {
            Late::Keep => {
                g.indexer = Some(ix);
                // The guard must go before emit(), which takes the same lock (a std Mutex is not
                // reentrant: holding it here froze Setup for good the first time it ran for real).
                drop(g);
            }
            Late::Stop => {
                drop(g);
                ix.stop();
            }
            Late::StopAndClean => {
                drop(g);
                ix.stop_and_clean();
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
            Reading { available: !g.nothing_to_read && !g.closed, waiting: g.waiting_atlas, ..Reading::default() }
        };
        Snapshot {
            mode: self.mode,
            phase: g.phase,
            stage: g.stage,
            install: g.install,
            error: g.error.clone(),
            reading,
            reduce_motion: std::env::var_os(REDUCE_ENV).is_some(),
            data_kept: g.data_kept,
        }
    }

    /// Push the snapshot to the window when it differs from the last one sent.
    fn emit(&self) {
        let app = self.app.lock().unwrap_or_else(|p| p.into_inner()).clone();
        // The picture is taken before the window is looked for, so a test without a window still
        // takes the lock and would catch a caller that emits while holding it.
        let snap = self.snapshot();
        let Some(app) = app else { return };
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

    // ------------------------------------------------------------- the work

    fn begin(self: &Arc<Self>, job: Job) {
        {
            let mut g = self.lock();
            if g.busy || !matches!(g.phase, Phase::Ready | Phase::Error | Phase::CloseAtlas) {
                return;
            }
            g.busy = true;
            g.last_job = Some(job);
            // Said at once, in the same step: the first report the window reads is already
            // "working", never an idle screen that a click could race.
            g.phase = Phase::Installing;
            g.error = None;
            match job {
                Job::Install { .. } => {
                    g.stage = "unpack";
                    g.install = 0.04;
                }
                Job::Uninstall { .. } => {
                    g.stage = "closing";
                    g.install = 0.05;
                }
            }
        }
        let s = Arc::clone(self);
        std::thread::spawn(move || {
            match job {
                Job::Install { close_first } => s.run_install(close_first),
                Job::Uninstall { remove_data } => s.run_uninstall(remove_data),
            }
            s.lock().busy = false;
        });
    }

    /// Ask a running Atlas to quit and wait until it has. First choice is Atlas's own quit signal,
    /// which works with close-to-tray on (there the window's close button only hides it). An Atlas
    /// too old to listen gets the window close instead; only when neither reaches it is the tray
    /// the way out.
    fn close_atlas(&self, exe: &Path, running: &[u32]) -> Result<(), &'static str> {
        let quit_sent = crate::winsys::request_quit(running);
        if !quit_sent && crate::winsys::ask_to_close(running) == 0 {
            return Err("Atlas is running in the tray. Quit it from the tray icon, then try again.");
        }
        self.log(if quit_sent { "install: asked atlas to quit" } else { "install: asked atlas's window to close" });
        // It finishes what it was in the middle of (a cold first read of the chats) before it
        // ends, so give it room. The quit signal is repeated: a signal sent while Atlas is
        // still starting up has nobody listening yet.
        let mut resent = Instant::now();
        let closed = install::wait_for(Duration::from_secs(45), || {
            let left = crate::winsys::processes_running(exe);
            if !left.is_empty() && quit_sent && resent.elapsed() >= Duration::from_millis(500) {
                crate::winsys::request_quit(&left);
                resent = Instant::now();
            }
            left.is_empty()
        });
        if closed { Ok(()) } else { Err("Atlas is still finishing what it was doing. Give it a minute, then try again.") }
    }

    /// Move the trail forward (never back) and tell the window.
    fn bump(&self, p: f32) {
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
    }

    fn run_install(self: &Arc<Self>, close_first: bool) {
        let dir = self.dir.clone();
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
            if let Err(why) = self.close_atlas(&exe, &running) {
                return self.fail(why);
            }
        }

        let unpacked = match install::unpack() {
            Ok(u) => u,
            Err(e) => return self.fail(&e.message()),
        };
        self.update(|g| {
            g.stage = "install";
            g.install = 0.15;
        });
        let result = install::run_silent(&unpacked.exe, |p| self.bump(p));
        drop(unpacked);
        if let Err(e) = result {
            return self.fail(&e.message());
        }
        self.log("install: files written");

        // Straight on: the reading stops where it is (Atlas continues from there) and Atlas starts.
        self.update(|g| {
            g.install = 1.0;
            g.stage = "opening";
        });
        let ix = self.take_reader_for_handoff();
        if let Some(ix) = ix {
            let r = ix.reading();
            self.log(&format!("reader: counted {} of {} (finished {})", r.done, r.total, r.finished));
            ix.stop_logged(&|m| self.log(m));
            self.lock().settled.get_or_insert(r);
            self.log("reading stopped and cache closed");
        }
        match install::place_remover(&dir) {
            Ok(_) => self.log("install: remover placed"),
            Err(e) => self.log(&format!("install: remover not placed ({e})")),
        }
        match install::launch(&dir) {
            Err(_) => return self.fail("Atlas is installed but would not start. Open it from the Start menu."),
            Ok(install::Launched::Started) => self.log("install: atlas started"),
            Ok(install::Launched::SkippedElevated) => self.log("install: atlas not started (Setup runs as administrator); open it from the Start menu"),
        }
        self.update(|g| {
            g.phase = Phase::Done;
            g.stage = "";
        });
        self.log("install: done");
    }

    /// Close the door on any reader that has not started and take the one that has. A reader that
    /// is in the middle of starting is waited for (briefly): it has no handle to give back yet.
    fn take_reader_for_handoff(&self) -> Option<Indexer> {
        let begun = Instant::now();
        loop {
            let mut g = self.lock();
            if !g.starting || begun.elapsed() >= STARTING_WAIT {
                g.handoff_started = true;
                return g.indexer.take();
            }
            drop(g);
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Take Atlas off: close it if it runs, run the installer's own uninstaller, and, only when
    /// asked, delete Atlas's saved data by name. Never anything in the Claude folders.
    fn run_uninstall(self: &Arc<Self>, remove_data: bool) {
        let dir = self.dir.clone();
        let exe = install::atlas_exe(&dir);
        self.update(|g| {
            g.phase = Phase::Installing;
            g.stage = "closing";
            g.install = 0.05;
            g.error = None;
            g.data_kept = false;
        });
        self.log(&format!("uninstall: start (remove saved data: {remove_data})"));
        let running = crate::winsys::processes_running(&exe);
        if !running.is_empty()
            && let Err(why) = self.close_atlas(&exe, &running)
        {
            return self.fail(why);
        }
        self.update(|g| {
            g.stage = "removing";
            g.install = 0.2;
        });
        if let Err(e) = uninstall::run_installer_uninstaller(&dir, |p| self.bump(p)) {
            return self.fail(&e.message());
        }
        self.log("uninstall: program removed");
        if remove_data {
            self.update(|g| {
                g.stage = "data";
                g.install = 0.9;
            });
            let env = Env::from_process();
            let plan = uninstall::data_plan(&env, std::env::var_os("APPDATA").as_deref(), std::env::var_os("LOCALAPPDATA").as_deref());
            let r = uninstall::remove_data(&plan);
            self.log(&format!("uninstall: saved data removed ({} entries, kept a folder without a marker: {})", r.removed, r.kept));
            if r.kept {
                self.update(|g| g.data_kept = true);
            }
        }
        uninstall::tidy(&dir);
        self.update(|g| {
            g.install = 1.0;
            g.phase = Phase::Done;
            g.stage = "";
        });
        self.log("uninstall: done");
    }

    /// When this window is the remover's temporary copy, have it erased once it has exited.
    /// Safe to call more than once.
    pub fn leave_nothing_behind(&self) {
        if self.mode == Mode::Uninstall
            && !self.cleaned_up.swap(true, Ordering::SeqCst)
            && let Ok(me) = std::env::current_exe()
        {
            uninstall::erase_my_copy_later(&me);
        }
    }

    /// The window is closing. False keeps it open (never in the middle of the work).
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
        self.leave_nothing_behind();
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

/// Try the last install again (after an error).
#[tauri::command]
pub fn retry(s: Shared<'_>) {
    let job = s.lock().last_job;
    if let Some(job) = job {
        s.begin(job);
    }
}

#[tauri::command]
pub fn close_atlas_and_continue(s: Shared<'_>) {
    s.begin(Job::Install { close_first: true });
}

/// The person said yes to taking Atlas off; `remove_data` is the box for the saved data.
#[tauri::command]
pub fn begin_uninstall(s: Shared<'_>, remove_data: bool) {
    s.begin(Job::Uninstall { remove_data });
}

#[tauri::command]
pub fn cancel(window: WebviewWindow) {
    let _ = window.close();
}

#[tauri::command]
pub fn finish(s: Shared<'_>, app: AppHandle) {
    s.leave_nothing_behind();
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    fn setup() -> Arc<Setup> {
        Setup::new(Mode::Install, PathBuf::from("scratch"))
    }

    #[test]
    fn reading_waits_while_atlas_is_open_and_says_so_once_per_change() {
        let polls = Cell::new(0);
        let heard = RefCell::new(Vec::new());
        let went = wait_until_closed(
            Duration::from_millis(1),
            || {
                polls.set(polls.get() + 1);
                polls.get() <= 3 // open for the first three looks
            },
            |open| heard.borrow_mut().push(open),
            || false,
        );
        assert!(went, "it goes ahead once Atlas has closed");
        assert_eq!(polls.get(), 4);
        assert_eq!(*heard.borrow(), vec![true, false], "one report per change, not per look");
    }

    #[test]
    fn reading_starts_at_once_when_atlas_was_never_open() {
        let heard = RefCell::new(Vec::new());
        assert!(wait_until_closed(Duration::from_millis(1), || false, |o| heard.borrow_mut().push(o), || false));
        assert_eq!(*heard.borrow(), vec![false]);
    }

    #[test]
    fn a_cancelled_setup_stops_waiting_for_atlas() {
        let looks = Cell::new(0);
        let went = wait_until_closed(
            Duration::from_millis(1),
            || {
                looks.set(looks.get() + 1);
                true // Atlas never closes
            },
            |_| {},
            || looks.get() >= 5,
        );
        assert!(!went, "no reading starts for a window that is gone");
    }

    #[test]
    fn a_reader_that_starts_late_is_stopped_not_left_running() {
        assert_eq!(late_reader(false, false), Late::Keep);
        assert_eq!(late_reader(false, true), Late::Stop, "the install is over: close the cache for Atlas");
        assert_eq!(late_reader(true, false), Late::StopAndClean, "cancelled: take back what setup made");
        assert_eq!(late_reader(true, true), Late::StopAndClean);
    }

    /// The hand-off must not run past a reader that is still starting: it has no handle to give
    /// back yet, and Atlas would then open the cache while that reader writes to it.
    #[test]
    fn the_hand_off_waits_for_a_reader_that_is_still_starting() {
        let s = setup();
        s.lock().starting = true;
        let s2 = Arc::clone(&s);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            s2.lock().starting = false;
        });
        let begun = Instant::now();
        assert!(s.take_reader_for_handoff().is_none());
        assert!(begun.elapsed() >= Duration::from_millis(140), "it waited for the start to finish");
        assert!(s.lock().handoff_started, "and closed the door behind it");
        t.join().unwrap();
    }

    /// The whole start of the reading, run for real on a scratch Claude folder: it must come back
    /// (it once held the state lock while announcing itself, and froze Setup for good), keep the
    /// reader, and leave the state usable by everyone else.
    #[test]
    fn the_reading_starts_and_leaves_the_state_free() {
        let root = tempfile::tempdir().unwrap();
        let proj = root.path().join("claude").join("projects").join("demo");
        std::fs::create_dir_all(&proj).unwrap();
        std::fs::write(proj.join("a.jsonl"), "{}\n").unwrap();
        let env = Env {
            home: root.path().join("home"),
            cwd: root.path().to_path_buf(),
            claude_config: Some(root.path().join("claude").into_os_string()),
            atlas_data: Some(root.path().join("atlas-data").into_os_string()),
        };
        let setup = setup();
        let (tx, rx) = std::sync::mpsc::channel();
        let s = Arc::clone(&setup);
        std::thread::spawn(move || {
            s.start_reading_in(&env, || false);
            let _ = tx.send(());
        });
        rx.recv_timeout(Duration::from_secs(20)).expect("start_reading returned (no deadlock)");
        let (tx, rx) = std::sync::mpsc::channel();
        let s = Arc::clone(&setup);
        std::thread::spawn(move || {
            let snap = s.snapshot();
            let _ = tx.send(snap.reading.available);
        });
        assert!(rx.recv_timeout(Duration::from_secs(20)).expect("the state is not held"), "chats were found");
        assert!(!setup.lock().starting, "the start is over");
        let ix = setup.take_reader_for_handoff().expect("the reader is kept and handed over");
        ix.stop();
    }
}
