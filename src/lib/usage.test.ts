import { describe, expect, it } from "vitest";
import {
  addDays,
  axisLabel,
  clockTime,
  dayWord,
  formatWhen,
  hourName,
  shortDate,
  uses24Hour,
  binEvenly,
  bucketTitle,
  compact,
  costView,
  exact,
  formatDuration,
  formatUsd,
  headline,
  localDay,
  effortMix,
  mergeModelRows,
  modelChoices,
  modelLabel,
  modelWithEffort,
  niceMax,
  percent,
  plural,
  rangeFor,
  tokenHint,
  topEffort,
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
    expect(percent(0.996)).toBe(">99%");
    expect(percent(1)).toBe("100%");
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
    expect(axisLabel("2026-11-08T14", "hour", "en-GB")).toBe("14:00");
    expect(axisLabel("2026-11-08T14", "hour", "en-US")).toBe("2 PM");
    expect(axisLabel("2026-11-08", "day")).toBe("Nov 8");
    expect(bucketTitle("2026-11-02", "week")).toBe("Week of Nov 2");
    expect(bucketTitle("2026-11-01", "month")).toBe("November 2026");
    expect(bucketTitle("2026-11-08T14", "hour", "en-GB")).toBe("Nov 8, 14:00 to 15:00");
    expect(bucketTitle("2026-11-08T14", "hour", "en-US")).toBe("Nov 8, 2 PM to 3 PM");
  });

  it("writes the time of day the way the computer's clock is set, 12 or 24 hour", () => {
    const morning = new Date(2026, 10, 3, 9, 5, 7).getTime();
    const afternoon = new Date(2026, 10, 3, 16, 42).getTime();
    const midnight = new Date(2026, 10, 3, 0, 8).getTime();
    expect(uses24Hour("en-US")).toBe(false);
    expect(uses24Hour("en-GB")).toBe(true);
    expect(clockTime(morning, { locale: "en-US" })).toBe("9:05 AM");
    expect(clockTime(afternoon, { locale: "en-US" })).toBe("4:42 PM");
    expect(clockTime(midnight, { locale: "en-US" })).toBe("12:08 AM");
    expect(clockTime(morning, { locale: "en-GB" })).toBe("09:05");
    expect(clockTime(afternoon, { locale: "en-GB" })).toBe("16:42");
    expect(clockTime(midnight, { locale: "en-GB" })).toBe("00:08");
    expect(clockTime(morning, { locale: "en-US", seconds: true })).toBe("9:05:07 AM");
    expect(clockTime(morning, { locale: "en-GB", seconds: true })).toBe("09:05:07");
    expect(hourName(0, "en-US")).toBe("12 AM");
    expect(hourName(12, "en-US")).toBe("12 PM");
    expect(hourName(24, "en-US")).toBe("12 AM");
    expect(hourName(22, "en-GB")).toBe("22:00");
    expect(hourName(24, "en-GB")).toBe("00:00");
  });

  it("names a day one way: Today, Yesterday, then the date (a weekday only over a day's rows)", () => {
    const now = new Date(2026, 10, 8, 14, 30).getTime(); // Sunday 8 Nov 2026
    const at = (y: number, m: number, d: number, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
    expect(dayWord(at(2026, 11, 8, 0, 1), now)).toBe("Today");
    expect(dayWord(at(2026, 11, 7, 23, 59), now)).toBe("Yesterday");
    expect(dayWord(at(2026, 11, 5), now)).toBe("Nov 5");
    expect(dayWord(at(2026, 11, 5), now, true)).toBe("Thursday");
    expect(dayWord(at(2026, 11, 1), now, true)).toBe("Nov 1");
    expect(dayWord(at(2025, 12, 30), now, true)).toBe("Dec 30, 2025");
    expect(shortDate(at(2026, 11, 3), now)).toBe("Nov 3");
    expect(shortDate(at(2025, 11, 3), now)).toBe("Nov 3, 2025");
    expect(formatWhen(at(2026, 11, 8, 16, 42), now, "en-US")).toBe("Today, 4:42 PM");
    expect(formatWhen(at(2026, 11, 7, 23, 27), now, "en-GB")).toBe("Yesterday, 23:27");
    expect(formatWhen(at(2026, 11, 3, 9, 5), now, "en-US")).toBe("Nov 3, 9:05 AM");
  });
});

describe("models", () => {
  it("makes ids readable and leaves strangers alone", () => {
    expect(modelLabel("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(modelLabel("claude-opus-5")).toBe("Opus 5");
    expect(modelLabel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(modelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("some-other-model")).toBe("some-other-model");
  });

  it("names every family with its full version, even one it has never seen", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-opus-5-5-20261101")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelLabel("claude-mythos-5-2")).toBe("Mythos 5.2");
    expect(modelLabel("claude-nova-9-1")).toBe("Nova 9.1");
    expect(modelLabel("claude-opus-4-1-20250805")).toBe("Opus 4.1");
    expect(modelLabel("<synthetic>")).toBe("<synthetic>");
    expect(modelLabel("claude-opus-5-5[1m]")).toBe("Opus 5.5");
    expect(modelLabel("claude-sonnet-4-5-20250929[1m]")).toBe("Sonnet 4.5");
    expect(modelLabel("[1m]")).toBe("[1m]");
    expect(modelLabel("claude-opus")).toBe("claude-opus");
  });

  // These were the Wrapped story's own rule (storyModelName); every page has it now, same results.
  it("names the model inside a provider's id, so a raw id is never the name", () => {
    expect(modelLabel("us.anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("Sonnet 4.5");
    expect(modelLabel("anthropic.claude-opus-4-20250514-v1:0")).toBe("Opus 4");
    expect(modelLabel("claude-sonnet-4-5@20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe("Sonnet 3.5");
    expect(modelLabel("eu.anthropic.claude-haiku-4-5-20251001-v1:0")).toBe("Haiku 4.5");
    expect(modelLabel("us.anthropic.claude-opus-5-5-v1:0[1m]")).toBe("Opus 5.5");
    expect(modelLabel("vendor/claude-opus-5-5")).toBe("Opus 5.5");
  });

  it("leaves an id with no model in it alone", () => {
    expect(modelLabel("some-vendor/unknown-model-2026")).toBe("some-vendor/unknown-model-2026");
    expect(modelLabel("anthropic.claude-v2")).toBe("anthropic.claude-v2");
    expect(modelLabel("")).toBe("");
  });
});

describe("one row per model name", () => {
  const tok = (n: number): Tokens => ({ input: n, output: n, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: n * 10, total: n * 2, webSearch: 0, webFetch: 0 });

  it("lists a name once, with every id that reads as it", () => {
    expect(modelChoices(["claude-sonnet-4-5", "claude-opus-5-5", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929[1m]", "claude-opus-5-5"])).toEqual([
      { label: "Sonnet 4.5", models: ["claude-sonnet-4-5", "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929[1m]"] },
      { label: "Opus 5.5", models: ["claude-opus-5-5"] },
    ]);
    expect(modelChoices([])).toEqual([]);
  });

  it("adds rows with the same name together and leaves the rest alone", () => {
    const rows = mergeModelRows([
      { model: "claude-sonnet-4-5", tokens: tok(100), cost: { usd: 1, complete: true, unpricedTokens: 0 }, known: true, efforts: [{ effort: "high", replies: 2 }] },
      { model: "claude-opus-5-5", tokens: tok(7), cost: { usd: 3, complete: true, unpricedTokens: 0 }, known: true },
      { model: "claude-sonnet-4-5-20250929", tokens: tok(50), cost: { usd: 0.5, complete: true, unpricedTokens: 0 }, known: true, efforts: [{ effort: "low", replies: 5 }, { effort: "high", replies: 1 }] },
    ]);
    expect(rows.map((r) => r.label)).toEqual(["Sonnet 4.5", "Opus 5.5"]);
    expect(rows[0].models).toEqual(["claude-sonnet-4-5", "claude-sonnet-4-5-20250929"]);
    expect(rows[0].tokens).toEqual(tok(150));
    expect(rows[0].cost).toEqual({ usd: 1.5, complete: true, unpricedTokens: 0 });
    expect(rows[0].efforts).toEqual([{ effort: "low", replies: 5 }, { effort: "high", replies: 3 }]);
    expect(rows[1].tokens).toEqual(tok(7));
    expect(rows[1].efforts).toEqual([]);
  });

  it("a merged row is priced only when every part of it was, and never invents a cost", () => {
    const [half] = mergeModelRows([
      { model: "claude-nova-9-1", tokens: tok(10), cost: { usd: 2, complete: true, unpricedTokens: 0 }, known: true },
      { model: "vendor/claude-nova-9-1", tokens: tok(4), cost: { usd: null, complete: false, unpricedTokens: 8 }, known: false },
    ]);
    expect(half.known).toBe(false);
    expect(half.cost).toEqual({ usd: 2, complete: false, unpricedTokens: 8 });
    const [none] = mergeModelRows([
      { model: "claude-nova-9-1", tokens: tok(1), cost: { usd: null, complete: false, unpricedTokens: 2 } },
      { model: "vendor/claude-nova-9-1", tokens: tok(1), cost: { usd: null, complete: false, unpricedTokens: 2 } },
    ]);
    expect(none.cost.usd).toBeNull();
    expect(none.known).toBe(false);
  });
});

describe("effort", () => {
  const mix = (...v: [string, number][]) => v.map(([effort, replies]) => ({ effort, replies }));

  it("takes the most used effort and never guesses one", () => {
    expect(topEffort(mix(["high", 9], ["low", 1]))).toBe("high");
    expect(topEffort([])).toBeNull();
    expect(topEffort(undefined)).toBeNull();
  });

  it("says the mix as shares of the replies that recorded one", () => {
    expect(effortMix(mix(["high", 3]))).toBe("high");
    expect(effortMix(mix(["high", 93], ["medium", 7]))).toBe("high 93%, medium 7%");
    expect(effortMix(mix(["high", 999], ["low", 1]))).toBe("high >99%, low <1%");
    expect(effortMix([])).toBe("");
    expect(effortMix(null)).toBe("");
  });

  it("puts the effort after the full model name, or leaves it off", () => {
    expect(modelWithEffort("claude-opus-5-5", "high")).toBe("Opus 5.5 · high");
    expect(modelWithEffort("claude-opus-5-5", null)).toBe("Opus 5.5");
    expect(modelWithEffort("claude-fable-5-2", undefined)).toBe("Fable 5.2");
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
