import { describe, expect, it } from "vitest";
import { buildSlides, coverageLine, hourLabel, hourTotals, peakHour, MAX_CELEBRATIONS } from "./wrappedModel";
import type { WrappedData } from "./wrappedModel";
import type { ItemUse } from "./usageTypes";

const item = (id: string, kind: ItemUse["kind"], uses: number, sessions: number): ItemUse => ({ id, kind, uses, sessions, lastUsed: null });
const hours = (peak: number) => Array.from({ length: 24 }, (_, h) => (h === peak ? 900 : h === peak - 1 ? 300 : 10));

function data(over: Partial<WrappedData> = {}): WrappedData {
  return {
    from: "2026-10-09",
    to: "2026-11-08",
    spanDays: 31,
    activeDays: 22,
    tokens: 48_200_000,
    sessions: 140,
    busiest: { day: "2026-10-27", tokens: 4_100_000, sessions: 9 },
    streak: 4,
    longestStreak: 9,
    hours: hours(22),
    dayTokens: new Array(31).fill(1_000_000),
    skills: [
      item("frontend-design", "skill", 41, 18),
      item("code-review", "skill", 12, 7),
    ],
    agents: [item("reviewer", "agent", 20, 10)],
    tools: [item("Edit", "tool", 900, 100)],
    projects: [
      { label: "atlas", value: 30 },
      { label: "heavens-casino", value: 18 },
    ],
    models: [
      { label: "Opus 5.5", value: 40 },
      { label: "Sonnet 5.5", value: 8 },
    ],
    longest: null,
    keepDays: 30,
    ...over,
  };
}

describe("buildSlides", () => {
  it("tells the full story with real numbers and ends on what it covers", () => {
    const s = buildSlides(data());
    const ids = s.map((x) => x.id);
    expect(ids).toEqual(["tokens", "days", "skill", "helper", "tool", "busiest", "rhythm", "project", "models", "end"]);
    expect(s[0].figure).toBe("48M");
    expect(s.find((x) => x.id === "skill")?.figure).toBe("frontend-design");
    expect(s[s.length - 1].line).toContain("clears its logs after 30 days");
  });

  it("tells a short story when there are only a few active days", () => {
    const s = buildSlides(data({ activeDays: 3, spanDays: 3, dayTokens: [1, 2, 3] }));
    expect(s.map((x) => x.id)).toEqual(["tokens", "skill", "busiest", "end"]);
  });

  it("leaves out a slide whose numbers are missing instead of making them up", () => {
    const s = buildSlides(data({ skills: [], agents: [], tools: [], projects: [], models: [], busiest: null, hours: new Array(24).fill(0) }));
    expect(s.map((x) => x.id)).toEqual(["tokens", "days", "end"]);
  });

  it("counts tokens, never dollars", () => {
    const s = buildSlides(data());
    const models = s.find((x) => x.id === "models");
    expect(models?.figure).toBe("Opus 5.5");
    expect(models?.line).toBe("83% of your tokens.");
    expect(JSON.stringify(s)).not.toContain("$");
  });

  it("celebrates at most three moments", () => {
    const n = buildSlides(data({ longestStreak: 12 })).filter((x) => x.celebrate).length;
    expect(n).toBeLessThanOrEqual(MAX_CELEBRATIONS);
    expect(n).toBeGreaterThan(0);
  });

  it("uses the singular for one day", () => {
    const end = buildSlides(data({ spanDays: 1, activeDays: 1 })).pop();
    expect(end?.figure).toBe("1 day");
  });
});

describe("hours", () => {
  it("adds hourly points into 24 local hours", () => {
    const t = (n: number) => ({ input: 0, output: n, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: n, webSearch: 0, webFetch: 0 });
    const out = hourTotals([
      { start: "2026-11-01T09:00", tokens: t(10), cost: { usd: null, complete: true, unpricedTokens: 0 }, sessions: 1 },
      { start: "2026-11-02T09:00", tokens: t(5), cost: { usd: null, complete: true, unpricedTokens: 0 }, sessions: 1 },
      { start: "2026-11-02T23:00", tokens: t(2), cost: { usd: null, complete: true, unpricedTokens: 0 }, sessions: 1 },
    ]);
    expect(out).toHaveLength(24);
    expect(peakHour(out)).toBe(9);
    expect(out[23]).toBeGreaterThan(0);
  });

  it("names hours on a 12 hour clock", () => {
    expect(hourLabel(0)).toBe("12 AM");
    expect(hourLabel(12)).toBe("12 PM");
    expect(hourLabel(22)).toBe("10 PM");
    expect(peakHour(new Array(24).fill(0))).toBeNull();
  });

  it("says how far back the numbers go", () => {
    expect(coverageLine({ from: "2026-10-09", keepDays: 30 })).toBe("From Oct 9 to today. Claude Code clears its logs after 30 days, so anything older is not here.");
  });
});

