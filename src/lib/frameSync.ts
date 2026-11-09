/**
 * The page's half of the Windows edge-drag sync (crates/app/src/winframe.rs).
 *
 * While an edge of the window is dragged, Rust grows the webview to a canvas that does not move
 * on screen and sends `{atlasFrame: {seq, live, x, y, w, h, vw, vh}}`: where the window's client
 * area sits in that canvas, and the webview size (all in physical px). The page lays itself out
 * inside that rect (`html.frame-live`, see index.css) and answers `frame_ack(seq)` once a frame
 * with it has been drawn; only then does the window take that size. (The answer cannot be a
 * WebMessage: wry's handler drops every non-string message and takes the handlers after it down
 * with it, and a string would hit Tauri's IPC parser.)
 */
import { invoke } from "@tauri-apps/api/core";

export type FrameMsg = { seq: number; live: boolean; x: number; y: number; w: number; h: number; vw: number; vh: number };

type WebviewHost = {
  addEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
  removeEventListener(type: "message", cb: (e: { data: unknown }) => void): void;
};

/** How the answer was reached (traced by Rust): 0 two animation frames, 1 presented, 2 gave up waiting. */
export type AckVia = 0 | 1 | 2;

const sendAck = (seq: number, via: AckVia) => void invoke("frame_ack", { seq, via }).catch(() => {});

/** Fired on the window each time a drag moves the app's rect, and when it ends. */
export const FRAME_EVENT = "atlas:frame";

/** The window's width in CSS px while an edge drag pins the layout, else null. */
export function liveFrameWidth(doc: Document = document): number | null {
  const root = doc.documentElement;
  if (!root.classList.contains("frame-live")) return null;
  const w = parseFloat(root.style.getPropertyValue("--frame-w"));
  return w > 0 ? w : null;
}

/** Frames to wait for the webview to reach the size Rust set before answering anyway. */
const MAX_WAIT_FRAMES = 30;

export function frameMessage(data: unknown): FrameMsg | null {
  if (!data || typeof data !== "object") return null;
  const m = (data as { atlasFrame?: unknown }).atlasFrame;
  if (!m || typeof m !== "object") return null;
  const f = m as Record<string, unknown>;
  const nums = ["seq", "x", "y", "w", "h", "vw", "vh"] as const;
  if (!nums.every((k) => typeof f[k] === "number" && Number.isFinite(f[k])) || typeof f.live !== "boolean") return null;
  return f as unknown as FrameMsg;
}

/** True when the webview already has the size (physical px) Rust gave it. */
export function viewportMatches(win: Pick<Window, "innerWidth" | "innerHeight" | "devicePixelRatio">, vw: number, vh: number): boolean {
  const dpr = win.devicePixelRatio || 1;
  return Math.abs(win.innerWidth * dpr - vw) <= 2 && Math.abs(win.innerHeight * dpr - vh) <= 2;
}

/** Size of the presentation marker, CSS px. */
const MARK = 6;
/** Frames to wait for a presentation report before answering anyway. */
const MAX_PRESENT_FRAMES = 12;

/**
 * A spot in the canvas outside the window's rect (so it is never on screen) for the
 * presentation marker, in CSS px, or null when the window covers the whole canvas edge-to-edge.
 */
export function hiddenSpot(m: FrameMsg, dpr: number): { left: number; top: number } | null {
  const [x, y, w, h, vw, vh] = [m.x, m.y, m.w, m.h, m.vw, m.vh].map((v) => v / dpr);
  const room = MARK + 2;
  if (x >= room) return { left: 0, top: y };
  if (y >= room) return { left: x, top: 0 };
  if (vw - (x + w) >= room) return { left: x + w + 2, top: y };
  if (vh - (y + h) >= room) return { left: x, top: y + h + 2 };
  return null;
}

const observerOf = (win: Window) => (win as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;

function presentedSupported(win: Window): boolean {
  const PO = observerOf(win);
  return !!PO && Array.isArray(PO.supportedEntryTypes) && PO.supportedEntryTypes.includes("element");
}

/**
 * Answer once the frame that carries the current layout has been presented. A tiny text marker
 * with an `elementtiming` id is painted in that same frame, outside the window's rect; the
 * browser reports its paint (Element Timing) only after the frame's presentation.
 */
function awaitPresented(win: Window, seq: number, spot: { left: number; top: number }, ack: (seq: number, via: AckVia) => void) {
  const doc = win.document;
  const id = `atlas-frame-${seq}`;
  const mark = doc.createElement("i");
  mark.setAttribute("elementtiming", id);
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = ".";
  mark.style.cssText = `position:fixed;left:${spot.left}px;top:${spot.top}px;width:${MARK}px;height:${MARK}px;font:${MARK}px/1 sans-serif;pointer-events:none;`;
  let done = false;
  const finish = (via: AckVia) => {
    if (done) return;
    done = true;
    obs.disconnect();
    mark.remove();
    ack(seq, via);
  };
  const PO = observerOf(win)!;
  const obs = new PO((list: PerformanceObserverEntryList) => {
    if (list.getEntries().some((e: PerformanceEntry) => (e as PerformanceEntry & { identifier?: string }).identifier === id)) finish(1);
  });
  obs.observe({ type: "element", buffered: false });
  doc.documentElement.appendChild(mark);
  let frames = 0;
  const guard = () => {
    if (done) return;
    if (frames++ >= MAX_PRESENT_FRAMES) return finish(2);
    win.requestAnimationFrame(guard);
  };
  win.requestAnimationFrame(guard);
}

export function installFrameSync(win: Window = window, ack: (seq: number, via: AckVia) => void = sendAck): () => void {
  const host = (win as unknown as { chrome?: { webview?: WebviewHost } }).chrome?.webview;
  if (!host) return () => {};
  const root = win.document.documentElement;

  const pin = (m: FrameMsg) => {
    const dpr = win.devicePixelRatio || 1;
    root.style.setProperty("--frame-x", `${m.x / dpr}px`);
    root.style.setProperty("--frame-y", `${m.y / dpr}px`);
    root.style.setProperty("--frame-w", `${m.w / dpr}px`);
    root.style.setProperty("--frame-h", `${m.h / dpr}px`);
    root.classList.add("frame-live");
    win.dispatchEvent(new Event(FRAME_EVENT));
  };
  const unpin = () => {
    if (!root.classList.contains("frame-live")) return;
    root.classList.remove("frame-live");
    for (const k of ["--frame-x", "--frame-y", "--frame-w", "--frame-h"]) root.style.removeProperty(k);
    win.dispatchEvent(new Event(FRAME_EVENT));
  };
  // Two animation frames: the first runs before the frame that carries the change is drawn, the
  // second only after that frame has gone out. That frame can still be on its way to the screen
  // when the machine is busy, so where it can, the page waits for the frame's presentation instead.
  const twoFrames = (seq: number) =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => ack(seq, 0)));
  const answer = (m: FrameMsg) => {
    const spot = m.live ? hiddenSpot(m, win.devicePixelRatio || 1) : null;
    if (!spot || !presentedSupported(win)) return twoFrames(m.seq);
    awaitPresented(win, m.seq, spot, ack);
  };

  const onMessage = (e: { data: unknown }) => {
    const m = frameMessage(e.data);
    if (!m) return;
    // Live: pin at once (the webview size does not change under a pinned layout). Ending: keep the
    // pin until the webview is back to the window's size, or the page would lay out at the
    // canvas size for a frame.
    if (m.live) pin(m);
    let waited = 0;
    const settle = () => {
      if (!viewportMatches(win, m.vw, m.vh) && waited++ < MAX_WAIT_FRAMES) {
        win.requestAnimationFrame(settle);
        return;
      }
      if (!m.live) unpin();
      answer(m);
    };
    settle();
  };
  host.addEventListener("message", onMessage);
  return () => {
    host.removeEventListener("message", onMessage);
    unpin();
  };
}
