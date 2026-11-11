import { describe, expect, it } from "vitest";
import {
  bestRun,
  buildCard,
  buildSlides,
  cardRidge,
  coderType,
  daysBetween,
  heatGraphic,
  HEAT_DAYS,
  hourLabel,
  hourTotals,
  novelsHint,
  novelsOf,
  peakHour,
  plainNames,
  rangeLabel,
  rangeLong,
  slideLayout,
  spikeGraphic,
  SPIKE_DAYS,
  weekdayAverages,
  weekdayOf,
  weekdayTied,
  shortDay,
  longDay,
} from "./wrappedModel";
import type { Slide, WrappedData } from "./wrappedModel";
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
  biggest: null,
  chatTokens: 48_000_000,
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
      { label: "pixel-garden", value: 18 },
    ],
    models: [
      { label: "Opus 5.5", value: 40 },
      { label: "Sonnet 5.5", value: 8 },
    ],
    longest: null,
    biggest: null,
    habits: null,
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
    habits: habits({ chats: 100, shortChats: 20, longChats: 5, allTokens: 100, helperTokens: 5, chatTokens: 100 }),
    ...over,
  });
}


/** A long, rich history with a different number on every slide, so a repeat would show. */
function rich(over: Partial<WrappedData> = {}): WrappedData {
  const spanDays = 124;
  const dayTokens = Array.from({ length: spanDays }, (_, i) => (i % 5 === 4 ? 0 : 2_000_000 + ((i * 7) % 13) * 400_000));
  // The busiest day is Oct 19: day 102 of a history that starts on Jul 9.
  dayTokens[102] = 150_000_000;
  const hoursRich = new Array<number>(24).fill(1_000_000);
  hoursRich[17] = 9_000_000;
  return data({
    from: "2026-07-09",
    to: "2026-11-09",
    spanDays,
    activeDays: 74,
    tokens: 640_000_000,
    sessions: 410,
    busiest: { day: "2026-10-19", tokens: 150_000_000, sessions: 18 },
    longestStreak: 15,
    streak: 3,
    hours: hoursRich,
    hoursDays: 120,
    dayTokens,
    skills: [item("release-notes", "skill", 31, 22), item("design:design-critique", "skill", 9, 5)],
    agents: [item("general-purpose", "agent", 320, 25)],
    tools: [item("Bash", "tool", 52_000, 263)],
    skillUses: 40,
    projects: [
      { label: "Trail Guide", value: 410_000_000 },
      { label: "atlas", value: 90_000_000 },
    ],
    models: [
      { label: "Opus 5.5", value: 330_000_000 },
      { label: "Sonnet 5.5", value: 100_000_000 },
    ],
    longest: chat({ projectName: "helper bot", durationMs: (10 * 24 + 17) * 3_600_000, startedAt: new Date(2026, 6, 26, 9).getTime() }),
    biggest: chat({ sessionId: "s2", projectName: "Trail Guide", tokens: tok(110_000_000) }),
    habits: habits({ chats: 100, chatTokens: 234_000_000, allTokens: 640_000_000, helperTokens: 300_000_000 }),
    ...over,
  });
}

const ids = (d: WrappedData) => buildSlides(d).map((s) => s.id);
const numbers = (text: string) => text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
/** Everything a slide says out loud (the card, which recaps, is checked on its own). */
const said = (s: Slide) => [s.kicker, s.figure, s.unit ?? "", s.line].join(" ");

describe("buildSlides: the Summit story", () => {
  it("tells the full 15-slide story in order and ends on the card", () => {
    expect(ids(rich())).toEqual([
      "opener",
      "tokens",
      "days",
      "busiest",
      "weekday",
      "rhythm",
      "long",
      "biggest",
      "project",
      "skill",
      "helper",
      "tool",
      "models",
      "type",
      "card",
    ]);
  });

  it("reads each slide from the real numbers", () => {
    const by = Object.fromEntries(buildSlides(rich()).map((s) => [s.id, s]));
    expect(by.tokens.figure).toBe("640M");
    expect(by.tokens.line).toBe("About 4,800 novels' worth of words.");
    expect(by.days.figure).toBe("74");
    expect(by.days.unit).toBe("of 124");
    expect(by.days.line).toBe("Best run: 15 days in a row.");
    expect(by.busiest.figure).toBe("Mon, Oct 19");
    expect(by.busiest.line).toBe("150M tokens over 18 sessions.");
    expect(by.rhythm.figure).toBe("5 PM");
    expect(by.rhythm.line).toBe("Your busiest hour over the last 120 days.");
    expect(by.long.figure).toBe("10 d 17 h");
    expect(by.long.line).toBe("Started Jul 26.");
    expect(by.biggest.figure).toBe("110M");
    expect(by.biggest.unit).toBe("tokens");
    expect(by.biggest.line).toBe("That is 47 times a usual session.");
    expect(by.project.figure).toBe("Trail Guide");
    expect(by.project.line).toBe("64% of your tokens.");
    expect(by.skill.figure).toBe("release-notes");
    expect(by.skill.line).toBe("Used 31 times in 22 sessions.");
    expect(by.helper.line).toBe("Called 320 times in 25 sessions.");
    // A helper reads as it does on Team and Sessions, not as its type id.
    expect(by.helper.figure).toBe("General purpose");
    expect(by.helper.hint).toBeUndefined();
    expect(by.tool.figure).toBe("Bash");
    expect(by.tool.line).toBe("Run 52,000 times in 263 sessions.");
    expect(by.models.figure).toBe("Opus 5.5");
    expect(by.models.line).toBe("52% of your tokens.");
  });

  it("gives the opener no stats: a year, a title and where the numbers start", () => {
    const o = buildSlides(rich())[0];
    expect(o.id).toBe("opener");
    expect(o.figure).toBe("2026");
    expect(o.title).toBe("Your year in Claude Code");
    expect(o.line).toBe(rangeLabel({ from: "2026-07-09" }));
    expect(o.line).toBe("Jul 9 to today");
    expect(o.unit).toBeUndefined();
    expect(o.graphic).toBeUndefined();
    expect(o.hint).toBeUndefined();
    expect(o.strong).toBeUndefined();
  });

  it("states every fact once: no number, figure or kicker on two slides", () => {
    const slides = buildSlides(rich()).filter((s) => s.id !== "opener" && !s.card);
    const seen = new Map<string, string>();
    for (const s of slides) {
      for (const n of new Set(numbers(said(s)))) {
        expect(seen.get(n), `"${n}" is on ${seen.get(n)} and ${s.id}`).toBeUndefined();
        seen.set(n, s.id);
      }
    }
    expect(new Set(slides.map((s) => s.figure)).size).toBe(slides.length);
    expect(new Set(slides.map((s) => s.kicker)).size).toBe(slides.length);
    expect(new Set(slides.map((s) => s.line)).size).toBe(slides.length);
  });

  it("names a project on one slide only", () => {
    const slides = buildSlides(rich());
    const on = (name: string) => slides.filter((s) => !s.card && said(s).includes(name)).map((s) => s.id);
    expect(on("Trail Guide")).toEqual(["project"]);
    // The chats' own projects are not named on their slides.
    expect(on("helper bot")).toEqual([]);
  });

  it("tells one chat once when the longest and the biggest are the same chat", () => {
    const one = chat({ sessionId: "same", projectName: "atlas", durationMs: 86_400_000, tokens: tok(110_000_000) });
    const got = ids(rich({ longest: one, biggest: one }));
    expect(got).toContain("long");
    expect(got).not.toContain("biggest");
    expect(ids(rich({ longest: one, biggest: { ...one, sessionId: "other" } }))).toContain("biggest");
  });

  it("rounds a ratio before it chooses how to write it", () => {
    // 9.97 times a usual chat is "10", not "10.0"; 9.94 is "9.9".
    const times = (ratio: number) =>
      buildSlides(rich({ biggest: chat({ sessionId: "s2", tokens: tok(Math.round(ratio * 2_340_000)) }) })).find((s) => s.id === "biggest")!.strong;
    expect(times(9.97)).toBe("10 times");
    expect(times(9.94)).toBe("9.9 times");
    expect(times(3.44)).toBe("3.4 times");
  });

  it("names a weekday tie even when float noise separates the averages", () => {
    const week = [0.1 + 0.2, 0.3, 0.1, 0.1, 0.1, 0.1, 0.1];
    expect(week[0]).not.toBe(week[1]);
    expect(weekdayTied(week)).toEqual([0, 1]);
    const slide = buildSlides(rich({ from: "2026-11-02", to: "2026-11-08", spanDays: 7, activeDays: 7, dayTokens: week.map((v) => v * 1e9) })).find((s) => s.id === "weekday")!;
    expect(slide.figure).toBe("Mon and Tue");
  });

  it("says the same novel count in the line and in its hover", () => {
    for (const tokens of [640_000_000, 23_300_000, 14_000_000, 1_400_000]) {
      const s = buildSlides(rich({ tokens })).find((x) => x.id === "tokens")!;
      const said = /About (.+) worth/.exec(s.line)![1].replace(/ novels?'s?$/, "").replace(/'$/, "");
      expect(s.strongHint, String(tokens)).toContain("about " + said + ".");
    }
  });

  it("skips a slide whose numbers are missing instead of filling it", () => {
    const bare = rich({
      busiest: null,
      hours: new Array<number>(24).fill(0),
      longest: null,
      biggest: null,
      projects: [],
      skills: [],
      agents: [],
      tools: [],
      models: [],
      habits: null,
    });
    // Nothing is invented: only the slides that still have their numbers are left.
    expect(ids(bare)).toEqual(["opener", "tokens", "days", "weekday", "card"]);
    expect(ids(rich({ tokens: 0, activeDays: 0 }))).not.toContain("tokens");
    expect(ids(rich({ tokens: 0, activeDays: 0 }))).not.toContain("days");
    // A chat with no length, and one that used nothing, do not get a slide either.
    expect(ids(rich({ longest: chat({ durationMs: 0 }), biggest: chat({ tokens: tok(0) }) }))).not.toContain("long");
    expect(ids(rich({ longest: chat({ durationMs: 0 }), biggest: chat({ tokens: tok(0) }) }))).not.toContain("biggest");
  });

  it("tells the short story under a week of active days", () => {
    expect(ids(rich({ activeDays: 3 }))).toEqual(["opener", "tokens", "busiest", "skill", "card"]);
    // Only the first favorite is kept; with no skill it is the helper, then the tool.
    expect(ids(rich({ activeDays: 3, skills: [] }))).toEqual(["opener", "tokens", "busiest", "helper", "card"]);
    expect(ids(rich({ activeDays: 3, skills: [], agents: [] }))).toEqual(["opener", "tokens", "busiest", "tool", "card"]);
  });

  it("names a weekday tie as a tie and says nothing when most days tie", () => {
    const flat = (values: number[]) => rich({ from: "2026-11-02", to: "2026-11-08", spanDays: 7, dayTokens: values, activeDays: 7 });
    const two = buildSlides(flat([9, 9, 1, 1, 1, 1, 1])).find((s) => s.id === "weekday")!;
    expect(two.figure).toBe("Mon and Tue");
    expect(two.line).toMatch(/each\.$/);
    expect(ids(flat([5, 5, 5, 1, 1, 1, 1]))).not.toContain("weekday");
  });

  it("makes the circles to scale and drops them when the chat is not far above a usual one", () => {
    const big = buildSlides(rich()).find((s) => s.id === "biggest")!;
    expect(big.graphic).toMatchObject({ kind: "circles" });
    expect((big.graphic as { ratio: number }).ratio).toBeCloseTo(47, 0);
    // Average chat = chatTokens / chats (the chats the count covers), never the range total.
    const near = buildSlides(rich({ habits: habits({ chats: 100, chatTokens: 9_000_000_000 }) })).find((s) => s.id === "biggest")!;
    expect(near.graphic).toBeUndefined();
    expect(near.line).toBe("More than any other single session.");
    expect(near.strong).toBeUndefined();
  });

  it("puts each slide's one graphic where it belongs", () => {
    const by = Object.fromEntries(buildSlides(rich()).map((s) => [s.id, s]));
    expect(by.days.graphic?.kind).toBe("heat");
    expect(by.busiest.graphic?.kind).toBe("spike");
    expect(by.weekday.graphic?.kind).toBe("weekdays");
    expect(by.rhythm.graphic?.kind).toBe("hours");
    expect(by.biggest.graphic?.kind).toBe("circles");
    for (const id of ["opener", "tokens", "long", "project", "skill", "helper", "tool", "models", "type", "card"]) {
      expect(by[id].graphic, id).toBeUndefined();
    }
  });

  it("lays slides out by what they carry", () => {
    const by = Object.fromEntries(buildSlides(rich()).map((s) => [s.id, s]));
    expect(slideLayout(by.opener)).toBe("opener");
    expect(slideLayout(by.tokens)).toBe("center");
    expect(slideLayout(by.days)).toBe("split");
    expect(slideLayout(by.rhythm)).toBe("split");
    expect(slideLayout(by.biggest)).toBe("split");
    expect(slideLayout(by.busiest)).toBe("stack");
    expect(slideLayout(by.weekday)).toBe("stack");
    expect(slideLayout(by.card)).toBe("card");
  });

  it("keeps hovers to the exact counts and the novels source, nothing generic", () => {
    const hovered = buildSlides(rich())
      .filter((s) => s.hint || s.strongHint)
      .map((s) => s.id);
    expect(hovered).toEqual(["tokens", "biggest"]);
    const by = Object.fromEntries(buildSlides(rich()).map((s) => [s.id, s]));
    expect(by.tokens.hint).toBe("640,000,000 tokens");
    // The session's hover lists its four kinds and adds them all together, then says what it is.
    expect(by.biggest.hint).toMatch(/^110,000,000 tokens\nInput\t[\d,]+\nOutput\t[\d,]+\nCache writes\t[\d,]+\nCache reads\t[\d,]+\n=All together\t[\d,]+\nIn one session\.$/);
    expect(by.tokens.strongHint).toContain("0.75 words per token");
    expect(by.biggest.strongHint).toBeUndefined();
  });

  it("uses ASCII only and never money", () => {
    const text = JSON.stringify(buildSlides(rich()));
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).not.toContain("$");
    expect(text).not.toContain("Live");
  });

  it("uses the singular for one", () => {
    const s = buildSlides(rich({ agents: [item("reviewer", "agent", 1, 1)], busiest: { day: "2026-10-19", tokens: 5_000_000, sessions: 1 } }));
    expect(s.find((x) => x.id === "helper")!.line).toBe("Called 1 time in 1 session.");
    expect(s.find((x) => x.id === "busiest")!.line).toBe("5M tokens over 1 session.");
  });

  it("says there was never a run when no two days touch", () => {
    const d = rich({ longestStreak: 1 });
    expect(buildSlides(d).find((s) => s.id === "days")!.line).toBe("Never two days in a row yet.");
  });

  it("drops the plugin prefix from a skill's name unless two would then read the same", () => {
    expect(plainNames(["design:design-critique", "code-review"])).toEqual(["design-critique", "code-review"]);
    expect(plainNames(["a:review", "b:review"])).toEqual(["a:review", "b:review"]);
    expect(buildSlides(rich({ skills: [item("design:design-critique", "skill", 9, 5)] })).find((s) => s.id === "skill")!.figure).toBe("design-critique");
  });

  it("shows a connector's tool by the tool's own name, with the exact id as the hover", () => {
    expect(plainNames(["mcp__browser__read_page", "Bash"])).toEqual(["read_page", "Bash"]);
    expect(plainNames(["mcp__a__read", "mcp__b__read"])).toEqual(["mcp__a__read", "mcp__b__read"]);
    const tool = buildSlides(rich({ tools: [item("mcp__browser__read_page", "tool", 9, 5)] })).find((s) => s.id === "tool")!;
    expect(tool.figure).toBe("read_page");
    expect(tool.hint).toBe("mcp__browser__read_page");
    // A name shown as it is has nothing more exact to say.
    expect(buildSlides(rich({ tools: [item("Bash", "tool", 9, 5)] })).find((s) => s.id === "tool")!.hint).toBeUndefined();
  });

  it("has no novels phrase for a small total", () => {
    const t = buildSlides(rich({ tokens: 100_000 })).find((s) => s.id === "tokens")!;
    expect(t.line).toBe("");
    expect(t.strong).toBeUndefined();
    expect(t.strongHint).toBeUndefined();
  });
});

describe("the end card", () => {
  it("recaps the headline facts and nothing from a chat", () => {
    const secret = "SECRET FIRST PROMPT";
    const d = rich({
      longest: chat({ name: secret, projectName: "helper bot", durationMs: 90_000_000 }),
      biggest: chat({ name: secret, tokens: tok(110_000_000) }),
      habits: habits({ chats: 100, chatTokens: 234_000_000, mostHelpers: chat({ name: secret, agentCount: 5 }) }),
    });
    const slides = buildSlides(d);
    const end = slides[slides.length - 1];
    const card = end.card!;
    expect(end.id).toBe("card");
    expect(end.line).toBe("");
    expect(card.title).toBe("Atlas Wrapped");
    expect(card.range).toBe("Jul 9 to Nov 9, 2026");
    expect(card.tokens).toBe(slides.find((s) => s.id === "tokens")!.figure);
    expect(card.unit).toBe("tokens");
    expect(card.facts).toEqual([
      { value: "74", label: "active days" },
      { value: "5 PM", label: "prime time" },
      { value: "Trail Guide", label: "top project" },
      { value: slides.find((s) => s.id === "type")!.figure, label: "coder type" },
    ]);
    expect(card.day).toBe("2026-11-09");
    expect(card.ridge.length).toBeGreaterThan(1);
    expect(Math.max(...card.ridge)).toBe(1);
    expect(JSON.stringify(card)).not.toContain(secret);
    expect(JSON.stringify(card)).not.toContain("$");
  });

  it("is the one slide that repeats facts, and it is always last", () => {
    const slides = buildSlides(rich());
    expect(slides.filter((s) => s.card)).toHaveLength(1);
    expect(slides[slides.length - 1].card).toBeDefined();
    // The card's figure is the total the tokens slide already said: the deliberate recap.
    expect(slides[slides.length - 1].figure).toBe(slides[1].figure);
  });

  it("leaves out a fact whose number is missing and shows the main model when there is no type", () => {
    const card = buildCard(rich({ projects: [], hours: new Array<number>(24).fill(0), activeDays: 0 }), null);
    expect(card.facts).toEqual([{ value: "Opus 5.5", label: "main model" }]);
    expect(buildCard(rich({ models: [] }), null).facts.map((f) => f.label)).toEqual(["active days", "prime time", "top project"]);
    expect(buildCard(rich({ activeDays: 1 }), null).facts[0]).toEqual({ value: "1", label: "active day" });
  });

  it("still builds for a history with nothing but a total", () => {
    const d = rich({ activeDays: 0, busiest: null, hours: new Array<number>(24).fill(0), longest: null, biggest: null, projects: [], skills: [], agents: [], tools: [], models: [], habits: null });
    expect(ids(d)).toEqual(["opener", "tokens", "card"]);
  });
});

describe("the graphics' data", () => {
  it("finds the best run, the later one on a tie, and none when no two days touch", () => {
    expect(bestRun([0, 5, 5, 5, 0, 5, 5, 5, 0])).toEqual([5, 7]);
    expect(bestRun([5, 0, 5, 0, 5])).toBeNull();
    expect(bestRun([])).toBeNull();
  });

  it("rings the best run in the calendar", () => {
    const h = heatGraphic({ to: "2026-11-08", dayTokens: [0, 5, 5, 5, 0, 5, 0, 0, 5] })!;
    expect(h.run).toEqual([1, 3]);
    expect(h.values).toHaveLength(9);
    expect(heatGraphic({ to: "2026-11-08", dayTokens: [7] })).toBeUndefined();
    expect(heatGraphic({ to: "2026-11-08", dayTokens: [5, 0, 5, 0, 5] })!.run).toBeNull();
  });

  it("rings the best run only when it is on show", () => {
    // A history longer than the calendar: the best run (days 2-6) is out of the window, so no ring.
    const long = Array.from({ length: HEAT_DAYS + 40 }, (_, i) => (i >= 2 && i <= 6 ? 9 : i % 3 === 0 ? 0 : 1));
    expect(heatGraphic({ to: "2026-11-08", dayTokens: long })!.values).toHaveLength(HEAT_DAYS);
    expect(heatGraphic({ to: "2026-11-08", dayTokens: long })!.run).toBeNull();
    // The same run inside the window is ringed, with indexes into the window.
    const inside = Array.from({ length: HEAT_DAYS + 40 }, (_, i) => (i >= 200 && i <= 205 ? 9 : 0));
    expect(heatGraphic({ to: "2026-11-08", dayTokens: inside })!.run).toEqual([200 - 40, 205 - 40]);
  });

  it("centers the spike on the busiest day and keeps the window inside the history", () => {
    const days = Array.from({ length: 31 }, (_, i) => (i === 18 ? 9 : 1));
    const s = spikeGraphic({ from: "2026-10-09", dayTokens: days }, "2026-10-27")!;
    expect(s.values).toHaveLength(SPIKE_DAYS);
    expect(s.values[s.peak]).toBe(9);
    // A busiest day on the first day cannot center: the window starts at the first day.
    const edge = spikeGraphic({ from: "2026-10-09", dayTokens: days }, "2026-10-09")!;
    expect(edge.peak).toBe(0);
    expect(edge.first).toBe("Oct 9");
    expect(spikeGraphic({ from: "2026-10-09", dayTokens: days }, "2027-01-01")).toBeUndefined();
  });

  it("draws the hours and weekdays from the model's own numbers", () => {
    const s = buildSlides(rich());
    const hrs = s.find((x) => x.id === "rhythm")!.graphic as { values: number[]; days: number; peak: number };
    expect(hrs.values).toHaveLength(24);
    expect(hrs.days).toBe(120);
    expect(hrs.peak).toBe(17);
    expect((s.find((x) => x.id === "weekday")!.graphic as { values: number[] }).values).toHaveLength(7);
  });

  it("makes the card ridge 0 to 1 and never below the baseline", () => {
    const r = cardRidge(Array.from({ length: 100 }, (_, i) => i % 7), 40);
    expect(r).toHaveLength(40);
    expect(Math.max(...r)).toBe(1);
    expect(Math.min(...r)).toBeGreaterThanOrEqual(0);
    expect(cardRidge([])).toEqual([]);
    expect(cardRidge([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("the range", () => {
  it("says only where the numbers start, and the dated range for the card", () => {
    expect(rangeLabel({ from: "2026-10-09" })).toBe("Oct 9 to today");
    expect(rangeLong({ from: "2026-07-09", to: "2026-11-09" })).toBe("Jul 9 to Nov 9, 2026");
  });

  it("gives the start its year when the history began in an earlier year", () => {
    expect(rangeLabel({ from: "2025-12-09", to: "2027-01-05" })).toBe("Dec 9, 2025 to today");
    expect(rangeLabel({ from: "2026-12-09", to: "2026-12-30" })).toBe("Dec 9 to today");
    expect(rangeLong({ from: "2025-12-09", to: "2027-01-05" })).toBe("Dec 9, 2025 to Jan 5, 2027");
    const opener = buildSlides(rich({ from: "2025-12-09", to: "2027-01-05", spanDays: 393, dayTokens: [] }))[0];
    expect(opener.line).toBe("Dec 9, 2025 to today");
    expect(opener.figure).toBe("2027");
  });
});

describe("day names", () => {
  it("names a day, short and long, and its Monday-first weekday", () => {
    expect(shortDay("2026-11-09")).toBe("Nov 9");
    expect(longDay("2026-11-09")).toBe("Mon, Nov 9");
    expect(weekdayOf("2026-11-09")).toBe(0);
    expect(weekdayOf("2026-11-15")).toBe(6);
    expect(weekdayOf("2026-11-14")).toBe(5);
  });
});

describe("weekdayAverages", () => {
  it("averages each weekday over how many of it the span holds, Monday first", () => {
    // 2026-11-02 is a Monday; the span holds two Mondays (1 and 10).
    const t = weekdayAverages("2026-11-02", [1, 2, 3, 4, 5, 6, 7, 10]);
    expect(t).toEqual([5.5, 2, 3, 4, 5, 6, 7]);
  });

  it("starts a week on Sunday correctly", () => {
    expect(weekdayAverages("2026-11-08", [9, 1])).toEqual([1, 0, 0, 0, 0, 0, 9]);
  });

  it("does not favor the weekdays a span has one more of", () => {
    // Ten days of the same 100 tokens from a Monday: Mon, Tue, Wed hold two; the rest hold one.
    const t = weekdayAverages("2026-11-02", new Array(10).fill(100));
    expect(t).toEqual([100, 100, 100, 100, 100, 100, 100]);
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
    expect(novelsOf(48_200_000)).toBeCloseTo(361.5, 1);
    const hint = novelsHint(48_200_000);
    expect(hint).toContain("0.75 words per token");
    expect(hint).toContain("100,000 words per novel");
    expect(hint).toContain("An estimate");
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
    expect(t.why).toContain("20 of 50 sessions (40%) ran two hours or more");
  });

  it("calls someone with many tiny chats a Sprinter", () => {
    const t = coderType(plain({ habits: habits({ chats: 40, shortChats: 30, longChats: 1, allTokens: 100, helperTokens: 5 }) }))!;
    expect(t.id).toBe("sprinter");
    expect(t.why).toContain("30 of 40 sessions (75%) were over in under ten minutes");
  });

  it("calls someone who uses skills in every chat a Toolsmith", () => {
    const t = coderType(plain({ skillUses: 240, habits: habits({ chats: 100, shortChats: 20, longChats: 5, allTokens: 100, helperTokens: 5 }) }))!;
    expect(t.id).toBe("toolsmith");
    expect(t.why).toBe("240 skill uses across 100 sessions. Toolsmith starts at one skill use per session.");
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
    expect(hourLabel(0, "en-US")).toBe("12 AM");
    expect(hourLabel(12, "en-US")).toBe("12 PM");
    expect(hourLabel(22, "en-US")).toBe("10 PM");
    expect(hourLabel(22, "en-GB")).toBe("22:00");
    expect(peakHour(new Array(24).fill(0))).toBeNull();
  });

});
