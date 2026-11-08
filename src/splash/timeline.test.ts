import { describe, expect, it } from "vitest";
import { ARM_WEDGES, DOT_PATH, SPARK_PATH } from "./markGeometry";
import { CLAY_AT, DESIGNED_TOTAL, T, summarizeFrames } from "./timeline";
import { armIntro, installIntroReveal } from "../lib/intro";

describe("launch intro timeline", () => {
  it("fits Will's budget: about 2 s, never over 2.5 s", () => {
    expect(DESIGNED_TOTAL).toBeLessThanOrEqual(2500);
    expect(DESIGNED_TOTAL).toBeGreaterThanOrEqual(1800);
  });

  it("runs in the order burst, fill, swirl, boom + clay, then the app", () => {
    const lastArmEnds = Math.max(...T.burst.stagger) + T.burst.dur;
    expect(T.dot.at + T.dot.dur).toBeGreaterThanOrEqual(lastArmEnds - 50); // the dot pops last
    expect(T.fill.at).toBeGreaterThanOrEqual(lastArmEnds - 50);
    expect(T.swirl.at).toBeGreaterThanOrEqual(T.fill.at + T.fill.dur); // solid before it swirls
    expect(T.boom.at).toBeGreaterThanOrEqual(T.swirl.at + T.swirl.dur);
    expect(CLAY_AT).toBeGreaterThan(T.boom.at);
  });

  it("has one arm wedge per stagger slot and real geometry", () => {
    expect(ARM_WEDGES).toHaveLength(T.burst.stagger.length);
    expect(SPARK_PATH.startsWith("M")).toBe(true);
    expect(DOT_PATH.startsWith("M")).toBe(true);
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
