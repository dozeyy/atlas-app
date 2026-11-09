import { describe, expect, it } from "vitest";
import {
  addDays,
  axisLabel,
  binEvenly,
  bucketTitle,
  compact,
  costView,
  exact,
  formatDuration,
  formatUsd,
  headline,
  localDay,
  modelLabel,
  niceMax,
  percent,
  plural,
  rangeFor,
  tokenHint,
} from "./usage";
import type { Tokens } from "./types";

describe("numbers", () => {
  it("compacts token counts the way people say them", () => {
    expect(compact(0)).toBe("0");
    expect(compact(-5)).toBe("0");
    expect(compact(999)).toBe("999");
    expect(compact(1000)).toBe("1k");
    expect(compact(1234)).toBe("1.2k");
    expect(compact(12_345)).toBe("12k");
    expect(compact(999_999)).toBe("1M"); // never "1000k"
    expect(compact(9_960)).toBe("10k");
    expect(compact(3_400_000)).toBe("3.4M");
    expect(compact(2_100_000_000)).toBe("2.1B");
  });

  it("never shows more than three digits before the unit", () => {
    expect(compact(999.6)).toBe("1k"); // not "1000"
    expect(compact(7300)).toBe("7.3k");
    expect(compact(27_000_000)).toBe("27M");
    expect(compact(289_400_000)).toBe("289M");
    expect(compact(999_600)).toBe("1M");
    expect(compact(999_600_000_000_000)).toBe("1P");
    for (const n of [1, 12, 999, 1_000, 9_999, 99_999, 123_456, 999_499, 5_550_000, 98_765_432_100, 7.3e14]) {
      expect(compact(n), String(n)).toMatch(/^\d{1,3}(\.\d)?[kMBTP]?$/);
    }
  });

  it("puts the estimate in the hover, labelled as one", () => {
    const cost = (usd: number | null, complete = true) => ({ usd, complete, unpricedTokens: 0 });
    expect(tokenHint(1_234_567, cost(14.783))).toBe("1,234,567 tokens\nAbout $14.78 at API prices. An estimate, not a bill.");
    expect(tokenHint(900, cost(12.4, false))).toContain("$12.40+");
    expect(tokenHint(900, cost(null))).toContain("no estimate");
    expect(tokenHint(0, cost(null))).toBe("0 tokens");
  });

  it("keeps exact figures for tooltips", () => {
    expect(exact(1234567)).toBe("1,234,567");
  });

  it("pluralises", () => {
    expect(plural(1, "session")).toBe("1 session");
    expect(plural(2, "session")).toBe("2 sessions");
    expect(plural(1200, "line")).toBe("1,200 lines");
  });

  it("formats percentages without lying about tiny shares", () => {
    expect(percent(0)).toBe("0%");
    expect(percent(0.004)).toBe("<1%");
    expect(percent(0.456)).toBe("46%");
  });

  it("counts the headline as input, output and cache writes, never cache reads", () => {
    const t: Tokens = { input: 697, output: 538, cacheWrite5m: 2000, cacheWrite1h: 0, cacheRead: 6000, total: 3235, webSearch: 0, webFetch: 0 };
    expect(headline(t)).toBe(3235);
  });
});

describe("money", () => {
  it("shows cents under $100 and whole dollars above", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.001)).toBe("<$0.01");
    expect(formatUsd(0.0166325)).toBe("$0.02");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(1234.4)).toBe("$1,234");
  });

  it("marks incomplete and unpriced costs", () => {
    expect(costView({ usd: 1.2, complete: true, unpricedTokens: 0 })).toEqual({ text: "$1.20", partial: false, none: false });
    expect(costView({ usd: 1.2, complete: false, unpricedTokens: 50 })).toEqual({ text: "$1.20+", partial: true, none: false });
    expect(costView({ usd: null, complete: false, unpricedTokens: 50 })).toEqual({ text: "No price", partial: false, none: true });
  });
});

describe("time", () => {
  it("formats durations at human scale", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(5 * 60_000)).toBe("5 min");
    expect(formatDuration(72 * 60_000)).toBe("1 h 12 min");
    expect(formatDuration(3 * 3_600_000)).toBe("3 h");
    expect(formatDuration(51 * 3_600_000)).toBe("2 d 3 h");
  });

  it("does days across month ends and daylight-saving changes", () => {
    expect(addDays("2026-11-08", -29)).toBe("2026-10-10");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });

  it("builds the three dashboard ranges", () => {
    expect(rangeFor("today", "2026-11-08")).toEqual({ from: "2026-11-08", to: "2026-11-08", bucket: "hour" });
    expect(rangeFor("30d", "2026-11-08")).toEqual({ from: "2026-10-10", to: "2026-11-08", bucket: "day" });
    expect(rangeFor("12w", "2026-11-08")).toEqual({ from: "2026-08-17", to: "2026-11-08", bucket: "week" });
  });

  it("labels buckets", () => {
    expect(axisLabel("2026-11-08T14", "hour")).toBe("14:00");
    expect(axisLabel("2026-11-08", "day")).toBe("Nov 8");
    expect(bucketTitle("2026-11-02", "week")).toBe("Week of Nov 2");
    expect(bucketTitle("2026-11-01", "month")).toBe("November 2026");
    expect(bucketTitle("2026-11-08T14", "hour")).toBe("Nov 8, 14:00-15:00");
  });
});

describe("models", () => {
  it("makes ids readable and leaves strangers alone", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("some-other-model")).toBe("some-other-model");
  });
});

describe("chart helpers", () => {
  it("picks a round axis maximum at or above the data", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(0.7)).toBe(1);
    expect(niceMax(1)).toBe(1);
    expect(niceMax(1.1)).toBe(2);
    expect(niceMax(2.3)).toBe(2.5);
    expect(niceMax(3)).toBe(5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(1234)).toBe(2000);
    expect(niceMax(8_000_000)).toBe(10_000_000);
    for (const v of [0.3, 1, 2.4, 49, 51, 999, 123456]) expect(niceMax(v)).toBeGreaterThanOrEqual(v);
  });

  it("bins a long list evenly and never drops an item", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const bins = binEvenly(items, 48);
    expect(bins.length).toBeLessThanOrEqual(48);
    expect(bins.flat()).toEqual(items);
    const sizes = bins.map((b) => b.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    expect(binEvenly([1, 2, 3], 48)).toEqual([[1], [2], [3]]);
    expect(binEvenly([], 48)).toEqual([]);
  });
});
