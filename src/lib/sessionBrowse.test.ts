import { describe, expect, it } from "vitest";
import { NO_FOLDER, dayLabel, groupByDay, groupByFolder, projectTone, resumeCommand, shareOfMax } from "./sessionBrowse";
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

describe("grouping by folder", () => {
  const inFolder = (id: string, at: Date, tokens: number, name: string, path: string): SessionRow => ({ ...row(id, at, tokens), projectName: name, projectPath: path });

  it("puts the folder with the newest chat first, keeps each folder's rows in list order, and the chats with no folder last", () => {
    const groups = groupByFolder([
      inFolder("a", new Date(2026, 10, 8, 13), 100, "site", "C:/code/site"),
      inFolder("x", new Date(2026, 10, 8, 12), 7, "", ""),
      inFolder("b", new Date(2026, 10, 8, 9), 50, "atlas", "C:/code/atlas/"),
      inFolder("c", new Date(2026, 10, 7, 22), 400, "site", "C:/code/site"),
      inFolder("d", new Date(2026, 10, 1, 8), 5, "atlas", "C:/code/atlas"),
    ]);
    expect(groups.map((g) => [g.name, g.rows.map((r) => r.sessionId), g.tokens])).toEqual([
      ["site", ["a", "c"], 500],
      ["atlas", ["b", "d"], 55],
      [NO_FOLDER, ["x"], 7],
    ]);
    // A trailing slash is the same folder; the first row's path is the one shown on hover.
    expect(groups[1].path).toBe("C:/code/atlas/");
    expect(groups[0].latest).toBe(new Date(2026, 10, 8, 13).getTime());
  });

  it("names a folder that has a path but no name after the path's last segment, never No folder", () => {
    const groups = groupByFolder([
      inFolder("a", new Date(2026, 10, 8), 1, "", "C:\\work\\Desktop Apps\\atlas\\"),
      inFolder("b", new Date(2026, 10, 7), 1, "", "/home/dad/code/site"),
      inFolder("c", new Date(2026, 10, 6), 1, "", ""),
    ]);
    expect(groups.map((g) => g.name)).toEqual(["atlas", "site", NO_FOLDER]);
  });

  it("adds a page of older rows to the groups that exist and never moves one", () => {
    const first = [inFolder("a", new Date(2026, 10, 8), 1, "site", "C:/s"), inFolder("b", new Date(2026, 10, 7), 1, "atlas", "C:/a")];
    const more = [inFolder("c", new Date(2026, 10, 6), 1, "atlas", "C:/a"), inFolder("d", new Date(2026, 10, 5), 1, "notes", "C:/n")];
    const before = groupByFolder(first).map((g) => g.name);
    const after = groupByFolder([...first, ...more]);
    expect(after.map((g) => g.name)).toEqual([...before, "notes"]);
    expect(after[1].rows.map((r) => r.sessionId)).toEqual(["b", "c"]);
  });

  it("keeps the latest chat's time even when the list is not in time order", () => {
    const groups = groupByFolder([inFolder("small", new Date(2026, 10, 1), 1, "a", "C:/a"), inFolder("big", new Date(2026, 10, 8), 9, "a", "C:/a")]);
    expect(groups[0].latest).toBe(new Date(2026, 10, 8).getTime());
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
    const want = `cd '/Users/you/My Code' && claude --resume ${ID}`;
    expect(resumeCommand(ID, "/Users/you/My Code", "macos")).toBe(want);
    expect(resumeCommand(ID, "/Users/you/My Code", "linux")).toBe(want);
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
    expect(resumeCommand(ID, "C:\\Sam's", "windows")).toBe(`Set-Location -LiteralPath 'C:\\Sam''s'; claude --resume ${ID}`);
    expect(resumeCommand(ID, "C:\\Sam\u2019s", "windows")).toBe(
      `Set-Location -LiteralPath 'C:\\Sam\u2019\u2019s'; claude --resume ${ID}`,
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
