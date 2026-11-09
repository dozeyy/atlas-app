import { describe, expect, it } from "vitest";
import { dayLabel, groupByDay, projectTone, resumeCommand, shareOfMax } from "./sessionBrowse";
import type { SessionRow } from "./types";

const NOW = new Date(2026, 10, 8, 14, 30); // Sunday 8 Nov 2026

const row = (id: string, at: Date, tokens: number): SessionRow =>
  ({
    sessionId: id,
    name: id,
    projectName: "atlas",
    projectPath: "C:/code/atlas",
    startedAt: at.getTime(),
    tokens: { total: tokens },
  }) as unknown as SessionRow;

describe("day labels", () => {
  it("names today, yesterday, the weekday, then the date", () => {
    expect(dayLabel("2026-11-08", NOW)).toBe("Today");
    expect(dayLabel("2026-11-07", NOW)).toBe("Yesterday");
    expect(dayLabel("2026-11-05", NOW)).toBe("Thursday");
    expect(dayLabel("2026-11-02", NOW)).toBe("Monday");
    expect(dayLabel("2026-11-01", NOW)).toBe("Nov 1");
    expect(dayLabel("2025-12-30", NOW)).toBe("Dec 30, 2025");
  });
});

describe("grouping by day", () => {
  it("makes one group per run of a day and adds up its tokens", () => {
    const groups = groupByDay(
      [
        row("a", new Date(2026, 10, 8, 13), 100),
        row("b", new Date(2026, 10, 8, 9), 50),
        row("c", new Date(2026, 10, 7, 22), 400),
        row("d", new Date(2026, 10, 1, 8), 5),
      ],
      NOW,
    );
    expect(groups.map((g) => [g.label, g.rows.length, g.tokens])).toEqual([
      ["Today", 2, 150],
      ["Yesterday", 1, 400],
      ["Nov 1", 1, 5],
    ]);
  });

  it("is empty for no rows", () => {
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe("share of the largest", () => {
  it("scales to the max, keeps a sliver for small values and zero for none", () => {
    expect(shareOfMax(50, 100)).toBe(0.5);
    expect(shareOfMax(100, 100)).toBe(1);
    expect(shareOfMax(1, 100000)).toBe(0.04);
    expect(shareOfMax(0, 100)).toBe(0);
    expect(shareOfMax(5, 0)).toBe(0);
  });
});

describe("project colour", () => {
  it("is stable, within 1 to 4, and ignores case and a trailing slash", () => {
    const t = projectTone("C:\\Code\\Atlas");
    expect(t).toBeGreaterThanOrEqual(1);
    expect(t).toBeLessThanOrEqual(4);
    expect(projectTone("c:\\code\\atlas\\")).toBe(t);
    expect(projectTone("C:\\Code\\Atlas")).toBe(t);
  });
});

describe("resume command", () => {
  it("goes to the folder first when it is known", () => {
    expect(resumeCommand("abc-123", "C:/code/atlas")).toBe('cd "C:/code/atlas"\nclaude --resume abc-123');
  });
  it("is just the resume line without a folder", () => {
    expect(resumeCommand("abc-123", "")).toBe("claude --resume abc-123");
    expect(resumeCommand("abc-123", null)).toBe("claude --resume abc-123");
  });
  it("never lets a quote through", () => {
    expect(resumeCommand("x", 'C:/a"b')).toBe('cd "C:/ab"\nclaude --resume x');
  });
});
