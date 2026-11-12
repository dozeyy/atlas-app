import { describe, expect, it } from "vitest";
import { activeSeries, dayWithYear, LIFETIME_NOTE, lifetimeLongest, lifetimeView } from "./lifetimeModel";
import { longestStreak, streakLength } from "./chartPaths";
import type { Cost, Lifetime, Tokens } from "./types";

const tk = (total: number): Tokens => ({ input: total, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total, webSearch: 0, webFetch: 0 });
const cost = (usd: number): Cost => ({ usd, complete: true, unpricedTokens: 0 });

function life(over: Partial<Lifetime> = {}): Lifetime {
  return {
    firstDay: "2026-03-04",
    today: "2026-11-08",
    total: { tokens: tk(10_000), cost: cost(12), sessions: 7 },
    busiest: { day: "2026-05-02", tokens: tk(4_000), cost: cost(3) },
    byModel: [
      { model: "claude-sonnet-5-5", known: true, tokens: tk(3_000), cost: cost(2) },
      { model: "claude-opus-5-5", known: true, tokens: tk(7_000), cost: cost(10) },
    ],
    activeDays: ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-08", "2026-11-07", "2026-11-08"],
    ...over,
  } as Lifetime;
}

describe("activeSeries", () => {
  it("is one flag per local day, first to today", () => {
    expect(activeSeries("2026-11-01", "2026-11-05", ["2026-11-01", "2026-11-02", "2026-11-05"])).toEqual([1, 1, 0, 0, 1]);
  });
  it("ignores days outside the span", () => {
    expect(activeSeries("2026-11-03", "2026-11-04", ["2026-11-01", "2026-11-09", "2026-11-04"])).toEqual([0, 1]);
  });
});

describe("lifetimeLongest", () => {
  it("runs the Dashboard's own streak code over every day", () => {
    const l = life();
    const series = activeSeries(l.firstDay!, l.today, l.activeDays);
    expect(lifetimeLongest(l, 0)).toBe(longestStreak(series));
    expect(lifetimeLongest(l, 0)).toBe(3);
    // The current streak is the same function over the same series, so it can never read higher than the record.
    expect(streakLength(series)).toBe(2);
    expect(lifetimeLongest(l, streakLength(series))).toBeGreaterThanOrEqual(streakLength(series));
  });
  it("never reads lower than the streak shown beside it", () => {
    expect(lifetimeLongest(life({ activeDays: ["2026-03-04"] }), 12)).toBe(12);
  });
  it("is zero with no first day", () => {
    expect(lifetimeLongest(life({ firstDay: null, activeDays: [] }), 0)).toBe(0);
  });
});

describe("lifetimeView", () => {
  it("words each figure from the engine's numbers", () => {
    const v = lifetimeView(life(), 2)!;
    expect(v.since).toBe("Mar 4, 2026");
    expect(v.tokens).toBe(10_000);
    expect(v.sessions).toBe(7);
    expect(v.busiest).toMatchObject({ tokens: 4_000, day: "May 2" });
    expect(v.favorite?.label).toBe("Opus 5.5");
    expect(v.favorite?.tip).toMatch(/70% of all tokens/);
    expect(v.longest).toBe(3);
  });
  it("puts the year on a busiest day from another year", () => {
    expect(dayWithYear("2025-12-31", "2026-11-08")).toBe("Dec 31, 2025");
    expect(dayWithYear("2026-01-02", "2026-11-08")).toBe("Jan 2");
  });
  it("keeps tokens first: the hover has the exact count and an estimate, not a bill", () => {
    const v = lifetimeView(life({ total: { tokens: tk(1_234_567), cost: cost(12), sessions: 1 } }), 0)!;
    expect(v.tokensTip).toContain("1,234,567");
    expect(v.tokensTip).toMatch(/estimate/i);
    expect(v.sessionsTip).toMatch(/deletes its file/);
  });
  it("adds model ids that read the same before choosing the favorite", () => {
    const v = lifetimeView(
      life({
        byModel: [
          { model: "claude-sonnet-5-5", known: true, tokens: tk(4_000), cost: cost(1) },
          { model: "claude-sonnet-5-5-20261001", known: true, tokens: tk(4_000), cost: cost(1) },
          { model: "claude-opus-5-5", known: true, tokens: tk(5_000), cost: cost(5) },
        ],
      }),
      0,
    )!;
    expect(v.favorite?.label).toBe("Sonnet 5.5");
  });
  it("is null on an empty history, so the page shows its own empty state", () => {
    expect(lifetimeView(life({ firstDay: null, total: { tokens: tk(0), cost: cost(0), sessions: 0 }, busiest: null, byModel: [], activeDays: [] }), 0)).toBeNull();
  });
  it("leaves out a busiest day and a favorite it does not have", () => {
    const v = lifetimeView(life({ busiest: null, byModel: [] }), 0)!;
    expect(v.busiest).toBeNull();
    expect(v.favorite).toBeNull();
  });
  it("carries the note the section's tooltip shows", () => {
    expect(LIFETIME_NOTE).toBe("Counted since Atlas first read your chats.");
  });
});
