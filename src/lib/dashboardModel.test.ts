import { describe, expect, it } from "vitest";
import { bin, lastAndPrevious, lastDays, percentChange, shortDay, sumTail, updatedText, weekdayInitial } from "./dashboardModel";
import type { TimelinePoint } from "./types";

describe("updatedText", () => {
  const t0 = Date.UTC(2026, 10, 8, 12, 0, 0);

  it("says nothing before the first answer", () => {
    expect(updatedText(null, t0)).toBeNull();
  });

  it("reads the age from milliseconds, never from seconds (the 20745 d bug)", () => {
    expect(updatedText(t0, t0)).toBe("Updated just now");
    expect(updatedText(t0 - 30_000, t0)).toBe("Updated just now");
    expect(updatedText(t0 - 3 * 60_000, t0)).toBe("Updated 3 min ago");
    expect(updatedText(t0 - 2 * 3_600_000, t0)).toMatch(/^Updated 2 h ago$/);
    expect(updatedText(t0 - 3_000, t0)).not.toMatch(/\bd ago/);
  });

  it("never goes negative when the clock steps back", () => {
    expect(updatedText(t0 + 60_000, t0)).toBe("Updated just now");
  });
});

describe("percentChange", () => {
  it("compares against the earlier period", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
  });
  it("has no answer when there is nothing to compare with", () => {
    expect(percentChange(10, 0)).toBeNull();
  });
});

describe("lastAndPrevious", () => {
  it("splits the tail and the n before it", () => {
    expect(lastAndPrevious([1, 2, 3, 4, 5, 6], 2)).toEqual({ last: [5, 6], prev: [3, 4] });
  });
  it("copes with a series shorter than two periods", () => {
    expect(lastAndPrevious([1, 2, 3], 2)).toEqual({ last: [2, 3], prev: [1] });
    expect(lastAndPrevious([], 7)).toEqual({ last: [], prev: [] });
  });
});

describe("lastDays", () => {
  it("ends today and runs oldest first, across a month boundary", () => {
    expect(lastDays("2026-11-02", 4)).toEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"]);
  });
});

describe("sumTail", () => {
  const pt = (n: number): TimelinePoint =>
    ({
      start: "2026-11-08",
      tokens: { input: n, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: n, webSearch: 0, webFetch: 0 },
      cost: { usd: null, complete: true, unpricedTokens: 0 },
      sessions: 1,
    }) as TimelinePoint;
  it("sums only the last n points", () => {
    expect(sumTail([pt(100), pt(1), pt(2)], 2)).toBe(3);
  });
});

describe("bin", () => {
  it("leaves a short series alone", () => {
    expect(bin([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });
  it("folds a long series into even groups without losing any total", () => {
    const v = Array.from({ length: 30 }, (_, i) => i + 1);
    const out = bin(v, 6);
    expect(out).toHaveLength(6);
    expect(out.reduce((a, b) => a + b, 0)).toBe(v.reduce((a, b) => a + b, 0));
  });
});

describe("day labels", () => {
  it("formats a local day for a tooltip and a column head", () => {
    expect(shortDay("2026-11-08")).toBe("Sun, Nov 8");
    expect(weekdayInitial("2026-11-08")).toBe("S");
  });
});
