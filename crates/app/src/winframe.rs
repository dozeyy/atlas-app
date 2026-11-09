//! Windows: edge drags that behave like a native window's.
//!
//! WebView2 presents asynchronously. When the window is resized, Windows shows the webview's last
//! frame pinned to its top-left corner until the page has drawn a frame at the new size, so for a
//! frame or two the content is in the wrong place: a drag on the left or top edge pushes it along
//! with that edge, a drag on the right edge cuts or uncovers the right column. (Every Electron app
//! does the same; Discord is no better.)
//!
//! The fix inverts who leads. While an edge drag runs:
//! - the webview is grown to a fixed canvas (the monitor around the window) that does not move on
//!   screen, and the page lays itself out inside the window's part of it (`src/lib/frameSync.ts`,
//!   the `frame-live` rules in `index.css`), so a stale frame is never in the wrong place;
//! - every step of the drag is first sent to the page, and the window only takes that size once
//!   the page answers that a frame laid out for it is on screen (sent back through the
//!   `frame_ack` command). The window trails the mouse by that answer, as native windows do, and
//!   never shows a frame that does not belong to its size. A step the page has not answered within
//!   `STEP_CAP` is applied without it, so a busy page never holds the window still.
//!
//! The canvas has to start left of or above the window for a left or top drag, and the webview
//! goes back to the window's own rect when the drag ends. Both moves change the webview's origin,
//! which no page frame can hide, so a still picture of the window covers it for that one swap (a
//! layered popup filled from the screen, taken down when the window shows the page's new frame).
//!
//! Every decision lives in `Machine`, which talks to the window only through `Host`; the tests
//! drive it with a fake host. Nothing here runs outside an edge drag; moves, snaps, maximize and
//! code-driven resizes take the normal path. `ATLAS_FRAME_SYNC=0` turns it off (A/B),
//! `ATLAS_FRAME_SYNC_LOG=1` traces it.

// Every function here is a thin wrapper over Win32 and WebView2 calls on the UI thread.
#![allow(unsafe_op_in_unsafe_fn)]

use std::cell::RefCell;
use std::time::{Duration, Instant};

use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2, ICoreWebView2Controller};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM};
use windows::Win32::Graphics::Dwm::{DwmFlush, DwmSetWindowAttribute, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND};
use windows::Win32::Graphics::Gdi::{
    BitBlt, ClientToScreen, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, COLORONCOLOR, DIB_RGB_COLORS, HBITMAP, HDC, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetAncestor, GetClientRect, GetWindowRect, IsIconic, IsZoomed, KillTimer, RegisterClassW,
    SendMessageW, SetTimer, SetWindowPos, ShowWindow, UpdateLayeredWindow, GA_ROOT, HWND_TOP, MINMAXINFO, SC_SIZE, SIZE_RESTORED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, ULW_OPAQUE, WINDOWPOS, WMSZ_BOTTOM,
    WMSZ_BOTTOMLEFT, WMSZ_BOTTOMRIGHT, WMSZ_LEFT, WMSZ_RIGHT, WMSZ_TOP, WMSZ_TOPLEFT, WMSZ_TOPRIGHT, WM_DPICHANGED, WM_ENTERSIZEMOVE,
    WM_EXITSIZEMOVE, WM_GETMINMAXINFO, WM_NCDESTROY, WM_SIZE, WM_SIZING, WM_SYSCOMMAND, WM_WINDOWPOSCHANGING, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

const SUBCLASS_ID: usize = 0x4154_4C46; // "ATLF"
/// Responsiveness cap: a size step the page has not answered in this long is applied without
/// it (the window follows the cursor; the page catches up a frame late). The next step waits for
/// the page again, so a quick answer goes straight back to synced. Before the drag is live
/// (arming, growing) a late answer hands the whole drag back to the normal path.
const STEP_CAP: Duration = Duration::from_millis(150);
/// After the drag: how long to wait for the page's window-sized frame before giving up on it.
const ACK_TIMEOUT: Duration = Duration::from_millis(400);
/// How often the cap is checked while a drag runs.
const TICK_MS: u32 = 25;
/// How often, and how many times, the cover checks that the window shows the page's new frame.
const CONFIRM_EVERY_MS: u32 = 10;
const CONFIRM_TRIES: u32 = 30;
/// The cover check compares pictures shrunk by this much each way (1/16 of the pixels to read).
const CHECK_SCALE: i32 = 4;
/// PW_CLIENTONLY | PW_RENDERFULLCONTENT: the client area as DWM composes it, webview included.
const PW_CLIENT_FULL: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(3);

/// Install on the main window. Call once, after the window is built.
pub fn install(window: &tauri::WebviewWindow) {
    if std::env::var("ATLAS_FRAME_SYNC").as_deref() == Ok("0") {
        eprintln!("[atlas] frame sync: off (ATLAS_FRAME_SYNC=0)");
        return;
    }
    let r = window.with_webview(|pw| {
        // Runs on the UI thread, where every WebView2 and window call below must happen.
        if let Err(e) = unsafe { attach(pw.controller()) } {
            eprintln!("[atlas] frame sync: not available: {e}");
        }
    });
    if let Err(e) = r {
        eprintln!("[atlas] frame sync: not available: {e}");
    }
}

// ---------------------------------------------------------------------------------------------
// The phase machine: every decision of a drag, with no window or webview call of its own.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Phase {
    Idle,
    /// The page was told to lay out inside a sub-rect (still the whole window); no answer yet.
    Arming,
    /// The webview was grown to the canvas; waiting for a frame drawn at the canvas size.
    Growing,
    /// The drag follows the page's answers.
    Live,
    /// The webview went back to the window's rect; waiting for the page's frame at that size.
    Ending,
}

/// One message to the page: where the window's client area sits in the webview (physical px),
/// and the webview size it must see before it answers.
#[derive(Clone, Copy, PartialEq, Debug)]
struct Frame {
    seq: u64,
    live: bool,
    frame: RECT,
    vw: i32,
    vh: i32,
}

/// What a drag needs from the window and the webview. `Win` is the real one.
trait Host {
    /// The window's client area on screen.
    fn client(&self) -> RECT;
    /// Send the page a frame message. False when WebView2 refused it (its browser process is gone).
    fn post(&mut self, f: &Frame) -> bool;
    /// Put the webview at `canvas` (screen) while the client area sits at `cl`.
    fn grow(&mut self, canvas: RECT, cl: RECT);
    /// The webview back to the window's own client rect.
    fn reset_webview(&mut self);
    /// Cover the client area with a still picture of it. True when the picture was kept to tell
    /// the page's new frame from the old one moved by `shift`.
    fn cover(&mut self, cl: RECT, shift: (i32, i32)) -> bool;
    fn uncover(&mut self);
    fn tick_timer(&mut self, on: bool);
    fn confirm_timer(&mut self, on: bool);
}

/// Something to do once the state is released: these calls send messages back into `proc`.
#[derive(Clone, Copy, PartialEq, Debug)]
enum After {
    None,
    /// Give the window this rect; the next step follows.
    Apply(RECT),
    /// Tell tao (and the window-state plugin behind it) the client size: it heard nothing during
    /// the drag.
    Resized,
    /// The drag is the normal path's now: give the window this rect, if any, then `Resized`.
    HandBack(Option<RECT>),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Late {
    Wait,
    /// Apply the step in flight without the page's answer.
    ApplyStep,
    /// Give the drag back to the normal path.
    HandBack,
}

/// What to do about an answer the page has owed for `waited`. `step_cap` is STEP_CAP except in a
/// debug test run (`ATLAS_FRAME_SYNC_CAP_MS`).
fn late_action(phase: Phase, waited: Duration, step_cap: Duration) -> Late {
    match phase {
        Phase::Live if waited >= step_cap => Late::ApplyStep,
        Phase::Arming | Phase::Growing if waited >= STEP_CAP => Late::HandBack,
        Phase::Ending if waited >= ACK_TIMEOUT => Late::HandBack,
        _ => Late::Wait,
    }
}

/// The live step cap. Debug builds take `ATLAS_FRAME_SYNC_CAP_MS` so a test can force the capped
/// path (a tiny cap applies every step without the page); release builds always use STEP_CAP.
fn step_cap() -> Duration {
    #[cfg(debug_assertions)]
    if let Some(ms) = std::env::var("ATLAS_FRAME_SYNC_CAP_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        eprintln!("[atlas] frame sync: step cap {ms} ms (test override)");
        return Duration::from_millis(ms);
    }
    STEP_CAP
}

struct Machine<H: Host> {
    host: H,
    phase: Phase,
    /// `WM_SYSCOMMAND SC_SIZE` was seen: the next size-move loop is an edge drag. Its low bits
    /// name the edge (WMSZ_*), 0 for keyboard sizing.
    sizing_edge: Option<u32>,
    seq: u64,
    /// The message the page owes an answer for, and when it was sent. Set for every message,
    /// delivered or not, so the cap always has something to time.
    waiting: Option<(u64, Instant)>,
    /// A message of this drag could not be delivered: the next tick hands the drag back.
    post_failed: bool,
    /// The window rect sent to the page and not applied yet.
    in_flight: Option<RECT>,
    /// The newest rect the size loop asked for that the page has not been sent.
    wanted: Option<RECT>,
    /// The newest rect the size loop asked for, as asked (not clamped to the canvas).
    asked: Option<RECT>,
    /// The window rect on screen.
    held: RECT,
    /// Client rect minus window rect (both in screen coordinates), per side.
    insets: RECT,
    /// The webview's screen rect while live.
    canvas: RECT,
    exit: bool,
    /// The rect last handed back to the size loop from WM_SIZING.
    loop_rect: Option<RECT>,
    /// A cover is up with a picture to check the window against.
    covered: bool,
    /// The phase to enter once the window shows the page's new frame, and the checks so far.
    confirm: Option<(Phase, u32)>,
    failures: u32,
    /// Answers the page has given this session: a hand-back from a page that has answered before
    /// is a busy moment, not a broken page, and does not count toward turning sync off.
    acks: u64,
    /// Steps of this drag applied by the cap without the page's answer.
    capped: u32,
    /// The edge being dragged (WMSZ_*).
    edge: u32,
    /// The smallest window rect (width, height) the window may take.
    min: (i32, i32),
    step_cap: Duration,
    log: bool,
    t0: Instant,
}

impl<H: Host> Machine<H> {
    fn new(host: H, step_cap: Duration, log: bool) -> Self {
        Machine {
            host,
            phase: Phase::Idle,
            sizing_edge: None,
            seq: 0,
            waiting: None,
            post_failed: false,
            in_flight: None,
            wanted: None,
            asked: None,
            held: RECT::default(),
            insets: RECT::default(),
            canvas: RECT::default(),
            exit: false,
            loop_rect: None,
            covered: false,
            confirm: None,
            failures: 0,
            acks: 0,
            capped: 0,
            edge: 0,
            min: (0, 0),
            step_cap,
            log,
            t0: Instant::now(),
        }
    }

    fn trace(&self, what: &str) {
        if self.log {
            eprintln!("[atlas] frame sync {:>7.1} ms: {what}", self.t0.elapsed().as_secs_f64() * 1000.0);
        }
    }

    /// The webview is the canvas (WM_SIZE must not put it back to the window's rect).
    fn pinned(&self) -> bool {
        matches!(self.phase, Phase::Growing | Phase::Live)
    }

    fn client_of(&self, r: RECT) -> RECT {
        let i = self.insets;
        RECT { left: r.left + i.left, top: r.top + i.top, right: r.right + i.right, bottom: r.bottom + i.bottom }
    }

    /// The client area of window rect `r` lies inside the canvas.
    fn fits(&self, r: RECT) -> bool {
        let c = self.client_of(r);
        c.left >= self.canvas.left && c.top >= self.canvas.top && c.right <= self.canvas.right && c.bottom <= self.canvas.bottom
    }

    /// At least the minimum size, the edge opposite the dragged one staying where it is (a
    /// native window stops dead at its minimum; it never slides).
    fn at_least_min(&self, mut r: RECT) -> RECT {
        let (mw, mh) = self.min;
        if r.right - r.left < mw {
            if matches!(self.edge, WMSZ_LEFT | WMSZ_TOPLEFT | WMSZ_BOTTOMLEFT) {
                r.left = r.right - mw;
            } else {
                r.right = r.left + mw;
            }
        }
        if r.bottom - r.top < mh {
            if matches!(self.edge, WMSZ_TOP | WMSZ_TOPLEFT | WMSZ_TOPRIGHT) {
                r.top = r.bottom - mh;
            } else {
                r.bottom = r.top + mh;
            }
        }
        r
    }

    /// An edge drag starts: `window` and `client` are the window's rects on screen, `monitor`
    /// the monitor around it, `min` the smallest window rect allowed (width, height).
    fn begin(&mut self, edge: u32, window: RECT, client: RECT, monitor: RECT, min: (i32, i32)) {
        let (wr, cl, m) = (window, client, monitor);
        self.edge = edge;
        self.min = min;
        self.held = wr;
        self.insets =
            RECT { left: cl.left - wr.left, top: cl.top - wr.top, right: cl.right - wr.right, bottom: cl.bottom - wr.bottom };
        // The canvas: the whole monitor around the window. A right or bottom drag never needs
        // anything left of or above the window, so its canvas starts at the window's corner and
        // the webview's origin never moves.
        let keeps_origin = matches!(edge, WMSZ_RIGHT | WMSZ_BOTTOM | WMSZ_BOTTOMRIGHT);
        self.canvas = RECT {
            left: if keeps_origin { cl.left } else { cl.left.min(m.left) },
            top: if keeps_origin { cl.top } else { cl.top.min(m.top) },
            right: cl.right.max(m.right),
            bottom: cl.bottom.max(m.bottom),
        };
        self.exit = false;
        self.loop_rect = None;
        self.capped = 0;
        self.wanted = None;
        self.asked = None;
        self.in_flight = None;
        self.post_failed = false;
        self.covered = false;
        self.t0 = Instant::now();
        self.trace(&format!("begin edge {edge}, canvas {:?}", rect_tuple(self.canvas)));
        self.phase = Phase::Arming;
        // Step 1: the page pins its layout to the window's rect, still inside the window-sized
        // webview, so growing the webview next changes nothing on screen.
        self.post(true, RECT { left: 0, top: 0, right: cl.right - cl.left, bottom: cl.bottom - cl.top });
        self.host.tick_timer(true);
    }

    /// Step 2: grow the webview to the canvas. Its origin moves for a left or top drag, so a still
    /// picture of the window covers the swap.
    fn grow(&mut self) {
        let cl = self.host.client();
        if self.canvas.left != cl.left || self.canvas.top != cl.top {
            // Until the page's canvas-sized frame is on screen, the old one sits at the canvas origin.
            self.covered = self.host.cover(cl, (self.canvas.left - cl.left, self.canvas.top - cl.top));
        }
        self.host.grow(self.canvas, cl);
        self.phase = Phase::Growing;
        self.post(true, offset(cl, self.canvas));
    }

    /// The size loop proposes `rect`. Returns the rect the window keeps for now, or None for the
    /// normal path.
    fn on_sizing(&mut self, rect: RECT) -> Option<RECT> {
        if matches!(self.phase, Phase::Idle | Phase::Ending) {
            return None;
        }
        let rect = self.at_least_min(rect);
        self.wanted = Some(rect);
        self.asked = Some(rect);
        if self.phase == Phase::Live && self.waiting.is_none() {
            if let Some(r) = self.wanted.take() {
                if r != self.held {
                    self.request(r);
                }
            }
        }
        self.loop_rect = Some(self.held);
        Some(self.held) // the window keeps its size until the page has drawn the next one
    }

    /// The size loop remembers the rect last handed back from WM_SIZING and sets it once more
    /// when the mouse is released. If an answer has moved the window on since, that rect is
    /// stale: keep the window where the page has drawn it.
    fn keep_on_move(&self, to: RECT) -> Option<RECT> {
        let stale = self.loop_rect?;
        (self.phase != Phase::Idle && to == stale && stale != self.held).then_some(self.held)
    }

    /// The mouse was released.
    fn on_exit(&mut self) -> After {
        self.sizing_edge = None;
        if matches!(self.phase, Phase::Idle | Phase::Ending) {
            return After::None;
        }
        self.exit = true;
        match self.phase {
            // A click on the edge that never moved it: nothing to keep in sync, and no reason to
            // grow the webview or put up a cover.
            Phase::Arming if self.wanted.is_none() => {
                self.trace("released without moving");
                self.hand_back(None, None);
                After::None
            }
            Phase::Live if self.waiting.is_none() => self.finish(),
            _ => After::None,
        }
    }

    /// The page has drawn the frame for message `seq`.
    fn on_ack(&mut self, seq: u64, via: u8) -> After {
        let since = match self.waiting {
            Some((want, at)) if want == seq => at,
            _ => return After::None,
        };
        self.waiting = None;
        self.acks += 1;
        let how = match via {
            1 => "presented",
            2 => "presentation not reported",
            _ => "two frames",
        };
        self.trace(&format!("ack {seq} in {:?} ({how}, {:.1} ms)", self.phase, since.elapsed().as_secs_f64() * 1000.0));
        match self.phase {
            Phase::Idle => After::None,
            Phase::Arming => {
                self.grow();
                After::None
            }
            Phase::Growing => self.confirm_then(Phase::Live),
            Phase::Live => match self.in_flight.take() {
                Some(r) => {
                    self.held = r;
                    After::Apply(r)
                }
                None => self.next(),
            },
            Phase::Ending => self.confirm_then(Phase::Idle),
        }
    }

    /// The cap: a page that is slow to answer, or cannot be reached, must not hold the window.
    fn tick(&mut self, now: Instant) -> After {
        if self.phase == Phase::Idle {
            self.host.tick_timer(false);
            return After::None;
        }
        if self.post_failed {
            return self.hand_back(Some("the page could not be reached"), None);
        }
        let late = match self.waiting {
            Some((_, at)) if self.confirm.is_none() => late_action(self.phase, now.saturating_duration_since(at), self.step_cap),
            _ => Late::Wait,
        };
        match late {
            Late::Wait => After::None,
            Late::HandBack => self.hand_back(Some("no answer from the page in time"), None),
            Late::ApplyStep => {
                let seq = self.waiting.take().map(|(q, _)| q).unwrap_or(0);
                self.capped += 1;
                self.trace(&format!("step {seq} late: applied without the page"));
                // The next step waits for the page again.
                match self.in_flight.take() {
                    Some(r) => {
                        self.held = r;
                        After::Apply(r)
                    }
                    None => self.next(),
                }
            }
        }
    }

    /// A cover check came back: `sample` is (difference to the new frame, to the old frame
    /// moved), or None when the window could not be read (take the cover down).
    fn confirm_check(&mut self, sample: Option<(f64, f64)>) -> After {
        let Some((target, tries)) = self.confirm else { return After::None };
        let shown = match sample {
            Some((new, old)) => new < 1.0 || new * 3.0 < old,
            None => true,
        };
        if !shown && tries + 1 < CONFIRM_TRIES {
            self.confirm = Some((target, tries + 1));
            return After::None;
        }
        self.trace(&format!("{} after {} checks", if shown { "new frame on screen" } else { "new frame not confirmed" }, tries + 1));
        self.enter(target)
    }

    /// The page has answered for a frame drawn under the cover: wait until the window shows it
    /// (no cover: nothing to wait for), then enter `target`.
    fn confirm_then(&mut self, target: Phase) -> After {
        if !self.covered {
            return self.enter(target);
        }
        self.confirm = Some((target, 0));
        self.host.confirm_timer(true);
        After::None
    }

    fn enter(&mut self, target: Phase) -> After {
        self.stop_confirm();
        self.uncover();
        self.phase = target;
        match target {
            Phase::Live => self.next(),
            _ => {
                self.host.tick_timer(false);
                After::None
            }
        }
    }

    fn stop_confirm(&mut self) {
        if self.confirm.take().is_some() {
            self.host.confirm_timer(false);
        }
    }

    fn uncover(&mut self) {
        self.host.uncover();
        self.covered = false;
    }

    /// The next step of a live drag: the newest rect the size loop asked for, or the end.
    fn next(&mut self) -> After {
        if self.exit {
            return self.finish();
        }
        if let Some(r) = self.wanted.take() {
            if r != self.held {
                self.request(r);
            }
        }
        After::None
    }

    /// Send the page step `r`, kept inside the canvas. False when that leaves the window where it
    /// is (nothing was sent, so no answer will come).
    fn request(&mut self, r: RECT) -> bool {
        let i = self.insets;
        let mut cl = self.client_of(r);
        cl.left = cl.left.max(self.canvas.left);
        cl.top = cl.top.max(self.canvas.top);
        cl.right = cl.right.min(self.canvas.right);
        cl.bottom = cl.bottom.min(self.canvas.bottom);
        let r = RECT { left: cl.left - i.left, top: cl.top - i.top, right: cl.right - i.right, bottom: cl.bottom - i.bottom };
        if r == self.held {
            return false;
        }
        self.in_flight = Some(r);
        self.post(true, offset(cl, self.canvas));
        true
    }

    /// The drag is over: the webview goes back to the window's own rect.
    fn finish(&mut self) -> After {
        // Released past the canvas (onto another monitor, or past the screen's edge): the window
        // ends where the mouse let go, the normal way, as a native window would.
        if let Some(a) = self.asked.filter(|a| !self.fits(*a)) {
            self.trace(&format!("released past the canvas at {:?}", rect_tuple(a)));
            return self.hand_back(None, Some(a));
        }
        if let Some(r) = self.wanted.take() {
            if r != self.held && self.request(r) {
                return After::None; // its answer ends the drag
            }
        }
        let cl = self.host.client();
        if self.canvas.left != cl.left || self.canvas.top != cl.top {
            // Until the page's window-sized frame is on screen, the canvas frame sits at the
            // window's origin, its content pushed right and down by the canvas offset.
            self.covered = self.host.cover(cl, (cl.left - self.canvas.left, cl.top - self.canvas.top));
        }
        self.host.reset_webview();
        self.phase = Phase::Ending;
        self.post(false, RECT { left: 0, top: 0, right: cl.right - cl.left, bottom: cl.bottom - cl.top });
        self.trace(&format!("end ({} steps applied by the cap)", self.capped));
        After::Resized
    }

    /// Give the drag to the normal path: the webview takes the window's rect at once, and the
    /// window takes `to` (else the newest rect asked for). `why` = a failure, logged and counted.
    fn hand_back(&mut self, why: Option<&str>, to: Option<RECT>) -> After {
        if self.phase == Phase::Idle {
            return After::None;
        }
        if let Some(why) = why {
            eprintln!("[atlas] frame sync: {why}; this drag continues without it");
            if self.acks == 0 {
                self.failures += 1;
            }
        }
        let to = to.or(self.wanted.take()).or(self.in_flight.take());
        self.wanted = None;
        self.in_flight = None;
        self.host.reset_webview();
        // The page unpins once its viewport is the size the window ends at.
        let cl = match to {
            Some(r) => self.client_of(r),
            None => self.host.client(),
        };
        self.post(false, RECT { left: 0, top: 0, right: cl.right - cl.left, bottom: cl.bottom - cl.top });
        self.waiting = None; // nobody waits for this one
        self.stop_confirm();
        self.uncover();
        self.host.tick_timer(false);
        self.phase = Phase::Idle;
        After::HandBack(to)
    }

    fn abort(&mut self, why: &str) -> After {
        self.hand_back(Some(why), None)
    }

    fn post(&mut self, live: bool, frame: RECT) {
        self.seq += 1;
        let (vw, vh) = if live {
            match self.phase {
                Phase::Arming => (frame.right - frame.left, frame.bottom - frame.top),
                _ => (self.canvas.right - self.canvas.left, self.canvas.bottom - self.canvas.top),
            }
        } else {
            (frame.right - frame.left, frame.bottom - frame.top)
        };
        let ok = self.host.post(&Frame { seq: self.seq, live, frame, vw, vh });
        self.waiting = Some((self.seq, Instant::now()));
        if !ok {
            self.post_failed = true;
        }
        self.trace(&format!("post {} live={live} frame {:?}{}", self.seq, rect_tuple(frame), if ok { "" } else { " (not delivered)" }));
    }
}

// ---------------------------------------------------------------------------------------------
// The window side.

struct Win {
    top: HWND,
    container: HWND,
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    overlay: Option<HWND>,
    overlay_up: bool,
    /// The cover's picture, shrunk, to tell the page's new frame from the old one moved.
    cover: Option<Cover>,
    tick: usize,
    confirm: usize,
}

thread_local! {
    static SYNC: RefCell<Option<Machine<Win>>> = const { RefCell::new(None) };
}

unsafe fn attach(controller: ICoreWebView2Controller) -> windows::core::Result<()> {
    let mut container = HWND::default();
    controller.ParentWindow(&mut container)?;
    let top = GetAncestor(container, GA_ROOT);
    if top.is_invalid() || top == container {
        return Err(windows::core::Error::from_hresult(windows::core::HRESULT(-1)));
    }
    let webview = controller.CoreWebView2()?;
    // The page answers through the `frame_ack` command, not a WebMessage: wry's own
    // WebMessageReceived handler runs first and fails on any message that is not a string, which
    // stops WebView2 from calling the handlers after it (proven 2026-11-09), and a string would
    // reach Tauri's IPC parser and come back as a console error on every step.
    let overlay = create_overlay(top);
    let host = Win { top, container, controller, webview, overlay, overlay_up: false, cover: None, tick: 0, confirm: 0 };
    let log = std::env::var("ATLAS_FRAME_SYNC_LOG").as_deref() == Ok("1");
    SYNC.with(|c| *c.borrow_mut() = Some(Machine::new(host, step_cap(), log)));
    if !SetWindowSubclass(top, Some(subclass_proc), SUBCLASS_ID, 0).as_bool() {
        SYNC.with(|c| *c.borrow_mut() = None);
        return Err(windows::core::Error::from_thread());
    }
    eprintln!("[atlas] frame sync: on");
    Ok(())
}

unsafe extern "system" fn subclass_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM, _id: usize, _data: usize) -> LRESULT {
    match msg {
        WM_SYSCOMMAND if (wp.0 as u32 & 0xFFF0) == SC_SIZE => {
            with(|m| {
                if m.failures < 3 && !IsZoomed(m.host.top).as_bool() {
                    m.sizing_edge = Some(wp.0 as u32 & 0x000F);
                }
            });
        }
        WM_ENTERSIZEMOVE => {
            let r = DefSubclassProc(hwnd, msg, wp, lp);
            with(|m| {
                if let Some(edge) = m.sizing_edge.take() {
                    if m.phase == Phase::Idle {
                        let (window, client, monitor, min) = m.host.geometry();
                        m.begin(edge, window, client, monitor, min);
                    }
                }
            });
            return r;
        }
        WM_GETMINMAXINFO => {
            let r = DefSubclassProc(hwnd, msg, wp, lp);
            // tao sizes the minimum for an undecorated window's client area, but this window keeps
            // its invisible resize borders: add them, or the client stops that much under the
            // minimum and the app then grows it back from the top-left corner, sliding the far edge.
            if !IsZoomed(hwnd).as_bool() && !IsIconic(hwnd).as_bool() {
                let (bw, bh) = border_size(hwnd);
                let mmi = &mut *(lp.0 as *mut MINMAXINFO);
                mmi.ptMinTrackSize.x += bw;
                mmi.ptMinTrackSize.y += bh;
            }
            return r;
        }
        WM_SIZING => {
            let rect = &mut *(lp.0 as *mut RECT);
            if let Some(h) = with(|m| m.on_sizing(*rect)).flatten() {
                *rect = h;
                return LRESULT(1);
            }
        }
        WM_WINDOWPOSCHANGING => {
            let wp_ = &mut *(lp.0 as *mut WINDOWPOS);
            if !wp_.flags.contains(SWP_NOSIZE) || !wp_.flags.contains(SWP_NOMOVE) {
                let to = RECT { left: wp_.x, top: wp_.y, right: wp_.x + wp_.cx, bottom: wp_.y + wp_.cy };
                if let Some(h) = with(|m| m.keep_on_move(to)).flatten() {
                    wp_.x = h.left;
                    wp_.y = h.top;
                    wp_.cx = h.right - h.left;
                    wp_.cy = h.bottom - h.top;
                }
            }
        }
        WM_SIZE => {
            let handled = with(|m| {
                if m.pinned() {
                    m.host.pin_container(m.canvas);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(false);
            // Skip wry's handler (it would put the webview back to the window's rect); tao hears
            // the final size when the drag ends.
            if handled {
                return LRESULT(0);
            }
        }
        WM_EXITSIZEMOVE => {
            let r = DefSubclassProc(hwnd, msg, wp, lp);
            drive(|m| m.on_exit());
            return r;
        }
        WM_DPICHANGED => {
            drive(|m| m.abort("dpi change"));
        }
        WM_NCDESTROY => {
            // Nothing may keep firing for a window that is gone.
            with(|m| {
                m.host.tick_timer(false);
                m.host.confirm_timer(false);
            });
            let _ = RemoveWindowSubclass(hwnd, Some(subclass_proc), SUBCLASS_ID);
            SYNC.with(|c| {
                if let Ok(mut g) = c.try_borrow_mut() {
                    *g = None;
                }
            });
        }
        _ => {}
    }
    DefSubclassProc(hwnd, msg, wp, lp)
}

fn with<R>(f: impl FnOnce(&mut Machine<Win>) -> R) -> Option<R> {
    SYNC.with(|c| c.try_borrow_mut().ok().and_then(|mut g| g.as_mut().map(f)))
}

/// Run a machine step, then what it asks for once the state is released; an applied step is
/// followed by the next one.
fn drive(f: impl FnOnce(&mut Machine<Win>) -> After) {
    let mut after = with(f).unwrap_or(After::None);
    loop {
        let applied = matches!(after, After::Apply(_));
        run(after);
        if !applied {
            break;
        }
        after = with(|m| m.next()).unwrap_or(After::None);
    }
}

fn run(after: After) {
    let Some(top) = with(|m| m.host.top) else { return };
    let apply = |r: RECT| unsafe {
        let _ = SetWindowPos(top, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
    };
    let resized = || unsafe {
        let mut c = RECT::default();
        let _ = GetClientRect(top, &mut c);
        let lp = ((c.bottom as u32 & 0xFFFF) << 16) | (c.right as u32 & 0xFFFF);
        SendMessageW(top, WM_SIZE, Some(WPARAM(SIZE_RESTORED as usize)), Some(LPARAM(lp as isize)));
    };
    match after {
        After::None => {}
        After::Apply(r) => apply(r),
        After::Resized => resized(),
        After::HandBack(to) => {
            if let Some(r) = to {
                apply(r);
            }
            resized();
        }
    }
}

/// The page has drawn the frame for message `seq`. UI thread only (a sync Tauri command runs
/// there); from any other thread it does nothing and the cap carries the drag.
pub fn on_ack(seq: u64, via: u8) {
    drive(|m| m.on_ack(seq, via));
}

unsafe extern "system" fn tick_proc(_: HWND, _: u32, _: usize, _: u32) {
    drive(|m| m.tick(Instant::now()));
}

/// The page has drawn its frame under the cover, but WebView2 puts it on screen on its own
/// schedule: until it does, the window still shows the old frame at the webview's new origin.
/// Check what the window actually shows and take the cover down once it is the new frame.
unsafe extern "system" fn confirm_proc(_: HWND, _: u32, _: usize, _: u32) {
    drive(|m| {
        if m.confirm.is_none() {
            m.host.confirm_timer(false);
            return After::None;
        }
        let t = Instant::now();
        let sample = m.host.shows_new_frame();
        if let Some((new, old)) = sample {
            m.trace(&format!("check: diff to new frame {new:.2}, to old frame {old:.2} ({:.1} ms)", t.elapsed().as_secs_f64() * 1000.0));
        }
        m.confirm_check(sample)
    });
}

impl Win {
    /// Window rect, client rect, monitor rect, and the minimum window size (the size loop's own,
    /// asked the same way it asks).
    fn geometry(&self) -> (RECT, RECT, RECT, (i32, i32)) {
        unsafe {
            let mut wr = RECT::default();
            let _ = GetWindowRect(self.top, &mut wr);
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            let _ = GetMonitorInfoW(MonitorFromWindow(self.top, MONITOR_DEFAULTTONEAREST), &mut mi);
            let mut mmi = MINMAXINFO::default();
            SendMessageW(self.top, WM_GETMINMAXINFO, None, Some(LPARAM(&mut mmi as *mut MINMAXINFO as isize)));
            (wr, self.client(), mi.rcMonitor, (mmi.ptMinTrackSize.x, mmi.ptMinTrackSize.y))
        }
    }

    /// Keep the webview where it is on screen while the window's client origin moves under it.
    fn pin_container(&self, canvas: RECT) {
        let cl = self.client();
        unsafe {
            let _ = SetWindowPos(
                self.container,
                None,
                canvas.left - cl.left,
                canvas.top - cl.top,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    /// The difference between what the window shows now and the cover's picture, unmoved and
    /// moved by the webview origin's jump. Reads what DWM composes for the client area (the cover
    /// is a separate window and is not in it), shrunk before it is read back.
    fn shows_new_frame(&self) -> Option<(f64, f64)> {
        let c = self.cover.as_ref()?;
        let now = unsafe { grab_client(self.top, c.full) }?;
        Some((mean_diff(&now, &c.px, c.w, c.h, (0, 0)), mean_diff(&now, &c.px, c.w, c.h, c.shift)))
    }
}

impl Host for Win {
    fn client(&self) -> RECT {
        unsafe {
            let mut c = RECT::default();
            let _ = GetClientRect(self.top, &mut c);
            let mut p = POINT::default();
            let _ = ClientToScreen(self.top, &mut p);
            RECT { left: p.x, top: p.y, right: p.x + c.right, bottom: p.y + c.bottom }
        }
    }

    fn post(&mut self, f: &Frame) -> bool {
        let json = format!(
            r#"{{"atlasFrame":{{"seq":{},"live":{},"x":{},"y":{},"w":{},"h":{},"vw":{},"vh":{}}}}}"#,
            f.seq,
            f.live,
            f.frame.left,
            f.frame.top,
            f.frame.right - f.frame.left,
            f.frame.bottom - f.frame.top,
            f.vw,
            f.vh
        );
        let msg = HSTRING::from(json.as_str());
        unsafe { self.webview.PostWebMessageAsJson(PCWSTR(msg.as_ptr())) }.is_ok()
    }

    fn grow(&mut self, canvas: RECT, cl: RECT) {
        let (cw, ch) = (canvas.right - canvas.left, canvas.bottom - canvas.top);
        unsafe {
            let _ = SetWindowPos(self.container, None, canvas.left - cl.left, canvas.top - cl.top, cw, ch, SWP_NOZORDER | SWP_NOACTIVATE);
            let _ = self.controller.SetBounds(RECT { left: 0, top: 0, right: cw, bottom: ch });
        }
    }

    fn reset_webview(&mut self) {
        let cl = self.client();
        let (w, h) = (cl.right - cl.left, cl.bottom - cl.top);
        unsafe {
            let _ = SetWindowPos(self.container, None, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            let _ = self.controller.SetBounds(RECT { left: 0, top: 0, right: w, bottom: h });
        }
    }

    fn cover(&mut self, cl: RECT, shift: (i32, i32)) -> bool {
        let Some(ov) = self.overlay else { return false };
        let (w, h) = (cl.right - cl.left, cl.bottom - cl.top);
        unsafe {
            let screen = GetDC(None);
            let mem = CreateCompatibleDC(Some(screen));
            let bmp = CreateCompatibleBitmap(screen, w, h);
            let old = SelectObject(mem, bmp.into());
            let _ = BitBlt(mem, 0, 0, w, h, Some(screen), cl.left, cl.top, SRCCOPY);
            let pt = POINT { x: cl.left, y: cl.top };
            let size = SIZE { cx: w, cy: h };
            let src = POINT::default();
            let _ = UpdateLayeredWindow(ov, Some(screen), Some(&pt), Some(&size), Some(mem), Some(&src), COLORREF(0), None, ULW_OPAQUE);
            self.cover = shrink(screen, mem, w, h)
                .map(|(px, sw, sh)| Cover { px, w: sw, h: sh, full: (w, h), shift: (shift.0 / CHECK_SCALE, shift.1 / CHECK_SCALE) });
            SelectObject(mem, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            let _ = SetWindowPos(ov, Some(HWND_TOP), cl.left, cl.top, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            // The cover must be on screen before the webview moves under it.
            let _ = DwmFlush();
        }
        self.overlay_up = true;
        self.cover.is_some()
    }

    fn uncover(&mut self) {
        if !self.overlay_up {
            return;
        }
        if let Some(ov) = self.overlay {
            // No DwmFlush: the check has already seen the page's new frame composed under it.
            unsafe {
                let _ = ShowWindow(ov, SW_HIDE);
            }
        }
        self.overlay_up = false;
        self.cover = None;
    }

    fn tick_timer(&mut self, on: bool) {
        self.tick = set_timer(self.tick, on, TICK_MS, tick_proc);
    }

    fn confirm_timer(&mut self, on: bool) {
        self.confirm = set_timer(self.confirm, on, CONFIRM_EVERY_MS, confirm_proc);
    }
}

/// Window size minus client size: the invisible resize borders.
unsafe fn border_size(hwnd: HWND) -> (i32, i32) {
    let (mut wr, mut cr) = (RECT::default(), RECT::default());
    let _ = GetWindowRect(hwnd, &mut wr);
    let _ = GetClientRect(hwnd, &mut cr);
    (((wr.right - wr.left) - cr.right).max(0), ((wr.bottom - wr.top) - cr.bottom).max(0))
}

type TimerProc =unsafe extern "system" fn(HWND, u32, usize, u32);

/// A thread timer on or off; returns its id (0 when off).
fn set_timer(id: usize, on: bool, every_ms: u32, proc_: TimerProc) -> usize {
    unsafe {
        match (on, id) {
            (true, 0) => SetTimer(None, 0, every_ms, Some(proc_)),
            (false, id) if id != 0 => {
                let _ = KillTimer(None, id);
                0
            }
            (_, id) => id,
        }
    }
}

struct Cover {
    /// 32-bit BGRX rows, top-down, shrunk by CHECK_SCALE.
    px: Vec<u8>,
    w: i32,
    h: i32,
    /// The client size the picture was taken at.
    full: (i32, i32),
    /// Where a stale webview frame would put the picture, in shrunk pixels.
    shift: (i32, i32),
}

unsafe fn read_bits(dc: HDC, bmp: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    let mut bi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut px = vec![0u8; (w.max(0) * h.max(0) * 4) as usize];
    let n = GetDIBits(dc, bmp, 0, h as u32, Some(px.as_mut_ptr().cast()), &mut bi, DIB_RGB_COLORS);
    (n == h).then_some(px)
}

/// The `w` x `h` picture selected into `src`, every CHECK_SCALE-th pixel each way, read back.
unsafe fn shrink(screen: HDC, src: HDC, w: i32, h: i32) -> Option<(Vec<u8>, i32, i32)> {
    let (sw, sh) = ((w / CHECK_SCALE).max(1), (h / CHECK_SCALE).max(1));
    let dc = CreateCompatibleDC(Some(screen));
    let bmp = CreateCompatibleBitmap(screen, sw, sh);
    let old = SelectObject(dc, bmp.into());
    SetStretchBltMode(dc, COLORONCOLOR);
    let ok = StretchBlt(dc, 0, 0, sw, sh, Some(src), 0, 0, sw * CHECK_SCALE, sh * CHECK_SCALE, SRCCOPY).as_bool();
    SelectObject(dc, old);
    let px = if ok { read_bits(screen, bmp, sw, sh) } else { None };
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(dc);
    px.map(|p| (p, sw, sh))
}

/// The window's client area as DWM composes it (the webview's presented frame included), shrunk.
unsafe fn grab_client(top: HWND, (w, h): (i32, i32)) -> Option<Vec<u8>> {
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let bmp = CreateCompatibleBitmap(screen, w, h);
    let old = SelectObject(mem, bmp.into());
    let ok = PrintWindow(top, mem, PW_CLIENT_FULL).as_bool();
    let px = if ok { shrink(screen, mem, w, h).map(|(p, _, _)| p) } else { None };
    SelectObject(mem, old);
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    px
}

/// Mean absolute channel difference between `a` and `b` moved by `shift` (a[x, y] against
/// b[x - dx, y - dy]) over the overlap.
fn mean_diff(a: &[u8], b: &[u8], w: i32, h: i32, shift: (i32, i32)) -> f64 {
    let (dx, dy) = shift;
    let (mut sum, mut n) = (0u64, 0u64);
    for y in dy.max(0)..h.min(h + dy) {
        for x in dx.max(0)..w.min(w + dx) {
            let i = ((y * w + x) * 4) as usize;
            let j = (((y - dy) * w + (x - dx)) * 4) as usize;
            for k in 0..3 {
                sum += (a[i + k] as i32 - b[j + k] as i32).unsigned_abs() as u64;
            }
            n += 3;
        }
    }
    if n == 0 { f64::INFINITY } else { sum as f64 / n as f64 }
}

fn offset(cl: RECT, canvas: RECT) -> RECT {
    RECT { left: cl.left - canvas.left, top: cl.top - canvas.top, right: cl.right - canvas.left, bottom: cl.bottom - canvas.top }
}

fn rect_tuple(r: RECT) -> (i32, i32, i32, i32) {
    (r.left, r.top, r.right - r.left, r.bottom - r.top)
}

unsafe extern "system" fn overlay_proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wp, lp)
}

unsafe fn create_overlay(owner: HWND) -> Option<HWND> {
    let inst = GetModuleHandleW(None).ok()?;
    let class = w!("AtlasFrameCover");
    let wc = WNDCLASSW { lpfnWndProc: Some(overlay_proc), hInstance: inst.into(), lpszClassName: class, ..Default::default() };
    RegisterClassW(&wc); // fails harmlessly if it is already registered
    let hwnd = CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
        class,
        PCWSTR::null(),
        WS_POPUP,
        0,
        0,
        1,
        1,
        Some(owner),
        None,
        Some(inst.into()),
        None,
    )
    .ok()?;
    // Square corners: the picture already holds the window's own rounded ones.
    let pref = DWMWCP_DONOTROUND;
    let _ = DwmSetWindowAttribute(
        hwnd,
        DWMWA_WINDOW_CORNER_PREFERENCE,
        &pref as *const _ as *const core::ffi::c_void,
        std::mem::size_of_val(&pref) as u32,
    );
    Some(hwnd)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The window and webview as the machine sees them: a window rect that moves when the driver
    /// applies a step, and a record of every call.
    struct Fake {
        win: RECT,
        ins: RECT,
        posts: Vec<Frame>,
        post_ok: bool,
        grown: bool,
        covers: u32,
        cover_up: bool,
        tick: bool,
        confirm: bool,
    }

    impl Host for Fake {
        fn client(&self) -> RECT {
            let (r, i) = (self.win, self.ins);
            RECT { left: r.left + i.left, top: r.top + i.top, right: r.right + i.right, bottom: r.bottom + i.bottom }
        }
        fn post(&mut self, f: &Frame) -> bool {
            self.posts.push(*f);
            self.post_ok
        }
        fn grow(&mut self, _: RECT, _: RECT) {
            self.grown = true;
        }
        fn reset_webview(&mut self) {
            self.grown = false;
        }
        fn cover(&mut self, _: RECT, _: (i32, i32)) -> bool {
            self.covers += 1;
            self.cover_up = true;
            true
        }
        fn uncover(&mut self) {
            self.cover_up = false;
        }
        fn tick_timer(&mut self, on: bool) {
            self.tick = on;
        }
        fn confirm_timer(&mut self, on: bool) {
            self.confirm = on;
        }
    }

    const MONITOR: RECT = RECT { left: 0, top: 0, right: 2560, bottom: 1440 };
    /// An 8 px invisible frame on the sides and bottom, as Windows 11 gives the window.
    const INSETS: RECT = RECT { left: 8, top: 0, right: -8, bottom: -8 };
    /// A 900 x 600 client plus those borders.
    const MIN: (i32, i32) = (916, 608);

    fn rect(l: i32, t: i32, r: i32, b: i32) -> RECT {
        RECT { left: l, top: t, right: r, bottom: b }
    }

    fn machine() -> Machine<Fake> {
        let host = Fake {
            win: rect(300, 200, 1400, 960),
            ins: INSETS,
            posts: Vec::new(),
            post_ok: true,
            grown: false,
            covers: 0,
            cover_up: false,
            tick: false,
            confirm: false,
        };
        Machine::new(host, STEP_CAP, false)
    }

    /// What the real driver does with an `After`: apply steps (and send the next one), hand back.
    fn settle(m: &mut Machine<Fake>, mut after: After) {
        loop {
            match after {
                After::Apply(r) => {
                    m.host.win = r;
                    after = m.next();
                }
                After::HandBack(Some(r)) => {
                    m.host.win = r;
                    return;
                }
                _ => return,
            }
        }
    }

    fn begin(m: &mut Machine<Fake>, edge: u32) {
        let win = m.host.win;
        let cl = m.host.client();
        m.begin(edge, win, cl, MONITOR, MIN);
    }

    fn ack_last(m: &mut Machine<Fake>) {
        let seq = m.host.posts.last().expect("a message was sent").seq;
        let after = m.on_ack(seq, 1);
        settle(m, after);
    }

    /// Begin a drag on `edge` and answer until it is live.
    fn live(edge: u32) -> Machine<Fake> {
        let mut m = machine();
        begin(&mut m, edge);
        ack_last(&mut m); // arming -> growing
        ack_last(&mut m); // growing -> live, or -> cover check
        if m.confirm.is_some() {
            let after = m.confirm_check(Some((0.0, 30.0)));
            settle(&mut m, after);
        }
        assert_eq!(m.phase, Phase::Live);
        m
    }

    fn assert_idle(m: &Machine<Fake>) {
        assert_eq!(m.phase, Phase::Idle);
        assert!(!m.host.tick, "the tick timer is left running");
        assert!(!m.host.confirm, "the confirm timer is left running");
        assert!(!m.host.grown, "the webview is left at the canvas size");
        assert!(!m.host.cover_up, "the cover is left up");
        let last = m.host.posts.last().unwrap();
        assert!(!last.live, "the page is left pinned");
    }

    #[test]
    fn a_left_drag_runs_start_to_end() {
        let mut m = live(WMSZ_LEFT);
        assert_eq!(m.host.covers, 1, "a left drag covers the webview's move to the canvas");
        let to = rect(250, 200, 1400, 960);
        assert_eq!(m.on_sizing(to), Some(rect(300, 200, 1400, 960)), "the window waits for the page");
        assert_eq!(m.in_flight, Some(to));
        ack_last(&mut m);
        assert_eq!(m.host.win, to);
        let a = m.on_exit();
        settle(&mut m, a);
        assert_eq!(m.phase, Phase::Ending);
        ack_last(&mut m);
        assert!(m.confirm.is_some(), "the cover stays until the window shows the new frame");
        let after = m.confirm_check(Some((0.2, 25.0)));
        settle(&mut m, after);
        assert_idle(&m);
        let last = m.host.posts.last().unwrap();
        assert_eq!((last.vw, last.vh), (1100 - 16 + 50, 760 - 8));
    }

    #[test]
    fn a_step_already_at_the_monitor_edge_still_lets_the_drag_end() {
        // Flick the right edge past the monitor while a step at the clamped edge is in flight.
        let mut m = live(WMSZ_RIGHT);
        let at_edge = rect(300, 200, 2568, 960); // client right = 2560, the monitor's edge
        m.on_sizing(at_edge);
        let past = rect(300, 200, 2600, 960);
        m.on_sizing(past); // waits behind the step in flight
        let a = m.on_exit();
        settle(&mut m, a);
        assert_eq!(m.phase, Phase::Live);
        ack_last(&mut m); // applies the step; the next one is clamped to the same rect
        assert_idle(&m);
        assert_eq!(m.host.win, past, "the window ends where the mouse let go");
    }

    #[test]
    fn a_capped_step_at_the_monitor_edge_still_lets_the_drag_end() {
        let mut m = live(WMSZ_RIGHT);
        m.on_sizing(rect(300, 200, 2568, 960));
        m.on_sizing(rect(300, 200, 2600, 960));
        let a = m.on_exit();
        settle(&mut m, a);
        let after = m.tick(Instant::now() + STEP_CAP);
        settle(&mut m, after);
        assert_eq!(m.capped, 1);
        assert_idle(&m);
    }

    #[test]
    fn a_drag_inside_the_monitor_ends_through_the_page() {
        let mut m = live(WMSZ_RIGHT);
        m.on_sizing(rect(300, 200, 1500, 960));
        ack_last(&mut m);
        let a = m.on_exit();
        settle(&mut m, a);
        assert_eq!(m.phase, Phase::Ending, "no hand-back while the drag stays on the canvas");
        ack_last(&mut m);
        assert_idle(&m);
    }

    #[test]
    fn a_message_that_cannot_be_delivered_while_arming_hands_the_drag_back() {
        let mut m = machine();
        m.host.post_ok = false;
        begin(&mut m, WMSZ_LEFT);
        assert!(m.host.tick);
        let after = m.tick(Instant::now());
        settle(&mut m, after);
        assert_idle(&m);
        assert_eq!(m.failures, 1);
        // The next drag starts clean.
        m.host.post_ok = true;
        begin(&mut m, WMSZ_LEFT);
        assert!(!m.post_failed);
    }

    #[test]
    fn a_page_that_never_answers_the_arming_message_hands_the_drag_back() {
        let mut m = machine();
        begin(&mut m, WMSZ_LEFT);
        let a = m.tick(Instant::now());
        settle(&mut m, a);
        assert_eq!(m.phase, Phase::Arming);
        let a = m.tick(Instant::now() + STEP_CAP);
        settle(&mut m, a);
        assert_idle(&m);
    }

    #[test]
    fn a_mid_drag_abort_unpins_the_page_at_the_size_the_window_ends_at() {
        let mut m = live(WMSZ_LEFT);
        let to = rect(250, 200, 1400, 960);
        m.on_sizing(to);
        let after = m.abort("dpi change");
        assert_eq!(after, After::HandBack(Some(to)));
        settle(&mut m, after);
        assert_idle(&m);
        let last = m.host.posts.last().unwrap();
        assert_eq!((last.frame.right, last.frame.bottom), (1150 - 16, 760 - 8));
        assert_eq!((last.vw, last.vh), (1150 - 16, 760 - 8));
    }

    #[test]
    fn a_click_on_the_edge_without_moving_does_nothing_heavy() {
        let mut m = machine();
        begin(&mut m, WMSZ_LEFT);
        assert_eq!(m.on_exit(), After::None);
        assert_idle(&m);
        assert_eq!(m.host.covers, 0);
        assert_eq!(m.failures, 0, "a click is not a failure");
        // The arming answer arriving late changes nothing.
        let seq = m.host.posts[0].seq;
        assert_eq!(m.on_ack(seq, 1), After::None);
        assert!(!m.host.grown);
    }

    #[test]
    fn a_drag_past_the_minimum_stops_dead_without_sliding_the_window() {
        // The window is 1100 x 760 at (300, 200); the minimum is 916 x 608.
        for (edge, past, stop) in [
            (WMSZ_LEFT, rect(600, 200, 1400, 960), rect(484, 200, 1400, 960)),
            (WMSZ_TOP, rect(300, 500, 1400, 960), rect(300, 352, 1400, 960)),
            (WMSZ_TOPLEFT, rect(600, 500, 1400, 960), rect(484, 352, 1400, 960)),
            (WMSZ_RIGHT, rect(300, 200, 1000, 960), rect(300, 200, 1216, 960)),
            (WMSZ_BOTTOM, rect(300, 200, 1400, 500), rect(300, 200, 1400, 808)),
        ] {
            let mut m = live(edge);
            m.on_sizing(past);
            ack_last(&mut m);
            assert_eq!(m.host.win, stop, "edge {edge}");
            // Still past the minimum: nothing moves at all.
            m.on_sizing(past);
            assert!(m.waiting.is_none(), "edge {edge}: a step was sent for a window that cannot change");
            assert_eq!(m.host.win, stop);
            let a = m.on_exit();
            settle(&mut m, a);
            ack_last(&mut m);
            assert_eq!(m.host.win, stop, "edge {edge}: the drag ended somewhere else");
        }
    }

    #[test]
    fn a_slow_answer_applies_the_step_and_the_next_quick_one_is_synced_again() {
        let mut m = live(WMSZ_RIGHT);
        m.on_sizing(rect(300, 200, 1450, 960));
        let a = m.tick(Instant::now() + STEP_CAP);
        settle(&mut m, a);
        assert_eq!((m.capped, m.host.win.right), (1, 1450));
        m.on_sizing(rect(300, 200, 1500, 960));
        assert_eq!(m.host.win.right, 1450, "the next step waits for the page again");
        ack_last(&mut m);
        assert_eq!((m.capped, m.host.win.right), (1, 1500));
    }

    #[test]
    fn a_slow_answer_applies_the_step_while_live_and_hands_back_before() {
        let ms = Duration::from_millis;
        assert_eq!(late_action(Phase::Live, ms(20), STEP_CAP), Late::Wait);
        assert_eq!(late_action(Phase::Live, ms(149), STEP_CAP), Late::Wait);
        assert_eq!(late_action(Phase::Live, ms(150), STEP_CAP), Late::ApplyStep);
        assert_eq!(late_action(Phase::Arming, ms(160), STEP_CAP), Late::HandBack);
        assert_eq!(late_action(Phase::Growing, ms(160), STEP_CAP), Late::HandBack);
        assert_eq!(late_action(Phase::Arming, ms(100), STEP_CAP), Late::Wait);
        // After the drag the window already has its size: wait longer before giving up on the page.
        assert_eq!(late_action(Phase::Ending, ms(200), STEP_CAP), Late::Wait);
        assert_eq!(late_action(Phase::Ending, ms(400), STEP_CAP), Late::HandBack);
        assert_eq!(late_action(Phase::Idle, ms(5000), STEP_CAP), Late::Wait);
        // A test override changes the live step only; arming still waits the full cap.
        assert_eq!(late_action(Phase::Live, ms(2), ms(1)), Late::ApplyStep);
        assert_eq!(late_action(Phase::Arming, ms(2), ms(1)), Late::Wait);
    }

    /// A 16x16 picture, dark left of `edge`, light from it on.
    fn pic(edge: i32) -> Vec<u8> {
        let mut v = Vec::new();
        for _y in 0..16 {
            for x in 0..16 {
                let c = if x < edge { 20 } else { 220 };
                v.extend_from_slice(&[c, c, c, 0]);
            }
        }
        v
    }

    #[test]
    fn tells_the_new_frame_from_the_old_one_moved() {
        let cover = pic(8);
        assert_eq!(mean_diff(&cover, &cover, 16, 16, (0, 0)), 0.0);
        // the old frame at the webview's new origin: everything pushed right by 4
        let stale = pic(12);
        assert!(mean_diff(&stale, &cover, 16, 16, (0, 0)) > 40.0);
        assert_eq!(mean_diff(&stale, &cover, 16, 16, (4, 0)), 0.0);
        // and pushed up-left (the start of a left drag)
        assert_eq!(mean_diff(&pic(4), &cover, 16, 16, (-4, 0)), 0.0);
    }
}
