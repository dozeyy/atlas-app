import { describe, expect, it } from "vitest";
import { ARM_WEDGES, DOT_PATH, SPARK_PATH } from "./markGeometry";
import { CLAY_AT, DESIGNED_TOTAL, EASE_WIPE, T, cubicBezier, summarizeFrames } from "./timeline";
import { armIntro, installIntroReveal } from "../lib/intro";

describe("launch intro timeline", () => {
  it("fits the budget: about 2 s, never over 2.5 s", () => {
    expect(DESIGNED_TOTAL).toBeLessThanOrEqual(2500);
    expect(DESIGNED_TOTAL).toBeGreaterThanOrEqual(1800);
  });

  it("runs in the order burst, fill, spin with trails, ripple, then the app", () => {
    const lastArmEnds = Math.max(...T.burst.stagger) + T.burst.dur;
    expect(T.dot.at + T.dot.dur).toBeGreaterThanOrEqual(lastArmEnds - 50); // the dot pops last
    expect(T.fill.at).toBeGreaterThanOrEqual(lastArmEnds - 50);
    expect(T.spin.at).toBeGreaterThanOrEqual(T.fill.at + T.fill.dur - 80); // nearly solid before it spins
    expect(T.core.at).toBeGreaterThan(T.spin.at);
    expect(T.ripple.at).toBeGreaterThanOrEqual(T.core.at);
    expect(CLAY_AT).toBeGreaterThan(T.ripple.at);
  });

  it("the logo is gone into the disc before the ripple starts", () => {
    expect(T.markFade.at + T.markFade.dur).toBeLessThanOrEqual(T.ripple.at);
    expect(T.markFade.at).toBeGreaterThanOrEqual(T.core.at); // the disc is already firming up under it
    expect(T.markFade.at + T.markFade.dur).toBeGreaterThanOrEqual(T.core.at + T.core.dur - 10); // never uncovered
  });

  it("the trails can close the gaps: wide enough spread at the fastest spin", () => {
    // Fastest speed (deg per ms) at the end of the build-up, from the ease-in's end slope.
    const peak = (Math.abs(T.spin.turn1) / T.spin.dur1) * (0.47 / 0.32);
    const spread = peak * T.trail.lagMax;
    expect(spread).toBeGreaterThan(100); // five arms leave 72 degrees between them
    // and copies are close enough together to read as a smear, not as stamps
    expect(peak * (T.trail.lagMax / T.trail.count)).toBeLessThan(8);
  });

  it("the spin curves meet at the same speed (no kink)", () => {
    const inSpeed = (Math.abs(T.spin.turn1) / T.spin.dur1) * (0.47 / 0.32);
    const outSpeed = (Math.abs(T.spin.turn2) / T.spin.dur2) * (0.6 / 0.12);
    expect(Math.abs(inSpeed - outSpeed) / inSpeed).toBeLessThan(0.1);
  });

  it("has one arm wedge per stagger slot and real geometry", () => {
    expect(ARM_WEDGES).toHaveLength(T.burst.stagger.length);
    expect(SPARK_PATH.startsWith("M")).toBe(true);
    expect(DOT_PATH.startsWith("M")).toBe(true);
  });
});

describe("wipe curve", () => {
  it("is a monotonic bezier from 0 to 1", () => {
    const e = cubicBezier(...EASE_WIPE);
    expect(e(0)).toBe(0);
    expect(e(1)).toBe(1);
    let prev = 0;
    for (let i = 1; i <= 100; i++) {
      const v = e(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
  it("matches the CSS ease for a known curve", () => {
    // cubic-bezier(0.25, 0.1, 0.25, 1) ("ease") is about 0.8024 at t = 0.5
    expect(cubicBezier(0.25, 0.1, 0.25, 1)(0.5)).toBeCloseTo(0.8024, 3);
  });
  it("opens slowly and finishes fast, the ripple backwards", () => {
    const e = cubicBezier(...EASE_WIPE);
    expect(e(0.5)).toBeLessThan(0.35);
  });
});

describe("frame report", () => {
  it("finds the worst frame and counts slow ones", () => {
    const r = summarizeFrames([16.7, 16.6, 17, 22, 40, 16.7], 2100);
    expect(r.frames).toBe(6);
    expect(r.worstMs).toBe(40);
    expect(r.over20).toBe(2);
    expect(r.over33).toBe(1);
  });
  it("handles no frames", () => {
    expect(summarizeFrames([], 0).worstMs).toBe(0);
  });
});

describe("main window intro hook", () => {
  it("does nothing without an intro", () => {
    const root = document.createElement("html");
    armIntro(root);
    expect(root.dataset.intro).toBeUndefined();
  });

  it("starts pending and lands on reveal, with no fade involved", async () => {
    const root = document.createElement("html");
    window.__ATLAS_INTRO__ = true;
    armIntro(root);
    expect(root.dataset.intro).toBe("pending");
    installIntroReveal(root);
    window.__atlasIntroReveal!(false, false);
    await new Promise((r) => setTimeout(r, 100));
    expect(root.dataset.intro).toBe("play");
    window.__atlasIntroReveal!(true, false);
    await new Promise((r) => setTimeout(r, 100));
    expect(root.dataset.intro).toBeUndefined();
    delete window.__ATLAS_INTRO__;
  });
});
