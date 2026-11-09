import { describe, expect, it } from "vitest";
import { clampIndex, defaultList, matchRanges, pageItems, projectItem, rankItems, scoreItem, sessionItem, stepIndex, toolkitItems } from "./palette";
import type { PaletteItem } from "./palette";
import type { SetupItem } from "./setup-types";
import type { SessionRow, View } from "./types";

const NAV: { view: View; label: string }[] = [
  { view: "dashboard", label: "Dashboard" },
  { view: "now", label: "Now" },
  { view: "sessions", label: "Sessions" },
  { view: "setup", label: "Toolkit" },
  { view: "history", label: "History" },
  { view: "settings", label: "Settings" },
  { view: "wrapped", label: "Wrapped" },
];

const NOW = new Date(2026, 10, 8, 14, 30);

const row = (id: string, name: string | null, project: string, at: number): SessionRow =>
  ({ sessionId: id, name, projectName: project, projectPath: `C:/code/${project}`, startedAt: at }) as unknown as SessionRow;

const item = (kind: string, name: string, extra: Partial<SetupItem> = {}): SetupItem =>
  ({ id: `${kind}-${name}`, kind, name, scopeLabel: "User", description: "", backup: false, worktree: false, modifiedMs: 5, ...extra }) as unknown as SetupItem;

const titles = (xs: PaletteItem[]) => xs.map((x) => x.title);

describe("the items", () => {
  it("numbers the pages like the shortcuts", () => {
    const pages = pageItems(NAV, "Ctrl");
    expect(pages.map((p) => p.meta)).toEqual(["Ctrl+1", "Ctrl+2", "Ctrl+3", "Ctrl+4", "Ctrl+5", "Ctrl+6", "Ctrl+7"]);
    expect(pages[3]!.target).toEqual({ view: "setup" });
  });

  it("names a chat by its title, else by its project, and says the day", () => {
    const a = sessionItem(row("a", "Fix the retry loop", "atlas", new Date(2026, 10, 8, 9).getTime()), NOW);
    expect([a.title, a.sub, a.meta]).toEqual(["Fix the retry loop", "atlas", "Today"]);
    expect(a.target).toEqual({ view: "sessions", session: "a" });
    expect(sessionItem(row("b", null, "atlas", new Date(2026, 10, 7, 9).getTime()), NOW)).toMatchObject({ title: "Session in atlas", meta: "Yesterday" });
  });

  it("takes projects as they are, and only skills, agents and commands from the Toolkit", () => {
    expect(projectItem({ projectKey: "k", name: "atlas", path: "C:/code/atlas" }).target).toEqual({ view: "sessions", project: "k" });
    const got = toolkitItems([
      item("skill", "deep-research"),
      item("hook", "format"),
      item("agent", "reviewer"),
      item("command", "ship", { backup: true }),
      item("command", "plan", { worktree: true }),
      item("command", "check"),
    ]);
    expect(titles(got)).toEqual(["deep-research", "reviewer", "check"]);
    expect(got[0]!.target).toEqual({ view: "setup", toolkitItem: "skill-deep-research" });
    expect(got.map((g) => g.kind)).toEqual(["skill", "agent", "command"]);
  });
});

describe("ranking", () => {
  const pages = pageItems(NAV, "Ctrl");
  const chats = [
    sessionItem(row("1", "Settings page polish", "atlas", 100), NOW),
    sessionItem(row("2", "Fix the retry loop", "atlas", 300), NOW),
    sessionItem(row("3", "Review the retry policy", "billing", 200), NOW),
  ];
  const all = [...pages, ...chats, projectItem({ projectKey: "p1", name: "atlas", path: "C:/code/atlas" }), ...toolkitItems([item("skill", "code-review", { description: "Review a diff for bugs" })])];

  it("puts a page before a chat that starts the same way", () => {
    expect(titles(rankItems(all, "set")).slice(0, 2)).toEqual(["Settings", "Settings page polish"]);
  });

  it("needs every typed word to match, in any order", () => {
    expect(titles(rankItems(all, "retry loop"))).toEqual(["Fix the retry loop"]);
    expect(titles(rankItems(all, "loop retry"))).toEqual(["Fix the retry loop"]);
    expect(rankItems(all, "retry zzzz")).toEqual([]);
  });

  it("likes a word start over the middle of a word, and the middle over the description", () => {
    const list = rankItems(all, "review");
    expect(list[0]!.title).toBe("Review the retry policy");
    expect(titles(list)).toContain("code-review");
    // The skill matches "review" in its name and in its description; the chat starts with it.
    expect(scoreItem("review", all.find((i) => i.title === "Review the retry policy")!)).toBeGreaterThan(scoreItem("review", all.find((i) => i.title === "code-review")!));
  });

  it("finds a thing by what it is also called", () => {
    expect(titles(rankItems(all, "recap"))).toEqual(["Wrapped"]);
    expect(titles(rankItems(all, "skills"))[0]).toBe("Toolkit");
  });

  it("matches a skipped-letter word as a last resort, below every real match", () => {
    const list = rankItems(all, "rvw");
    expect(titles(list)).toContain("code-review");
    expect(scoreItem("rvw", list[0]!)).toBeLessThan(scoreItem("review", all.find((i) => i.title === "code-review")!));
  });

  it("shows a chat found only by its message when it is marked so, under the title matches", () => {
    const hit: PaletteItem = { ...sessionItem(row("9", "Untitled", "atlas", 50), NOW), forced: 9 };
    const list = rankItems([...all, hit], "backoff");
    expect(titles(list)).toEqual(["Untitled"]);
    const mixed = rankItems([...all, hit], "retry");
    // It is listed for every word, but always after the chats whose title matches.
    expect(mixed[mixed.length - 1]).toBe(hit);
    expect(mixed.length).toBeGreaterThan(1);
  });

  it("breaks a tie with the newer chat first, and stops at the limit", () => {
    const tie = [sessionItem(row("a", "retry old", "x", 1), NOW), sessionItem(row("b", "retry new", "x", 2), NOW)];
    expect(titles(rankItems(tie, "retry"))).toEqual(["retry new", "retry old"]);
    expect(rankItems(all, "e", 3)).toHaveLength(3);
  });

  it("is not thrown by capitals, extra spaces or regex characters", () => {
    expect(titles(rankItems(all, "  SETTINGS  "))[0]).toBe("Settings");
    expect(() => rankItems(all, "(.*[")).not.toThrow();
    expect(rankItems(all, "(.*[")).toEqual([]);
  });
});

describe("nothing typed", () => {
  it("lists every page, then the newest chats only", () => {
    const pages = pageItems(NAV, "Ctrl");
    const chats = Array.from({ length: 10 }, (_, i) => sessionItem(row(`s${i}`, `chat ${i}`, "x", i * 10), NOW));
    const list = defaultList([...chats, ...pages, projectItem({ projectKey: "p", name: "p", path: "p" })]);
    expect(titles(list).slice(0, 7)).toEqual(NAV.map((n) => n.label));
    expect(titles(list).slice(7)).toEqual(["chat 9", "chat 8", "chat 7", "chat 6", "chat 5", "chat 4"]);
    expect(rankItems([...chats, ...pages], "   ")).toEqual(list.filter((l) => l.kind !== "project"));
  });
});

describe("bold ranges", () => {
  it("marks each typed word, preferring a word start, merging overlaps", () => {
    expect(matchRanges("retry", "Fix the retry loop")).toEqual([[8, 13]]);
    expect(matchRanges("loop retry", "Fix the retry loop")).toEqual([
      [8, 13],
      [14, 18],
    ]);
    expect(matchRanges("re retry", "Fix the retry loop")).toEqual([[8, 13]]);
    expect(matchRanges("zz", "Fix the retry loop")).toEqual([]);
    expect(matchRanges("", "abc")).toEqual([]);
  });
});

describe("the picked row", () => {
  it("wraps with the arrows and stays in range when the list shrinks", () => {
    expect(stepIndex(0, -1, 5)).toBe(4);
    expect(stepIndex(4, 1, 5)).toBe(0);
    expect(stepIndex(2, 1, 5)).toBe(3);
    expect(stepIndex(0, 1, 0)).toBe(0);
    expect(clampIndex(7, 3)).toBe(2);
    expect(clampIndex(-1, 3)).toBe(0);
    expect(clampIndex(5, 0)).toBe(0);
  });
});
