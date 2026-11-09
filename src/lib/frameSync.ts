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

const sendAck = (seq: number) => void invoke("frame_ack", { seq }).catch(() => {});

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

export function installFrameSync(win: Window = window, ack: (seq: number) => void = sendAck): () => void {
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
  // second only after that frame has gone out.
  const answer = (seq: number) =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => ack(seq)));

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
      answer(m.seq);
    };
    settle();
  };
  host.addEventListener("message", onMessage);
  return () => {
    host.removeEventListener("message", onMessage);
    unpin();
  };
}
