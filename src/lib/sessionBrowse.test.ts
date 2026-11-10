import { describe, expect, it } from "vitest";
import { clockOf, dayLabel, groupByDay, projectTone, resumeCommand, shareOfMax } from "./sessionBrowse";
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

describe("time of day", () => {
  it("is the local hour and minute, two digits each", () => {
    expect(clockOf(new Date(2026, 10, 3, 9, 5).getTime())).toBe("09:05");
    expect(clockOf(new Date(2026, 10, 3, 16, 42).getTime())).toBe("16:42");
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
  const ID = "0b1c2d3e-4f50-6789-abcd-ef0123456789";

  it("is one PowerShell line on Windows, in single quotes", () => {
    expect(resumeCommand(ID, "C:\\code\\atlas", "windows")).toBe(
      `Set-Location -LiteralPath 'C:\\code\\atlas'; claude --resume ${ID}`,
    );
  });
  it("keeps a folder on another drive as it is (Set-Location changes drive)", () => {
    expect(resumeCommand(ID, "D:\\Games\\My Project", "windows")).toBe(
      `Set-Location -LiteralPath 'D:\\Games\\My Project'; claude --resume ${ID}`,
    );
  });
  it("is one POSIX line on macOS and Linux", () => {
    const want = `cd '/Users/will/My Code' && claude --resume ${ID}`;
    expect(resumeCommand(ID, "/Users/will/My Code", "macos")).toBe(want);
    expect(resumeCommand(ID, "/Users/will/My Code", "linux")).toBe(want);
  });
  it("is just the resume line without a folder", () => {
    for (const p of [undefined, null, "", "   "]) {
      expect(resumeCommand(ID, p, "windows")).toBe(`claude --resume ${ID}`);
      expect(resumeCommand(ID, p, "macos")).toBe(`claude --resume ${ID}`);
    }
  });

  it("leaves $, backtick and % alone in single quotes", () => {
    expect(resumeCommand(ID, "C:\\a $env:X `b %PATH%", "windows")).toBe(
      `Set-Location -LiteralPath 'C:\\a $env:X \`b %PATH%'; claude --resume ${ID}`,
    );
    expect(resumeCommand(ID, "/a/$HOME/`id`", "linux")).toBe(`cd '/a/$HOME/\`id\`' && claude --resume ${ID}`);
  });
  it("doubles a single quote for PowerShell, curly ones too", () => {
    expect(resumeCommand(ID, "C:\\Will's", "windows")).toBe(`Set-Location -LiteralPath 'C:\\Will''s'; claude --resume ${ID}`);
    expect(resumeCommand(ID, "C:\\Will\u2019s", "windows")).toBe(
      `Set-Location -LiteralPath 'C:\\Will\u2019\u2019s'; claude --resume ${ID}`,
    );
  });
  it("escapes a single quote for POSIX as '\\''", () => {
    expect(resumeCommand(ID, "/home/o'neil", "linux")).toBe(`cd '/home/o'\\''neil' && claude --resume ${ID}`);
  });
  it("keeps a double quote, which is a legal mac folder name character", () => {
    expect(resumeCommand(ID, '/Users/a"b', "macos")).toBe(`cd '/Users/a"b' && claude --resume ${ID}`);
    expect(resumeCommand(ID, 'C:\\a"b', "windows")).toBe(`Set-Location -LiteralPath 'C:\\a"b'; claude --resume ${ID}`);
  });

  it("offers nothing for an id with anything but letters, digits, - and _", () => {
    for (const bad of ["", "a b", "a;b", "$(x)", "a\nb", "`id`", "a'b", "../x", "x --dangerously"]) {
      expect(resumeCommand(bad, "C:\\a", "windows")).toBeNull();
      expect(resumeCommand(bad, null, "linux")).toBeNull();
    }
  });
  it("offers nothing for a folder with a line break, or a POSIX folder that is not absolute", () => {
    expect(resumeCommand(ID, "C:\\a\nb", "windows")).toBeNull();
    expect(resumeCommand(ID, "/a\rb", "linux")).toBeNull();
    expect(resumeCommand(ID, "-rf", "linux")).toBeNull();
    expect(resumeCommand(ID, "relative/dir", "macos")).toBeNull();
  });
  it("is always a single line", () => {
    expect(resumeCommand(ID, "C:\\a b", "windows")).not.toMatch(/[\r\n]/);
  });
});
