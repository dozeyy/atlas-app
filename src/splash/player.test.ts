// The frame player must land on the same values the Web Animations API would, and must never
// let a stalled frame skip the intro ahead (the macOS bug: the timeline jumped to the end).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplashPlayer, parseEasing, sample, toStops } from "./player";
import { EASE_BURST, EASE_SETTLE } from "./timeline";

let frames: FrameRequestCallback[] = [];
let clock = 0;
const step = (ms: number) => {
  clock += ms;
  const due = frames;
  frames = [];
  for (const f of due) f(clock);
};

beforeEach(() => {
  frames = [];
  clock = 1000;
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
    frames.push(f);
    return frames.length;
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("splash frame player", () => {
  it("evaluates keyframes like the Web Animations API (offsets, per-keyframe easing, fill both)", () => {
    const keys: Keyframe[] = [
      { transform: "scale(0)", easing: EASE_BURST },
      { transform: "scale(1.06)", offset: 0.6, easing: EASE_SETTLE },
      { transform: "scale(1)" },
    ];
    const stops = toStops(keys, "transform");
    const lin = parseEasing("linear");
    expect(sample(stops, lin, 100, 340, 0)).toBe(0); // before the delay: first keyframe
    expect(sample(stops, lin, 100, 340, 100 + 340 * 0.6)).toBeCloseTo(1.06, 5);
    expect(sample(stops, lin, 100, 340, 5000)).toBe(1); // after: last keyframe
    const mid = sample(stops, lin, 0, 340, 340 * 0.3);
    expect(mid).toBeGreaterThan(0.53); // burst easing front-loads the growth
    expect(mid).toBeLessThan(1.06);
  });

  it("writes styles each frame and resolves finished at the end", async () => {
    const el = document.createElement("div");
    const p = new SplashPlayer();
    const a = p.run(el, [{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: "linear" });
    expect(el.style.opacity).toBe("0");
    p.start();
    step(16); // first frame: the clock starts here
    for (let i = 0; i < 4; i++) step(16);
    expect(Number(el.style.opacity)).toBeCloseTo(0.64, 2);
    let done = false;
    void a.finished.then(() => (done = true));
    for (let i = 0; i < 3; i++) step(16);
    await Promise.resolve();
    expect(el.style.opacity).toBe("1");
    expect(done).toBe(true);
    expect(frames.length).toBe(0); // the loop stops when everything is done
  });

  it("holds the timeline back on a stalled frame instead of jumping ahead", () => {
    const el = document.createElement("div");
    const p = new SplashPlayer();
    p.run(el, [{ transform: "rotate(0deg)" }, { transform: "rotate(-1000deg)" }], { duration: 1000, easing: "linear" });
    p.start();
    step(16);
    step(2000); // a two-second hitch
    expect(el.style.transform).toBe("rotate(-34deg)");
  });

  it("starts a track added after the run from that moment (the reduced-motion fade)", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const p = new SplashPlayer();
    p.run(a, [{ opacity: 0 }, { opacity: 1 }], { duration: 32, easing: "linear" });
    p.start();
    for (let i = 0; i < 4; i++) step(16);
    expect(frames.length).toBe(0);
    p.run(b, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: "linear" });
    expect(b.style.opacity).toBe("1");
    step(16); // restart frame
    step(16);
    expect(Number(b.style.opacity)).toBeCloseTo(0.9, 2);
  });
});
