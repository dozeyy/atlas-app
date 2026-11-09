import { describe, expect, it } from "vitest";
import {
  buildCard,
  buildSlides,
  coderType,
  coverageLine,
  daysBetween,
  hourLabel,
  hourTotals,
  novelsAside,
  peakHour,
  weekdayTotals,
  MAX_CELEBRATIONS,
} from "./wrappedModel";
import type { WrappedData } from "./wrappedModel";
import type { ItemUse, SessionRow, Tokens, WrappedHabits } from "./usageTypes";

const item = (id: string, kind: ItemUse["kind"], uses: number, sessions: number): ItemUse => ({ id, kind, uses, sessions, lastUsed: null });
const hours = (peak: number) => Array.from({ length: 24 }, (_, h) => (h === peak ? 900 : h === peak - 1 ? 300 : 10));
const tok = (n: number): Tokens => ({ input: n, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: n, webSearch: 0, webFetch: 0 });

function chat(over: Partial<SessionRow> = {}): SessionRow {
  return {
    sessionId: "s1",
    title: null,
    name: "SECRET FIRST PROMPT",
    nameSource: "prompt",
    agentCount: 0,
    projectName: "atlas",
    projectPath: "C:/work/atlas",
    startedAt: new Date(2026, 9, 9, 10).getTime(),
    endedAt: new Date(2026, 9, 9, 11).getTime(),
    durationMs: 3_600_000,
    models: ["claude-opus-5-5"],
    messages: 40,
    subagentMessages: 0,
    tokens: tok(6_500_000),
    cost: { usd: null, complete: true, unpricedTokens: 0 },
    missing: false,
    ...over,
  };
}

const habits = (over: Partial<WrappedHabits> = {}): WrappedHabits => ({
  chats: 100,
  shortChats: 20,
  longChats: 5,
  allTokens: 48_200_000,
  helperTokens: 4_000_000,
  mostHelpers: null,
  ...over,
});

/** Evenly spread day, flat hours: no habit reaches its bar. */
const flatHours = () => new Array<number>(24).fill(100);

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
    hoursDays: 31,
    dayTokens: new Array(31).fill(1_000_000),
    skills: [
      item("frontend-design", "skill", 41, 18),
      item("code-review", "skill", 12, 7),
    ],
    agents: [item("reviewer", "agent", 20, 10)],
    tools: [item("Edit", "tool", 900, 100)],
    skillUses: 53,
    projects: [
      { label: "atlas", value: 30 },
      { label: "heavens-casino", value: 18 },
    ],
    models: [
      { label: "Opus 5.5", value: 40 },
      { label: "Sonnet 5.5", value: 8 },
    ],
    longest: null,
    biggest: null,
    first: null,
    habits: null,
    keepDays: 30,
    ...over,
  };
}

/** A person with no standout habit: flat hours, ordinary chats, spread over projects. */
function plain(over: Partial<WrappedData> = {}): WrappedData {
  return data({
    hours: flatHours(),
    activeDays: 12,
    projects: [
      { label: "atlas", value: 20 },
      { label: "site", value: 20 },
    ],
    tokens: 100,
    skillUses: 3,
    habits: habits({ chats: 100, shortChats: 20, longChats: 5, allTokens: 100, helperTokens: 5 }),
    ...over,
  });
}

describe("buildSlides", () => {
  it("tells the full story with real numbers and ends on the card", () => {
    const s = buildSlides(data());
    const ids = s.map((x) => x.id);
    expect(ids).toEqual(["tokens", "days", "project", "skill", "helper", "tool", "busiest", "weekday", "rhythm", "models", "type", "card"]);
    expect(s[0].figure).toBe("48M");
    expect(s.find((x) => x.id === "skill")?.figure).toBe("frontend-design");
    expect(s[s.length - 1].line).toContain("clears its logs after 30 days");
  });

  it("adds the big-number slides when their data exists", () => {
    const crowd = chat({ sessionId: "c", name: "Crowd chat", agentCount: 7 });
    const s = buildSlides(
      data({
        biggest: chat({ name: "Biggest chat name", projectName: "heavens-casino", tokens: tok(6_500_000) }),
        first: chat({ name: "First chat name", startedAt: new Date(2026, 9, 9, 10).getTime() }),
        longest: chat({ name: "Longest chat name", durationMs: 7_200_000 }),
        habits: habits({ mostHelpers: crowd }),
        skills: [item("a", "skill", 9, 5), item("b", "skill", 8, 5), item("c", "skill", 7, 5), item("d", "skill", 6, 5), item("e", "skill", 5, 5)],
      }),
    );
    expect(s.map((x) => x.id)).toEqual(["tokens", "first", "days", "biggest", "long", "project", "skill", "helper", "crowd", "tool", "busiest", "weekday", "rhythm", "models", "type", "card"]);
    const biggest = s.find((x) => x.id === "biggest")!;
    expect(biggest.figure).toBe("6.5M");
    expect(biggest.line).toBe("Biggest chat name, in heavens-casino. One chat did all that.");
    const first = s.find((x) => x.id === "first")!;
    expect(first.figure).toBe("Oct 9");
    expect(first.line).toBe("30 days ago: First chat name, in atlas. No going back.");
    const crowdSlide = s.find((x) => x.id === "crowd")!;
    expect(crowdSlide.figure).toBe("7");
    expect(crowdSlide.unit).toBe("helpers");
    expect(crowdSlide.line).toBe("Crowd chat, in atlas. A whole crew.");
  });

  it("makes the skill slide a five to one countdown instead of a second skill slide", () => {
    const five = ["a", "b", "c", "d", "e"].map((id, i) => item(id, "skill", 9 - i, 5));
    const s = buildSlides(data({ skills: five }));
    expect(s.filter((x) => x.id === "skill")).toHaveLength(1);
    const skill = s.find((x) => x.id === "skill")!;
    expect(skill.kicker).toBe("Your top 5 skills, counted down");
    expect(skill.figure).toBe("a");
    expect(skill.chart).toMatchObject({ kind: "countdown" });
    // One skill is just the favorite, with no chart.
    const one = buildSlides(data({ skills: [item("only", "skill", 3, 2)] })).find((x) => x.id === "skill")!;
    expect(one.kicker).toBe("Favorite skill");
    expect(one.chart).toBeUndefined();
  });

  it("tells a short story when there are only a few active days", () => {
    const s = buildSlides(data({ activeDays: 3, spanDays: 3, dayTokens: [1, 2, 3], first: chat(), biggest: chat(), habits: habits() }));
    expect(s.map((x) => x.id)).toEqual(["tokens", "skill", "busiest", "card"]);
  });

  it("leaves out a slide whose numbers are missing instead of making them up", () => {
    const s = buildSlides(data({ skills: [], agents: [], tools: [], projects: [], models: [], busiest: null, hours: new Array(24).fill(0), dayTokens: [], skillUses: 0, activeDays: 22 }));
    expect(s.map((x) => x.id)).toEqual(["tokens", "days", "card"]);
  });

  it("counts tokens, never dollars", () => {
    const s = buildSlides(
      data({ habits: habits({ mostHelpers: chat({ agentCount: 4 }) }), biggest: chat(), first: chat() }),
    );
    const models = s.find((x) => x.id === "models");
    expect(models?.figure).toBe("Opus 5.5");
    expect(models?.line).toBe("83% of your tokens. Your ride or die.");
    expect(JSON.stringify(s)).not.toContain("$");
  });

  it("celebrates at most three moments", () => {
    const n = buildSlides(data({ longestStreak: 12 })).filter((x) => x.celebrate).length;
    expect(n).toBeLessThanOrEqual(MAX_CELEBRATIONS);
    expect(n).toBeGreaterThan(0);
  });

  it("uses the singular for one day", () => {
    const end = buildSlides(data({ spanDays: 1, activeDays: 1 })).pop();
    expect(end?.card?.days).toBe("1 active day of 1");
  });

  it("names the busiest weekday and shows all seven", () => {
    // 2026-10-09 is a Friday. Put the big days on Tuesdays.
    const days = Array.from({ length: 31 }, (_, i) => (new Date(2026, 9, 9 + i, 12).getDay() === 2 ? 5_000_000 : 1_000_000));
    const w = buildSlides(data({ dayTokens: days })).find((x) => x.id === "weekday")!;
    expect(w.figure).toBe("Tuesday");
    expect(w.chart).toMatchObject({ kind: "weekdays" });
    expect(w.line).toMatch(/^\d+% of your tokens land on a Tuesday\. Plan around it\.$/);
  });
});

describe("weekdayTotals", () => {
  it("adds each day to its weekday, Monday first", () => {
    // 2026-11-02 is a Monday.
    const t = weekdayTotals("2026-11-02", [1, 2, 3, 4, 5, 6, 7, 10]);
    expect(t).toEqual([11, 2, 3, 4, 5, 6, 7]);
  });

  it("starts a week on Sunday correctly", () => {
    expect(weekdayTotals("2026-11-08", [9, 1])).toEqual([1, 0, 0, 0, 0, 0, 9]);
  });
});

describe("days", () => {
  it("counts calendar days between two days", () => {
    expect(daysBetween("2026-10-09", "2026-11-08")).toBe(30);
    expect(daysBetween("2026-11-08", "2026-11-08")).toBe(0);
  });
});

describe("novels", () => {
  it("is an estimate with the conversion stated in the hover", () => {
    const a = novelsAside(48_200_000)!;
    expect(a.text).toBe("About 360 novels of text.");
    expect(a.hint).toContain("0.75 words per token");
    expect(a.hint).toContain("100,000 words per novel");
    expect(a.hint).toContain("An estimate");
  });

  it("says nothing under one novel", () => {
    expect(novelsAside(100_000)).toBeNull();
    expect(novelsAside(0)).toBeNull();
  });

  it("goes on the totals slide, with the hover", () => {
    const s = buildSlides(data());
    expect(s[0].aside?.text).toMatch(/^About \d+ novels of text\.$/);
  });
});

describe("coderType", () => {
  it("calls a late-night worker a Night Owl and says why with the real figure", () => {
    // 62% of the tokens between 9 pm and 4 am.
    const h = new Array<number>(24).fill(0);
    h[22] = 62;
    h[10] = 38;
    const t = coderType(plain({ hours: h }))!;
    expect(t.id).toBe("owl");
    expect(t.name).toBe("Night Owl");
    expect(t.why).toBe("62% of your tokens came between 9 pm and 4 am. Night Owl starts at 40%.");
  });

  it("calls an early starter an Early Bird", () => {
    const h = new Array<number>(24).fill(0);
    h[6] = 45;
    h[14] = 55;
    expect(coderType(plain({ hours: h }))?.id).toBe("bird");
  });

  it("calls someone whose helpers do the work a Delegator", () => {
    const t = coderType(plain({ habits: habits({ allTokens: 100, helperTokens: 52 }) }))!;
    expect(t.id).toBe("delegator");
    expect(t.why).toBe("Helpers spent 52% of your tokens. Delegator starts at 35%.");
  });

  it("calls someone with many two-hour chats a Marathoner", () => {
    const t = coderType(plain({ habits: habits({ chats: 50, longChats: 20, shortChats: 5, allTokens: 100, helperTokens: 5 }) }))!;
    expect(t.id).toBe("marathoner");
    expect(t.why).toContain("20 of 50 chats (40%) ran two hours or more");
  });

  it("calls someone with many tiny chats a Sprinter", () => {
    const t = coderType(plain({ habits: habits({ chats: 40, shortChats: 30, longChats: 1, allTokens: 100, helperTokens: 5 }) }))!;
    expect(t.id).toBe("sprinter");
    expect(t.why).toContain("30 of 40 chats (75%) were over in under ten minutes");
  });

  it("calls someone who uses skills in every chat a Toolsmith", () => {
    const t = coderType(plain({ skillUses: 240, habits: habits({ chats: 100, shortChats: 20, longChats: 5, allTokens: 100, helperTokens: 5 }) }))!;
    expect(t.id).toBe("toolsmith");
    expect(t.why).toBe("240 skill uses across 100 chats. Toolsmith starts at one skill use per chat.");
  });

  it("calls someone with one project a Loyalist", () => {
    const t = coderType(plain({ tokens: 100, projects: [{ label: "atlas", value: 82 }, { label: "site", value: 6 }] }))!;
    expect(t.id).toBe("loyalist");
    expect(t.why).toBe("82% of your tokens went to atlas. Loyalist starts at 70%.");
  });

  it("calls someone who shows up almost daily a Regular", () => {
    const t = coderType(plain({ activeDays: 28, spanDays: 31 }))!;
    expect(t.id).toBe("regular");
    expect(t.why).toBe("You used Claude Code on 28 of 31 days (90%). Regular starts at 80%.");
  });

  it("gives the habit with the highest score, not just the first one over its bar", () => {
    // Night share 50% (score 1.25) against sprinter 90% (score 1.8): the sprinter wins.
    const h = new Array<number>(24).fill(0);
    h[23] = 50;
    h[12] = 50;
    const t = coderType(plain({ hours: h, habits: habits({ chats: 100, shortChats: 90, longChats: 0, allTokens: 100, helperTokens: 5 }) }))!;
    expect(t.id).toBe("sprinter");
    expect(t.traits.map((x) => x.name)).toContain("Night Owl");
  });

  it("breaks a tie by the fixed order of the rules (owl before bird)", () => {
    // Night 40% (score 1) and early 30% (score 1): an exact tie, and the owl is listed first.
    const h = new Array<number>(24).fill(0);
    h[22] = 40;
    h[6] = 30;
    h[12] = 30;
    expect(coderType(plain({ hours: h }))?.id).toBe("owl");
  });

  it("falls back to the all-rounder when nothing reaches its bar, and says so", () => {
    const t = coderType(plain())!;
    expect(t.id).toBe("steady");
    expect(t.name).toBe("All-Rounder");
    expect(t.why).toContain("None of the habits reached its mark");
  });

  it("needs a real sample before a rule about chats may speak", () => {
    const few = coderType(plain({ habits: habits({ chats: 4, shortChats: 4, longChats: 4, allTokens: 100, helperTokens: 5 }) }))!;
    expect(["sprinter", "marathoner", "toolsmith"]).not.toContain(few.id);
  });

  it("is null when there is no habit data at all", () => {
    expect(coderType(data({ hours: new Array(24).fill(0), habits: null, projects: [], tokens: 0, spanDays: 3, activeDays: 3 }))).toBeNull();
  });

  it("says when the hour figure covers only the recent days", () => {
    const h = new Array<number>(24).fill(0);
    h[23] = 100;
    const t = coderType(plain({ hours: h, hoursDays: 120, spanDays: 300 }))!;
    expect(t.why).toContain("in the last 120 days");
  });

  it("puts the type on its own slide with the why in the hover", () => {
    const h = new Array<number>(24).fill(0);
    h[22] = 62;
    h[10] = 38;
    const s = buildSlides(plain({ hours: h })).find((x) => x.id === "type")!;
    expect(s.figure).toBe("Night Owl");
    expect(s.hint).toContain("62%");
  });
});

describe("share card", () => {
  it("carries totals, project, skill, model and type, and no chat name", () => {
    const secret = "SECRET FIRST PROMPT";
    const d = data({
      longest: chat({ name: secret }),
      biggest: chat({ name: secret }),
      first: chat({ name: secret }),
      habits: habits({ mostHelpers: chat({ name: secret, agentCount: 5 }) }),
    });
    const s = buildSlides(d);
    const card = s[s.length - 1].card!;
    expect(card.tokens).toBe("48M");
    expect(card.days).toBe("22 active days of 31");
    expect(card.tiles.map((t) => t.label)).toEqual(["Top project", "Top skill", "Main model", "Coder type"]);
    expect(card.tiles.find((t) => t.label === "Top project")?.value).toBe("atlas");
    expect(card.tiles.find((t) => t.label === "Top skill")?.value).toBe("frontend-design");
    expect(card.tiles.find((t) => t.label === "Main model")?.value).toBe("Opus 5.5");
    expect(card.range).toBe("Oct 9 to Nov 8");
    expect(card.day).toBe("2026-11-08");
    expect(JSON.stringify(card)).not.toContain(secret);
    expect(JSON.stringify(card)).not.toContain("$");
  });

  it("leaves out a tile whose number is missing", () => {
    const card = buildCard(data({ skills: [], models: [] }), null);
    expect(card.tiles.map((t) => t.label)).toEqual(["Top project"]);
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
