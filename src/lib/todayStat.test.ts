import { describe, expect, it } from "vitest";
import { hourKey, last24Hours, last24Keys, sparkShape, statRange, todayTotal } from "./todayStat";
import type { TimelinePoint } from "./types";

const pt = (start: string, tokens: number): TimelinePoint =>
  ({
    start,
    tokens: { input: tokens, output: 0, cacheRead: 999, cacheWrite5m: 0, cacheWrite1h: 0 },
    cost: {},
    sessions: 1,
  }) as unknown as TimelinePoint;

const NOW = new Date(2026, 10, 8, 14, 30); // 8 Nov 2026, 14:30 local

describe("hour keys", () => {
  it("matches the engine's local hour bucket", () => {
    expect(hourKey(NOW)).toBe("2026-11-08T14");
    expect(hourKey(new Date(2026, 0, 2, 3))).toBe("2026-01-02T03");
  });

  it("lists 24 hours ending now, oldest first", () => {
    const keys = last24Keys(NOW);
    expect(keys).toHaveLength(24);
    expect(keys[23]).toBe("2026-11-08T14");
    expect(keys[0]).toBe("2026-11-07T15");
  });
});

describe("hour keys at midnight and across clock changes", () => {
  const labelOrder = (k: string) => {
    const [d, h] = k.split("T");
    const [y, m, dd] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, dd) / 3_600_000 + Number(h); // a label's place on the 24-per-day grid
  };

  it("steps back over midnight", () => {
    const keys = last24Keys(new Date(2026, 10, 9, 0, 20));
    expect(keys[23]).toBe("2026-11-09T00");
    expect(keys[22]).toBe("2026-11-08T23");
    expect(keys[0]).toBe("2026-11-08T01");
  });

  it("has 24 distinct, consecutive labels on the day the clocks go back (US, 1 Nov 2026)", () => {
    const keys = last24Keys(new Date(2026, 10, 1, 2, 30));
    expect(new Set(keys).size).toBe(24);
    expect(keys[0]).toBe("2026-10-31T03");
    expect(keys[23]).toBe("2026-11-01T02");
  });

  it("has 24 distinct, consecutive labels on the day the clocks go forward (US, 8 Mar 2026), the skipped hour as a zero slot", () => {
    const keys = last24Keys(new Date(2026, 2, 8, 4, 10));
    expect(new Set(keys).size).toBe(24);
    expect(keys[0]).toBe("2026-03-07T05");
    expect(keys).toContain("2026-03-08T02");
    expect(last24Hours([pt("2026-03-08T01", 5), pt("2026-03-08T03", 7)], new Date(2026, 2, 8, 4, 10)).slice(-4)).toEqual([5, 0, 7, 0]);
  });

  it("depends only on the wall-clock hour, so a half-hour offset or minutes change nothing", () => {
    expect(last24Keys(new Date(2026, 10, 8, 14, 0))).toEqual(last24Keys(new Date(2026, 10, 8, 14, 59, 59)));
  });

  it("is 24 consecutive labels ending at the current hour for every hour of 2026", () => {
    for (let day = 0; day < 365; day++) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(2026, 0, 1 + day, h, 15);
        if (now.getHours() !== h) continue; // an hour the local zone skips
        const keys = last24Keys(now);
        expect(keys[23]).toBe(hourKey(now));
        for (let i = 1; i < 24; i++) {
          if (labelOrder(keys[i]) - labelOrder(keys[i - 1]) !== 1) throw new Error(`gap in ${keys.join(" ")}`);
        }
      }
    }
  });
});

describe("today's total", () => {
  it("adds only today's hours and ignores cache reads", () => {
    const pts = [pt("2026-11-07T23", 500), pt("2026-11-08T00", 100), pt("2026-11-08T13", 250)];
    expect(todayTotal(pts, NOW)).toBe(350);
  });

  it("is zero with nothing today", () => {
    expect(todayTotal([], NOW)).toBe(0);
    expect(todayTotal([pt("2026-11-07T10", 9)], NOW)).toBe(0);
  });

  it("asks for yesterday through today", () => {
    expect(statRange(NOW)).toEqual({ from: "2026-11-07", to: "2026-11-08" });
  });
});

describe("last 24 hours", () => {
  it("fills gaps with zero and keeps order", () => {
    const hours = last24Hours([pt("2026-11-07T15", 7), pt("2026-11-08T14", 9)], NOW);
    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe(7);
    expect(hours[23]).toBe(9);
    expect(hours.slice(1, 23).every((v) => v === 0)).toBe(true);
  });
});

describe("sparkline baseline", () => {
  const ys = (d: string) => [...d.matchAll(/(-?\d+(?:\.\d+)?)[ ,]+(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[2]));

  it("never goes below the floor, even where usage falls to zero", () => {
    const values = [0, 0, 40, 900, 0, 0, 5, 0, 1200, 0, 0, 0, 3, 0, 0, 0, 0, 800, 0, 0, 0, 0, 0, 20];
    const s = sparkShape(values, 44, 22);
    expect(s.empty).toBe(false);
    for (const y of ys(s.line)) expect(y).toBeLessThanOrEqual(s.baseline + 0.001);
    expect(s.last).not.toBeNull();
    expect(s.last![1]).toBeLessThanOrEqual(s.baseline + 0.001);
  });

  it("is flat and marked empty with no usage", () => {
    const s = sparkShape(new Array(24).fill(0), 44, 22);
    expect(s.empty).toBe(true);
    for (const y of ys(s.line)) expect(y).toBeCloseTo(s.baseline, 3);
  });
});
