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
//!   the page answers that a frame laid out for it has been drawn (two animation frames after the
//!   change, sent back through the `frame_ack` command). The window trails the mouse by that answer, as native
//!   windows do, and never shows a frame that does not belong to its size.
//!
//! The canvas has to start left of or above the window for a left or top drag, and the webview
//! goes back to the window's own rect when the drag ends. Both moves change the webview's origin,
//! which no page frame can hide, so a still picture of the window covers it for that one swap (a
//! layered popup filled from the screen, taken down when the page answers).
//!
//! Nothing here runs outside an edge drag; moves, snaps, maximize and code-driven resizes take the
//! normal path. `ATLAS_FRAME_SYNC=0` turns it off (A/B), `ATLAS_FRAME_SYNC_LOG=1` traces it. A page
//! that stops answering hands the drag back to the normal path after `ACK_TIMEOUT`.

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
    GetMonitorInfoW, MonitorFromWindow, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
    HDC, MONITORINFO, MONITOR_DEFAULTTONEAREST, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetAncestor, GetClientRect, GetWindowRect, IsZoomed, KillTimer, RegisterClassW, SendMessageW,
    SetTimer, SetWindowPos, ShowWindow, UpdateLayeredWindow, GA_ROOT, HWND_TOP, SC_SIZE, SIZE_RESTORED, SWP_NOACTIVATE, SWP_NOSIZE,
    SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE, ULW_OPAQUE, WM_DPICHANGED, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCDESTROY, WM_SIZE,
    WM_SIZING, WM_SYSCOMMAND, WM_WINDOWPOSCHANGING, WINDOWPOS, SWP_NOMOVE, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
    WMSZ_BOTTOM, WMSZ_BOTTOMRIGHT, WMSZ_RIGHT,
};

const SUBCLASS_ID: usize = 0x4154_4C46; // "ATLF"
/// A page that has not answered in this long gets the drag handed back to the normal path.
const ACK_TIMEOUT: Duration = Duration::from_millis(400);
/// How often, and how many times, the cover checks that the window shows the page's new frame.
const CONFIRM_EVERY_MS: u32 = 10;
const CONFIRM_TRIES: u32 = 30;
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

struct Sync {
    top: HWND,
    container: HWND,
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    overlay: Option<HWND>,
    overlay_up: bool,
    /// The cover's picture, and where a stale webview frame would put that picture (the webview
    /// origin's move), to tell the page's new frame from the old one.
    cover: Option<Cover>,
    /// The phase to enter once the window shows the page's new frame, the check timer, tries.
    confirm: Option<(Phase, usize, u32)>,
    phase: Phase,
    /// `WM_SYSCOMMAND SC_SIZE` was seen: the next size-move loop is an edge drag. Its low bits
    /// name the edge (WMSZ_*), 0 for keyboard sizing.
    sizing_edge: Option<u32>,
    seq: u64,
    waiting: Option<(u64, Instant)>,
    /// The window rect sent to the page and not applied yet.
    in_flight: Option<RECT>,
    /// The newest rect the size loop asked for that the page has not been sent.
    wanted: Option<RECT>,
    /// The window rect on screen.
    held: RECT,
    /// Client rect minus window rect (both in screen coordinates), per side.
    insets: RECT,
    /// The webview's screen rect while live.
    canvas: RECT,
    exit: bool,
    /// The rect last handed back to the size loop from WM_SIZING.
    loop_rect: Option<RECT>,
    timer: usize,
    failures: u32,
    log: bool,
    t0: Instant,
}

thread_local! {
    static SYNC: RefCell<Option<Sync>> = const { RefCell::new(None) };
}

/// Something to do after the state is released: these calls send messages back into `proc`.
enum After {
    None,
    Apply(RECT),
    Resized,
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
    SYNC.with(|c| {
        *c.borrow_mut() = Some(Sync {
            top,
            container,
            controller,
            webview,
            overlay,
            overlay_up: false,
            cover: None,
            confirm: None,
            phase: Phase::Idle,
            sizing_edge: None,
            seq: 0,
            waiting: None,
            in_flight: None,
            wanted: None,
            held: RECT::default(),
            insets: RECT::default(),
            canvas: RECT::default(),
            exit: false,
            loop_rect: None,
            timer: 0,
            failures: 0,
            log: std::env::var("ATLAS_FRAME_SYNC_LOG").as_deref() == Ok("1"),
            t0: Instant::now(),
        })
    });
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
            with(|s| {
                if s.failures < 3 && !IsZoomed(s.top).as_bool() {
                    s.sizing_edge = Some(wp.0 as u32 & 0x000F);
                }
            });
        }
        WM_ENTERSIZEMOVE => {
            let r = DefSubclassProc(hwnd, msg, wp, lp);
            with(|s| {
                if let Some(edge) = s.sizing_edge.take() {
                    if s.phase == Phase::Idle {
                        s.begin(edge);
                    }
                }
            });
            return r;
        }
        WM_SIZING => {
            let rect = &mut *(lp.0 as *mut RECT);
            let held = with(|s| {
                if matches!(s.phase, Phase::Idle | Phase::Ending) {
                    return None;
                }
                s.wanted = Some(*rect);
                if s.phase == Phase::Live && s.waiting.is_none() {
                    if let Some(r) = s.wanted.take() {
                        s.request(r);
                    }
                }
                s.loop_rect = Some(s.held);
                Some(s.held)
            })
            .flatten();
            if let Some(h) = held {
                *rect = h; // the window keeps its size until the page has drawn the next one
                return LRESULT(1);
            }
        }
        WM_WINDOWPOSCHANGING => {
            // The size loop remembers the rect we last handed back from WM_SIZING and sets it once
            // more when the mouse is released. If an answer has moved the window on since, that
            // rect is stale: keep the window where the page has drawn it.
            let wp_ = &mut *(lp.0 as *mut WINDOWPOS);
            if !wp_.flags.contains(SWP_NOSIZE) || !wp_.flags.contains(SWP_NOMOVE) {
                let keep = with(|s| {
                    let stale = s.loop_rect?;
                    let to = RECT { left: wp_.x, top: wp_.y, right: wp_.x + wp_.cx, bottom: wp_.y + wp_.cy };
                    (s.phase != Phase::Idle && to == stale && stale != s.held).then_some(s.held)
                })
                .flatten();
                if let Some(h) = keep {
                    wp_.x = h.left;
                    wp_.y = h.top;
                    wp_.cx = h.right - h.left;
                    wp_.cy = h.bottom - h.top;
                }
            }
        }
        WM_SIZE => {
            let handled = with(|s| {
                if matches!(s.phase, Phase::Growing | Phase::Live) {
                    s.pin_container();
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
            let after = with(|s| {
                s.sizing_edge = None;
                if s.phase == Phase::Idle || s.phase == Phase::Ending {
                    return After::None;
                }
                s.exit = true;
                if s.phase == Phase::Live && s.waiting.is_none() {
                    s.finish()
                } else {
                    After::None
                }
            })
            .unwrap_or(After::None);
            run(after);
            return r;
        }
        WM_DPICHANGED => {
            abort("dpi change");
        }
        WM_NCDESTROY => {
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

fn with<R>(f: impl FnOnce(&mut Sync) -> R) -> Option<R> {
    SYNC.with(|c| c.try_borrow_mut().ok().and_then(|mut g| g.as_mut().map(f)))
}

fn run(after: After) {
    let Some(top) = with(|s| s.top) else { return };
    unsafe {
        match after {
            After::None => {}
            After::Apply(r) => {
                let _ = SetWindowPos(top, None, r.left, r.top, r.right - r.left, r.bottom - r.top, SWP_NOZORDER | SWP_NOACTIVATE);
            }
            After::Resized => {
                // tao (and the window-state plugin behind it) heard nothing during the drag.
                let mut c = RECT::default();
                let _ = GetClientRect(top, &mut c);
                let lp = ((c.bottom as u32 & 0xFFFF) << 16) | (c.right as u32 & 0xFFFF);
                SendMessageW(top, WM_SIZE, Some(WPARAM(SIZE_RESTORED as usize)), Some(LPARAM(lp as isize)));
            }
        }
    }
}

/// The page has drawn the frame for message `seq`. UI thread only (a sync Tauri command runs
/// there); from any other thread it does nothing and the drag times out to the normal path.
pub fn on_ack(seq: u64) {
    let after = with(|s| {
        match s.waiting {
            Some((want, _)) if want == seq => {}
            _ => return After::None,
        }
        s.waiting = None;
        s.trace(&format!("ack {seq} in {:?}", s.phase));
        match s.phase {
            Phase::Idle => After::None,
            Phase::Arming => {
                s.grow();
                After::None
            }
            Phase::Growing => s.confirm_then(Phase::Live),
            Phase::Live => match s.in_flight.take() {
                Some(r) => {
                    s.held = r;
                    After::Apply(r)
                }
                None => s.next(),
            },
            Phase::Ending => s.confirm_then(Phase::Idle),
        }
    })
    .unwrap_or(After::None);
    let applied = matches!(after, After::Apply(_));
    run(after);
    if applied {
        // The window has the page's size now: send the next step, or end.
        let after = with(|s| s.next()).unwrap_or(After::None);
        run(after);
    }
}

/// The page has drawn its frame under the cover, but WebView2 puts it on screen on its own
/// schedule: until it does, the window still shows the old frame at the webview's new origin.
/// Check what the window actually shows and take the cover down once it is the new frame.
unsafe extern "system" fn confirm_tick(_: HWND, _: u32, _: usize, _: u32) {
    let after = with(|s| {
        let (target, timer, tries) = s.confirm?;
        let shown = s.shows_new_frame();
        if !shown && tries + 1 < CONFIRM_TRIES {
            s.confirm = Some((target, timer, tries + 1));
            return None;
        }
        s.trace(&format!("{} after {} checks", if shown { "new frame on screen" } else { "new frame not confirmed" }, tries + 1));
        Some(s.enter(target))
    })
    .flatten();
    if let Some(after) = after {
        run(after);
    }
}

/// Deadlock guard only: a page that never answers must not freeze the window.
unsafe extern "system" fn tick(_: HWND, _: u32, _: usize, _: u32) {
    let late = with(|s| s.waiting.is_some_and(|(_, at)| at.elapsed() > ACK_TIMEOUT)).unwrap_or(false);
    if late {
        abort("no answer from the page");
    }
}

/// Hand the drag back to the normal path: the webview takes the window's rect at once.
fn abort(why: &str) {
    let after = with(|s| {
        if s.phase == Phase::Idle {
            return None;
        }
        eprintln!("[atlas] frame sync: {why}; this drag continues without it");
        s.failures += 1;
        let wanted = s.wanted.take().or(s.in_flight.take());
        s.waiting = None;
        s.reset_webview();
        s.post(false, RECT::default());
        s.waiting = None; // nobody waits for this one
        s.cancel_confirm();
        s.hide_overlay();
        s.stop_timer();
        s.phase = Phase::Idle;
        Some(wanted)
    })
    .flatten();
    match after {
        Some(Some(r)) => {
            run(After::Apply(r));
            run(After::Resized);
        }
        Some(None) => run(After::Resized),
        None => {}
    }
}

impl Sync {
    fn trace(&self, what: &str) {
        if self.log {
            eprintln!("[atlas] frame sync {:>7.1} ms: {what}", self.t0.elapsed().as_secs_f64() * 1000.0);
        }
    }

    fn client_screen(&self) -> RECT {
        unsafe {
            let mut c = RECT::default();
            let _ = GetClientRect(self.top, &mut c);
            let mut p = POINT::default();
            let _ = ClientToScreen(self.top, &mut p);
            RECT { left: p.x, top: p.y, right: p.x + c.right, bottom: p.y + c.bottom }
        }
    }

    fn begin(&mut self, edge: u32) {
        unsafe {
            let mut wr = RECT::default();
            let _ = GetWindowRect(self.top, &mut wr);
            let cl = self.client_screen();
            self.held = wr;
            self.insets = RECT {
                left: cl.left - wr.left,
                top: cl.top - wr.top,
                right: cl.right - wr.right,
                bottom: cl.bottom - wr.bottom,
            };
            // The canvas: the whole monitor around the window. A right or bottom drag never needs
            // anything left of or above the window, so its canvas starts at the window's corner
            // and the webview's origin never moves.
            let mut mi = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
            let _ = GetMonitorInfoW(MonitorFromWindow(self.top, MONITOR_DEFAULTTONEAREST), &mut mi);
            let m = mi.rcMonitor;
            let keeps_origin = matches!(edge, WMSZ_RIGHT | WMSZ_BOTTOM | WMSZ_BOTTOMRIGHT);
            self.canvas = RECT {
                left: if keeps_origin { cl.left } else { cl.left.min(m.left) },
                top: if keeps_origin { cl.top } else { cl.top.min(m.top) },
                right: cl.right.max(m.right),
                bottom: cl.bottom.max(m.bottom),
            };
        }
        self.exit = false;
        self.loop_rect = None;
        self.wanted = None;
        self.in_flight = None;
        self.t0 = Instant::now();
        self.trace(&format!("begin edge {edge}, canvas {:?}", rect_tuple(self.canvas)));
        self.phase = Phase::Arming;
        // Step 1: the page pins its layout to the window's rect, still inside the window-sized
        // webview, so growing the webview next changes nothing on screen.
        let cl = self.client_screen();
        self.post(true, RECT { left: 0, top: 0, right: cl.right - cl.left, bottom: cl.bottom - cl.top });
        self.timer = unsafe { SetTimer(None, 0, 100, Some(tick)) };
    }

    /// Step 2: grow the webview to the canvas. Its origin moves for a left or top drag, so a still
    /// picture of the window covers the swap.
    fn grow(&mut self) {
        let cl = self.client_screen();
        if self.canvas.left != cl.left || self.canvas.top != cl.top {
            // Until the page's canvas-sized frame is on screen, the old one sits at the canvas origin.
            self.show_overlay(cl, (self.canvas.left - cl.left, self.canvas.top - cl.top));
        }
        let (cw, ch) = (self.canvas.right - self.canvas.left, self.canvas.bottom - self.canvas.top);
        unsafe {
            let _ = SetWindowPos(
                self.container,
                None,
                self.canvas.left - cl.left,
                self.canvas.top - cl.top,
                cw,
                ch,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
            let _ = self.controller.SetBounds(RECT { left: 0, top: 0, right: cw, bottom: ch });
        }
        self.phase = Phase::Growing;
        self.post(true, offset(cl, self.canvas));
    }

    /// The page has answered for a frame drawn under the cover: wait until the window shows it
    /// (no cover: nothing to wait for), then enter `target`.
    fn confirm_then(&mut self, target: Phase) -> After {
        if !self.overlay_up || self.cover.is_none() {
            return self.enter(target);
        }
        let timer = unsafe { SetTimer(None, 0, CONFIRM_EVERY_MS, Some(confirm_tick)) };
        self.confirm = Some((target, timer, 0));
        After::None
    }

    fn enter(&mut self, target: Phase) -> After {
        self.cancel_confirm();
        self.hide_overlay();
        self.phase = target;
        match target {
            Phase::Live => self.next(),
            _ => {
                self.stop_timer();
                After::None
            }
        }
    }

    fn cancel_confirm(&mut self) {
        if let Some((_, timer, _)) = self.confirm.take() {
            unsafe {
                let _ = KillTimer(None, timer);
            }
        }
    }

    /// Does the window show the cover's picture (the page's new frame), rather than that picture
    /// moved by the webview origin's jump (the old frame)? Reads what DWM composes for the
    /// client area; the cover is a separate window and is not in it.
    fn shows_new_frame(&self) -> bool {
        let Some(c) = &self.cover else { return true };
        let Some(now) = (unsafe { grab_client(self.top, c.w, c.h) }) else { return true };
        let new = mean_diff(&now, &c.px, c.w, c.h, (0, 0));
        let old = mean_diff(&now, &c.px, c.w, c.h, c.shift);
        self.trace(&format!("check: diff to new frame {new:.2}, to old frame {old:.2}"));
        new < 1.0 || new * 3.0 < old
    }

    /// The next step of a live drag: the newest rect the size loop asked for, or the end.
    fn next(&mut self) -> After {
        if let Some(r) = self.wanted.take() {
            if r != self.held {
                self.request(r);
                return After::None;
            }
        }
        if self.exit {
            return self.finish();
        }
        After::None
    }

    fn request(&mut self, r: RECT) {
        // Keep the client inside the canvas (a drag past the monitor's edge stops there until
        // the drag ends).
        let i = self.insets;
        let mut cl = RECT { left: r.left + i.left, top: r.top + i.top, right: r.right + i.right, bottom: r.bottom + i.bottom };
        cl.left = cl.left.max(self.canvas.left);
        cl.top = cl.top.max(self.canvas.top);
        cl.right = cl.right.min(self.canvas.right);
        cl.bottom = cl.bottom.min(self.canvas.bottom);
        let r = RECT { left: cl.left - i.left, top: cl.top - i.top, right: cl.right - i.right, bottom: cl.bottom - i.bottom };
        if r == self.held {
            return;
        }
        self.in_flight = Some(r);
        self.post(true, offset(cl, self.canvas));
    }

    /// Keep the webview where it is on screen while the window's client origin moves under it.
    fn pin_container(&self) {
        let cl = self.client_screen();
        unsafe {
            let _ = SetWindowPos(
                self.container,
                None,
                self.canvas.left - cl.left,
                self.canvas.top - cl.top,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    /// The drag is over: the webview goes back to the window's own rect.
    fn finish(&mut self) -> After {
        if let Some(r) = self.wanted.take() {
            if r != self.held {
                self.request(r);
                return After::None;
            }
        }
        let cl = self.client_screen();
        if self.canvas.left != cl.left || self.canvas.top != cl.top {
            // Until the page's window-sized frame is on screen, the canvas frame sits at the
            // window's origin, its content pushed right and down by the canvas offset.
            self.show_overlay(cl, (cl.left - self.canvas.left, cl.top - self.canvas.top));
        }
        self.reset_webview();
        self.phase = Phase::Ending;
        self.post(false, RECT { left: 0, top: 0, right: cl.right - cl.left, bottom: cl.bottom - cl.top });
        self.trace("end");
        After::Resized
    }

    fn reset_webview(&self) {
        let cl = self.client_screen();
        let (w, h) = (cl.right - cl.left, cl.bottom - cl.top);
        unsafe {
            let _ = SetWindowPos(self.container, None, 0, 0, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
            let _ = self.controller.SetBounds(RECT { left: 0, top: 0, right: w, bottom: h });
        }
    }

    /// Tell the page where the window's client area sits in the webview (physical px), and the
    /// webview size it must see before it answers.
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
        let json = format!(
            r#"{{"atlasFrame":{{"seq":{},"live":{},"x":{},"y":{},"w":{},"h":{},"vw":{},"vh":{}}}}}"#,
            self.seq,
            live,
            frame.left,
            frame.top,
            frame.right - frame.left,
            frame.bottom - frame.top,
            vw,
            vh
        );
        let msg = HSTRING::from(json.as_str());
        if unsafe { self.webview.PostWebMessageAsJson(PCWSTR(msg.as_ptr())) }.is_ok() {
            self.waiting = Some((self.seq, Instant::now()));
        }
        self.trace(&format!("post {} live={live} frame {:?}", self.seq, rect_tuple(frame)));
    }

    fn stop_timer(&mut self) {
        if self.timer != 0 {
            unsafe {
                let _ = KillTimer(None, self.timer);
            }
            self.timer = 0;
        }
    }

    /// Cover the client area with a still picture of what is on screen now.
    fn show_overlay(&mut self, cl: RECT, shift: (i32, i32)) {
        let Some(ov) = self.overlay else { return };
        let (w, h) = (cl.right - cl.left, cl.bottom - cl.top);
        let t = Instant::now();
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
            SelectObject(mem, old);
            self.cover = read_bits(screen, bmp, w, h).map(|px| Cover { px, w, h, shift });
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(mem);
            ReleaseDC(None, screen);
            let _ = SetWindowPos(ov, Some(HWND_TOP), cl.left, cl.top, w, h, SWP_NOACTIVATE | SWP_SHOWWINDOW);
            // The cover must be on screen before the webview moves under it.
            let _ = DwmFlush();
        }
        self.overlay_up = true;
        self.trace(&format!("overlay up ({:.1} ms)", t.elapsed().as_secs_f64() * 1000.0));
    }

    fn hide_overlay(&mut self) {
        if !self.overlay_up {
            return;
        }
        if let Some(ov) = self.overlay {
            unsafe {
                // One composition with the page's new frame under the cover first.
                let _ = DwmFlush();
                let _ = ShowWindow(ov, SW_HIDE);
            }
        }
        self.overlay_up = false;
        self.cover = None;
        self.trace("overlay down");
    }
}

struct Cover {
    /// 32-bit BGRX rows, top-down.
    px: Vec<u8>,
    w: i32,
    h: i32,
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

/// The window's client area as DWM composes it (the webview's presented frame included).
unsafe fn grab_client(top: HWND, w: i32, h: i32) -> Option<Vec<u8>> {
    let screen = GetDC(None);
    let mem = CreateCompatibleDC(Some(screen));
    let bmp = CreateCompatibleBitmap(screen, w, h);
    let old = SelectObject(mem, bmp.into());
    let ok = PrintWindow(top, mem, PW_CLIENT_FULL).as_bool();
    SelectObject(mem, old);
    let px = if ok { read_bits(screen, bmp, w, h) } else { None };
    let _ = DeleteObject(bmp.into());
    let _ = DeleteDC(mem);
    ReleaseDC(None, screen);
    px
}

/// Mean absolute channel difference between `a` and `b` moved by `shift` (a[x, y] against
/// b[x - dx, y - dy]) over the overlap, sampled every 4th pixel each way.
fn mean_diff(a: &[u8], b: &[u8], w: i32, h: i32, shift: (i32, i32)) -> f64 {
    let (dx, dy) = shift;
    let (mut sum, mut n) = (0u64, 0u64);
    let mut y = dy.max(0);
    while y < h.min(h + dy) {
        let mut x = dx.max(0);
        while x < w.min(w + dx) {
            let i = ((y * w + x) * 4) as usize;
            let j = (((y - dy) * w + (x - dx)) * 4) as usize;
            for k in 0..3 {
                sum += (a[i + k] as i32 - b[j + k] as i32).unsigned_abs() as u64;
            }
            n += 3;
            x += 4;
        }
        y += 4;
    }
    if n == 0 { f64::INFINITY } else { sum as f64 / n as f64 }
}

fn offset(cl: RECT, canvas: RECT) -> RECT {
    RECT {
        left: cl.left - canvas.left,
        top: cl.top - canvas.top,
        right: cl.right - canvas.left,
        bottom: cl.bottom - canvas.top,
    }
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
    use super::mean_diff;

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
