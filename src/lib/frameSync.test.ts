import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_EVENT, frameMessage, installFrameSync, liveFrameWidth, viewportMatches } from "./frameSync";

type Listener = (e: { data: unknown }) => void;

function fakeHost() {
  let listener: Listener | null = null;
  const posted: unknown[] = [];
  return {
    posted,
    send: (data: unknown) => listener?.({ data }),
    host: {
      addEventListener: (_: "message", cb: Listener) => (listener = cb),
      removeEventListener: () => (listener = null),
    },
  };
}

describe("frameSync", () => {
  let frames: FrameRequestCallback[] = [];
  const flush = () => {
    const run = frames;
    frames = [];
    run.forEach((f) => f(0));
  };
  let host: ReturnType<typeof fakeHost>;
  let off: () => void;

  beforeEach(() => {
    frames = [];
    host = fakeHost();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    Object.assign(window, { chrome: { webview: host.host } });
    Object.defineProperty(window, "devicePixelRatio", { value: 1.5, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    off = installFrameSync(window, (seq) => host.posted.push({ atlasFrameAck: seq }));
  });
  afterEach(() => {
    off();
    vi.restoreAllMocks();
    delete (window as { chrome?: unknown }).chrome;
  });

  const msg = (seq: number, live: boolean, vw = 1200, vh = 900) => ({
    atlasFrame: { seq, live, x: 30, y: 15, w: 1200, h: 900, vw, vh },
  });

  it("parses only well-formed frame messages", () => {
    expect(frameMessage(msg(1, true))?.seq).toBe(1);
    expect(frameMessage({ atlasFrame: { seq: "1" } })).toBeNull();
    expect(frameMessage("x")).toBeNull();
    expect(frameMessage(null)).toBeNull();
  });

  it("compares the viewport in physical px", () => {
    expect(viewportMatches({ innerWidth: 800, innerHeight: 600, devicePixelRatio: 1.5 }, 1200, 900)).toBe(true);
    expect(viewportMatches({ innerWidth: 800, innerHeight: 600, devicePixelRatio: 1.5 }, 1260, 900)).toBe(false);
  });

  it("pins the layout in CSS px and answers two frames later", () => {
    const seen = vi.fn();
    window.addEventListener(FRAME_EVENT, seen);
    host.send(msg(7, true));
    const root = document.documentElement;
    expect(root.classList.contains("frame-live")).toBe(true);
    expect(root.style.getPropertyValue("--frame-x")).toBe("20px");
    expect(liveFrameWidth()).toBe(800);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(host.posted).toEqual([]);
    flush();
    expect(host.posted).toEqual([]);
    flush();
    expect(host.posted).toEqual([{ atlasFrameAck: 7 }]);
    window.removeEventListener(FRAME_EVENT, seen);
  });

  it("keeps the pin until the webview is back to the window's size, then answers", () => {
    host.send(msg(1, true));
    flush();
    flush();
    // Rust asks to end while the webview is still canvas-sized (1920x1080 physical).
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 720, configurable: true });
    host.send(msg(2, false));
    flush();
    expect(document.documentElement.classList.contains("frame-live")).toBe(true);
    expect(host.posted).toEqual([{ atlasFrameAck: 1 }]);
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 600, configurable: true });
    flush();
    expect(document.documentElement.classList.contains("frame-live")).toBe(false);
    expect(liveFrameWidth()).toBeNull();
    flush();
    flush();
    expect(host.posted).toEqual([{ atlasFrameAck: 1 }, { atlasFrameAck: 2 }]);
  });

  it("answers anyway when the webview never reaches the size", () => {
    host.send(msg(3, true, 4000, 4000));
    for (let i = 0; i < 40; i++) flush();
    expect(host.posted).toEqual([{ atlasFrameAck: 3 }]);
  });

  it("ignores everything else the webview sends", () => {
    host.send({ other: 1 });
    flush();
    flush();
    expect(host.posted).toEqual([]);
    expect(document.documentElement.classList.contains("frame-live")).toBe(false);
  });
});
