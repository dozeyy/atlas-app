// Wrapped: the story told from real numbers. Pure functions only; the queries live in
// wrappedLoad.ts. Nothing here invents data: a slide whose numbers are missing is not built.
// The story is direction A, "Summit" (docs/specs/wrapped-redesign/DIRECTIONS.md): one idea per
// slide, one hero figure or graphic, one short line, and no fact on two slides (the end card
// recaps them on purpose: it is the picture you save).

import { typeName } from "./helperProgress";
import { addDays, compact, exact, formatDuration, headline, hourName, plural } from "./usage";
import type { ItemUse, SessionRow, TimelinePoint, WrappedHabits } from "./usageTypes";

/** Stated conversion for the novels line: an estimate, never a measurement. */
export const WORDS_PER_TOKEN = 0.75;

export interface WrappedData {
  /** First day with any usage, and today. Local YYYY-MM-DD. */
  from: string;
  to: string;
  /** Calendar days from `from` to `to`, inclusive. */
  spanDays: number;
  activeDays: number;
  tokens: number;
  sessions: number;
  busiest: { day: string; tokens: number; sessions: number } | null;
  streak: number;
  longestStreak: number;
  /** Tokens per local hour of day (24 entries) over the recent window that was asked for. */
  hours: number[];
  /** How many days that hour window covers (the whole span, or the recent part of it). */
  hoursDays: number;
  /** Tokens per day from `from` to `to`. */
  dayTokens: number[];
  /** The top five skills, helpers and tools by use. */
  skills: ItemUse[];
  agents: ItemUse[];
  tools: ItemUse[];
  /** Every skill use in the range, for the Toolsmith rule (`skills` is only the top few). */
  skillUses: number;
  /** `label` is unique (a folder name two projects share gets its parent); `name` is the folder name alone. */
  projects: { label: string; value: number; name?: string; hint?: string }[];
  models: { label: string; value: number }[];
  /** The chat that ran longest by the clock. */
  longest: SessionRow | null;
  /** The chat that used the most tokens. */
  biggest: SessionRow | null;
  /** Chat shapes and helper work; null if the query failed. */
  habits: WrappedHabits | null;
}

/**
 * The one graphic a slide may carry, drawn from real numbers by src/components/wrapped/graphics.tsx.
 * No two kinds look alike and none is decoration: every mark is a day, an hour, a weekday or a chat.
 */
export type SlideGraphic =
  /** The calendar, today bottom-right; `run` (inclusive indexes into `values`) is the best streak, ringed. */
  | { kind: "heat"; values: number[]; to: string; run: [number, number] | null }
  /** The 24 hours as bars; `days` is how many days the totals cover. */
  | { kind: "hours"; values: number[]; days: number; peak: number }
  /** Seven bars, Monday first. */
  | { kind: "weekdays"; values: number[]; peak: number }
  /** The days around the busiest one; `peak` is its index. */
  | { kind: "spike"; values: number[]; peak: number; first: string; last: string }
  /** Two circles with areas in the ratio `ratio` to 1: this chat against a usual one. */
  | { kind: "circles"; ratio: number };

/** What the end card says: the headline facts only. Never a chat name or any prompt text. */
export interface ShareCard {
  title: string;
  /** "Jul 9 to Nov 9, 2026". */
  range: string;
  /** The one big figure ("873M") and its unit. */
  tokens: string;
  unit: string;
  /** Up to four short facts: a figure or name over its label. */
  facts: { value: string; label: string }[];
  /** The history as a small ridge: 0..1 heights, left to right. */
  ridge: number[];
  /** Today, local YYYY-MM-DD: the saved file's name. */
  day: string;
}

export interface Slide {
  id: string;
  /** A few words over the hero ("Days you showed up"); also the slide's name for screen readers. */
  kicker: string;
  /** The hero: a number, a name or a time. */
  figure: string;
  /** Small text after the hero ("of 124", "tokens"). */
  unit?: string;
  /** The opener's title line. */
  title?: string;
  /** The one short line. May be empty. */
  line: string;
  /** A phrase inside `line` that is set in bold. */
  strong?: string;
  /** Hover on the hero figure: only where it says something exact about it (the full token count). */
  hint?: string;
  /** Hover on the bold phrase, when it needs its source. */
  strongHint?: string;
  graphic?: SlideGraphic;
  card?: ShareCard;
}

export type SlideLayout = "opener" | "center" | "split" | "stack" | "card";

/** How a slide lays out: the card and the opener are their own; a graphic goes beside or under the words. */
export function slideLayout(s: Slide): SlideLayout {
  if (s.card) return "card";
  if (s.id === "opener") return "opener";
  if (!s.graphic) return "center";
  // Long names for a figure ("Wednesday", "Mon, Oct 19") need the full width, so their bars go under.
  return s.graphic.kind === "weekdays" || s.graphic.kind === "spike" ? "stack" : "split";
}

/** Fewer active days than this tells a shorter story. */
export const SHORT_STORY_DAYS = 7;

function dayDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}

export function shortDay(day: string): string {
  return dayDate(day).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function longDay(day: string): string {
  return dayDate(day).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

/** Whole calendar days from `a` to `b` (positive when `b` is later). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayDate(b).getTime() - dayDate(a).getTime()) / 86_400_000);
}

/** Tokens per local hour of day from hourly timeline points ("YYYY-MM-DDTHH:00..."). */
export function hourTotals(points: TimelinePoint[]): number[] {
  const out = new Array<number>(24).fill(0);
  for (const p of points) {
    const h = Number(p.start.slice(11, 13));
    if (Number.isInteger(h) && h >= 0 && h < 24) out[h] += headline(p.tokens);
  }
  return out;
}

/** An hour as the rest of the app writes it: "10 PM", or "22:00" on a 24 hour computer. */
export function hourLabel(h: number, locale?: string): string {
  return hourName(h, locale);
}

export function peakHour(hours: number[]): number | null {
  let best = -1;
  let at = -1;
  hours.forEach((v, i) => {
    if (v > best) {
      best = v;
      at = i;
    }
  });
  return best > 0 ? at : null;
}

// ---- weekdays ------------------------------------------------------------------------------

export const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const WEEKDAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday-first weekday index (0 = Monday) of a local day. */
export function weekdayOf(day: string): number {
  return (dayDate(day).getDay() + 6) % 7;
}

/** Weekdays whose average is the top one, give or take float noise. */
export function weekdayTied(week: number[]): number[] {
  const best = Math.max(...week);
  return week.map((_v, i) => i).filter((i) => week[i] >= best * (1 - 1e-9));
}

/**
 * Tokens on an average weekday, Monday first, from the per-day totals that start on `from`. Each
 * weekday's total is divided by how many of that weekday the span holds, so a span that is not a
 * whole number of weeks does not favor the days it contains one more of.
 */
export function weekdayAverages(from: string, dayTokens: number[]): number[] {
  const sums = new Array<number>(7).fill(0);
  const seen = new Array<number>(7).fill(0);
  const start = weekdayOf(from);
  dayTokens.forEach((v, i) => {
    const w = (start + i) % 7;
    sums[w] += v;
    seen[w] += 1;
  });
  return sums.map((s, w) => (seen[w] > 0 ? s / seen[w] : 0));
}

export const WORDS_PER_NOVEL = 100_000;

export function novelsOf(tokens: number): number {
  return (tokens * WORDS_PER_TOKEN) / WORDS_PER_NOVEL;
}

/** The novel count as it is said: two significant figures from 10 up, a whole number below. The line and its hover both use it. */
export function novelsRounded(tokens: number): number {
  const novels = novelsOf(tokens);
  return novels >= 10 ? Number(novels.toPrecision(2)) : Math.round(novels);
}

/** The conversion behind the novel count, for the phrase's hover. */
export function novelsHint(tokens: number): string {
  return (
    `${compact(tokens)} tokens x ${WORDS_PER_TOKEN} words per token / ${exact(WORDS_PER_NOVEL)} words per novel = about ${exact(novelsRounded(tokens))}.\n` +
    "An estimate. The count includes cache writes, so it is text that went through Claude, not words you typed."
  );
}

/** 0..1 heights for the small ridge on the share card: the days in `n` even bins, then normalised. */
export function cardRidge(dayTokens: number[], n = 40): number[] {
  if (dayTokens.length === 0) return [];
  const bins = Math.min(n, dayTokens.length);
  const out = new Array<number>(bins).fill(0);
  dayTokens.forEach((v, i) => {
    out[Math.min(bins - 1, Math.floor((i * bins) / dayTokens.length))] += v;
  });
  const max = Math.max(...out);
  return max > 0 ? out.map((v) => v / max) : out;
}

// ---- coder type ----------------------------------------------------------------------------

/** Hours that count as night (9 pm to before 4 am) and as early (5 am to before 9 am). */
export const NIGHT_HOURS = [21, 22, 23, 0, 1, 2, 3];
export const EARLY_HOURS = [5, 6, 7, 8];
/** A habit needs at least this many chats before a rule about chats may speak. */
export const MIN_CHATS_FOR_TYPE = 10;

export interface CoderType {
  id: string;
  name: string;
  line: string;
  /** The real figure that earned it, for the hover. */
  why: string;
}

interface Rule {
  id: string;
  name: string;
  line: string;
  /** The mark a habit must reach to count as yours. Score = value / bar. */
  bar: number;
  value: (d: WrappedData) => number | null;
  /** The sentence that says why, with the real figure; `v` is the value. */
  why: (d: WrappedData, v: number) => string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function hourShare(d: WrappedData, hours: number[]): number | null {
  const all = d.hours.reduce((a, b) => a + b, 0);
  if (all <= 0) return null;
  return hours.reduce((s, h) => s + (d.hours[h] ?? 0), 0) / all;
}

function chatShare(d: WrappedData, pick: (h: WrappedHabits) => number): number | null {
  const h = d.habits;
  return h && h.chats >= MIN_CHATS_FOR_TYPE ? pick(h) / h.chats : null;
}

const recently = (d: WrappedData) => (d.hoursDays < d.spanDays ? ` in the last ${exact(d.hoursDays)} days` : "");

/** `lead` + " the last 120 days" + `tail` when the hour data covers less than the whole history, else nothing. */
function hoursWindow(d: Pick<WrappedData, "hoursDays" | "spanDays">, lead: string, tail: string): string {
  return d.hoursDays < d.spanDays ? `${lead} the last ${exact(d.hoursDays)} days${tail}` : "";
}

/**
 * The rules, in tie order (the first listed wins a tie). Each is a plain share or rate with a
 * stated bar; none is a guess. The bars are judgments about what "a lot" means, written down here
 * so a result can be argued with.
 */
export const CODER_RULES: Rule[] = [
  {
    id: "owl",
    name: "Night Owl",
    line: "A lot of your work happens after dark.",
    bar: 0.4,
    value: (d) => hourShare(d, NIGHT_HOURS),
    why: (d, v) => `${pct(v)} of your tokens came between 9 pm and 4 am${recently(d)}. Night Owl starts at 40%.`,
  },
  {
    id: "bird",
    name: "Early Bird",
    line: "You get going before most people are up.",
    bar: 0.3,
    value: (d) => hourShare(d, EARLY_HOURS),
    why: (d, v) => `${pct(v)} of your tokens came between 5 am and 9 am${recently(d)}. Early Bird starts at 30%.`,
  },
  {
    id: "delegator",
    name: "Delegator",
    line: "You hand a lot of the work to helpers.",
    bar: 0.35,
    value: (d) => (d.habits && d.habits.allTokens > 0 ? d.habits.helperTokens / d.habits.allTokens : null),
    why: (_d, v) => `Helpers spent ${pct(v)} of your tokens. Delegator starts at 35%.`,
  },
  {
    id: "marathoner",
    name: "Marathoner",
    line: "You stay in one session for hours.",
    bar: 0.2,
    value: (d) => chatShare(d, (h) => h.longChats),
    why: (d, v) => `${exact(d.habits?.longChats ?? 0)} of ${exact(d.habits?.chats ?? 0)} sessions (${pct(v)}) ran two hours or more. Marathoner starts at 20%.`,
  },
  {
    id: "sprinter",
    name: "Sprinter",
    line: "You get in, get it done, get out.",
    bar: 0.5,
    value: (d) => chatShare(d, (h) => h.shortChats),
    why: (d, v) => `${exact(d.habits?.shortChats ?? 0)} of ${exact(d.habits?.chats ?? 0)} sessions (${pct(v)}) were over in under ten minutes. Sprinter starts at 50%.`,
  },
  {
    id: "toolsmith",
    name: "Toolsmith",
    line: "You reach for a skill in nearly every session.",
    bar: 1,
    value: (d) => (d.habits && d.habits.chats >= MIN_CHATS_FOR_TYPE ? d.skillUses / d.habits.chats : null),
    why: (d) => `${exact(d.skillUses)} skill uses across ${exact(d.habits?.chats ?? 0)} sessions. Toolsmith starts at one skill use per session.`,
  },
  {
    id: "loyalist",
    name: "Loyalist",
    line: "One project gets most of you.",
    bar: 0.7,
    value: (d) => (d.projects.length > 0 && d.tokens > 0 ? d.projects[0].value / d.tokens : null),
    why: (d, v) => `${pct(v)} of your tokens went to ${d.projects[0]?.label ?? "one project"}. Loyalist starts at 70%.`,
  },
  {
    id: "regular",
    name: "Regular",
    line: "You show up nearly every day.",
    bar: 0.8,
    value: (d) => (d.spanDays >= 14 ? d.activeDays / d.spanDays : null),
    why: (d, v) => `You used Claude Code on ${exact(d.activeDays)} of ${exact(d.spanDays)} days (${pct(v)}). Regular starts at 80%.`,
  },
];

export const STEADY: CoderType = {
  id: "steady",
  name: "All-Rounder",
  line: "No single habit runs your days.",
  why: "None of the habits reached its mark, so no one of them is yours.",
};

/**
 * Your coder type: the habit whose score (value / bar) is highest, if it reached 1. A tie goes to
 * the earlier rule in CODER_RULES. Nothing reaching its bar gives the all-rounder. Null when there
 * are fewer than two habits with numbers (and none reached its bar).
 */
export function coderType(d: WrappedData): CoderType | null {
  const scored = CODER_RULES.flatMap((r, order) => {
    const v = r.value(d);
    return v === null ? [] : [{ r, v, order, score: v / r.bar }];
  });
  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const top = scored[0];
  if (top.score >= 1) return { id: top.r.id, name: top.r.name, line: top.r.line, why: top.r.why(d, top.v) };
  // "No habit stands out" needs at least two habits to compare; one number is not a comparison.
  if (scored.length < 2) return null;
  return STEADY;
}

// ---- the share card ------------------------------------------------------------------------

/**
 * What goes on the card: the total, the range, the history as a ridge and up to four facts (days,
 * prime time, top project, coder type or else main model). Built from numbers and from project and
 * model names only. Chat names can come from the first prompt, so none is ever read here.
 */
export function buildCard(d: WrappedData, type: CoderType | null): ShareCard {
  const facts: { value: string; label: string }[] = [];
  if (d.activeDays > 0) facts.push({ value: exact(d.activeDays), label: d.activeDays === 1 ? "active day" : "active days" });
  const peak = peakHour(d.hours);
  if (peak !== null) facts.push({ value: hourLabel(peak), label: "prime time" });
  if (d.projects.length > 0) facts.push({ value: d.projects[0].name ?? d.projects[0].label, label: "top project" });
  if (type) facts.push({ value: type.name, label: "coder type" });
  else if (d.models.length > 0) facts.push({ value: d.models[0].label, label: "main model" });
  return {
    title: "Atlas Wrapped",
    range: rangeLong(d),
    tokens: compact(d.tokens),
    unit: "tokens",
    facts,
    ridge: cardRidge(d.dayTokens),
    day: d.to,
  };
}

// ---- the graphics' data ---------------------------------------------------------------------

/** The calendar shows at most this many days (26 weeks) so the cells stay big enough to read. */
export const HEAT_DAYS = 182;
/** The days around the busiest one that the spike graphic shows. */
export const SPIKE_DAYS = 21;

/**
 * The longest run of days in a row with usage (two or more), as inclusive indexes; a tie goes to
 * the later run. Null when no two days touch.
 */
export function bestRun(values: number[]): [number, number] | null {
  let best: [number, number] | null = null;
  let from = -1;
  values.forEach((v, i) => {
    if (v <= 0) {
      from = -1;
      return;
    }
    if (from < 0) from = i;
    if (!best || i - from >= best[1] - best[0]) best = [from, i];
  });
  const run = best as [number, number] | null;
  return run && run[1] - run[0] >= 1 ? run : null;
}

/**
 * The calendar of the last weeks. The best run over the whole history is ringed only when all of it is
 * on show: a ring on some other run would contradict the line that names the best run.
 */
export function heatGraphic(d: Pick<WrappedData, "to" | "dayTokens">): Extract<SlideGraphic, { kind: "heat" }> | undefined {
  const values = d.dayTokens.slice(-HEAT_DAYS);
  if (values.length < 2) return undefined;
  const offset = d.dayTokens.length - values.length;
  const all = bestRun(d.dayTokens);
  const run: [number, number] | null = all && all[0] >= offset ? [all[0] - offset, all[1] - offset] : null;
  return { kind: "heat", values, to: d.to, run };
}

/** Up to SPIKE_DAYS days around the busiest day, which is the peak. */
export function spikeGraphic(d: Pick<WrappedData, "from" | "dayTokens">, busyDay: string): Extract<SlideGraphic, { kind: "spike" }> | undefined {
  const at = daysBetween(d.from, busyDay);
  const n = d.dayTokens.length;
  if (at < 0 || at >= n) return undefined;
  const size = Math.min(SPIKE_DAYS, n);
  const lo = Math.max(0, Math.min(n - size, at - Math.floor(size / 2)));
  return {
    kind: "spike",
    values: d.dayTokens.slice(lo, lo + size),
    peak: at - lo,
    first: shortDay(addDays(d.from, lo)),
    last: shortDay(addDays(d.from, lo + size - 1)),
  };
}

// ---- the slides ----------------------------------------------------------------------------

/**
 * The name a slide shows for each skill or helper: a plugin's own prefix ("design:design-critique")
 * is dropped, because it only makes the name longer than the slide can print. Two names that would
 * then read the same keep their prefix, so they stay apart. A connector's tool
 * ("mcp__server__read_page") is shown by the tool's own name for the same reason.
 */
export function plainNames(ids: string[]): string[] {
  const own = (id: string) => (id.startsWith("mcp__") ? id.slice(id.lastIndexOf("__") + 2) : id.slice(id.lastIndexOf(":") + 1));
  const plain = ids.map((id) => own(id) || id);
  return ids.map((id, i) => (plain.filter((p) => p === plain[i]).length > 1 ? id : plain[i]));
}

function localDayOf(ms: number): string {
  const x = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/** A whole percent, never above 100 (a part cannot pass its whole). */
function percent(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, Math.round((part / whole) * 100)) : 0;
}

/** Under this ratio, "N times a usual chat" is not worth saying. */
const MIN_CHAT_RATIO = 1.5;

/** "47" for a big ratio, "3.4" for a small one. */
function timesText(ratio: number): string {
  const tenth = Math.round(ratio * 10) / 10;
  return tenth >= 10 ? exact(Math.round(ratio)) : tenth.toFixed(1);
}

/** A slide with a hero item (skill, helper or tool): its name and how often it was used. */
function itemSlide(id: string, kicker: string, verb: string, list: ItemUse[], show: (name: string) => string = (n) => n): Slide | null {
  if (list.length === 0) return null;
  const top = list[0];
  const times = plural(top.uses, "time");
  const name = plainNames(list.map((i) => i.id))[0];
  return {
    id,
    kicker,
    figure: show(name),
    // A shortened name keeps its exact one a hover away.
    ...(name !== top.id ? { hint: top.id } : {}),
    line: `${verb} ${times} in ${plural(top.sessions, "session")}.`,
    strong: times,
  };
}

/**
 * The slides, in order. Each exists only if its numbers do. Under SHORT_STORY_DAYS active days the
 * story is the short one: the opener, the total, the busiest day, one favorite, and the card. A slide
 * states each quantity once; the card at the end is the one place facts come round again.
 */
export function buildSlides(d: WrappedData): Slide[] {
  const out: Slide[] = [];
  const short = d.activeDays < SHORT_STORY_DAYS;
  const type = short ? null : coderType(d);

  out.push({
    id: "opener",
    kicker: "Atlas Wrapped",
    figure: d.to.slice(0, 4),
    title: "Your year in Claude Code",
    // No numbers on the opener: only how far back the story goes.
    line: rangeLabel(d),
  });

  if (d.tokens > 0) {
    // Under one novel there is nothing to say: rounding 0.75 up to "1" would overstate it.
    const novels = novelsOf(d.tokens);
    const rounded = novelsRounded(d.tokens);
    const strong = novels >= 1 ? `${exact(rounded)} ${rounded === 1 ? "novel's" : "novels'"}` : undefined;
    out.push({
      id: "tokens",
      kicker: "Tokens so far",
      figure: compact(d.tokens),
      line: strong ? `About ${strong} worth of words.` : "",
      strong,
      strongHint: strong ? novelsHint(d.tokens) : undefined,
      hint: `${exact(d.tokens)} tokens.`,
    });
  }

  if (!short && d.activeDays > 0) {
    const run = d.longestStreak > 1 ? `${plural(d.longestStreak, "day")} in a row.` : null;
    out.push({
      id: "days",
      kicker: "Days you showed up",
      figure: exact(d.activeDays),
      unit: `of ${exact(d.spanDays)}`,
      line: run ? `Best run: ${run}` : "Never two days in a row yet.",
      strong: run ?? undefined,
      graphic: heatGraphic(d),
    });
  }

  if (d.busiest && d.busiest.tokens > 0) {
    const tokens = `${compact(d.busiest.tokens)} tokens`;
    out.push({
      id: "busiest",
      kicker: "Your busiest day",
      figure: longDay(d.busiest.day),
      line: `${tokens} over ${plural(d.busiest.sessions, "session")}.`,
      strong: tokens,
      graphic: spikeGraphic(d, d.busiest.day),
    });
  }

  const week = weekdayAverages(d.from, d.dayTokens);
  const weekTotal = week.reduce((a, b) => a + b, 0);
  if (!short && weekTotal > 0) {
    const best = Math.max(...week);
    // Days that share the top mark share the headline; three or more tied is no favorite at all.
    const tied = weekdayTied(week);
    if (tied.length <= 2) {
      const pct = `${percent(best, weekTotal)}%`;
      out.push({
        id: "weekday",
        kicker: "Your busiest weekday",
        figure: tied.length === 1 ? WEEKDAYS[tied[0]] : `${WEEKDAYS_SHORT[tied[0]]} and ${WEEKDAYS_SHORT[tied[1]]}`,
        line: tied.length === 1 ? `${pct} of your week.` : `${pct} of your week each.`,
        strong: pct,
        graphic: { kind: "weekdays", values: week, peak: tied[0] },
      });
    }
  }

  const peak = peakHour(d.hours);
  if (!short && peak !== null) {
    out.push({
      id: "rhythm",
      kicker: "Your prime time",
      figure: hourLabel(peak),
      line: `Your busiest hour${hoursWindow(d, " over", "") || " so far"}.`,
      graphic: { kind: "hours", values: d.hours, days: Math.max(1, d.hoursDays), peak },
    });
  }

  if (!short && d.longest && d.longest.durationMs > 0) {
    out.push({
      id: "long",
      kicker: "Longest sitting",
      figure: formatDuration(d.longest.durationMs),
      line: `Started ${shortDay(localDayOf(d.longest.startedAt))}.`,
    });
  }

  // The longest and the biggest can be one chat: it is told once, on its longest slide.
  const sameChat = !!d.longest && !!d.biggest && d.longest.sessionId === d.biggest.sessionId;
  if (!short && d.biggest && !sameChat && headline(d.biggest.tokens) > 0) {
    const big = headline(d.biggest.tokens);
    // A usual chat is the average of the chats the count covers: that count's own tokens, never the
    // range total (which also holds chats that are gone from disk).
    const h = d.habits;
    const avg = h && h.chats > 1 && h.chatTokens > 0 ? h.chatTokens / h.chats : 0;
    const ratio = avg > 0 ? big / avg : 0;
    const times = ratio >= MIN_CHAT_RATIO ? `${timesText(ratio)} times` : null;
    out.push({
      id: "biggest",
      kicker: "Your biggest session",
      figure: compact(big),
      unit: "tokens",
      line: times ? `That is ${times} a usual session.` : "More than any other single session.",
      strong: times ?? undefined,
      hint: `${exact(big)} tokens in one session.`,
      graphic: times ? { kind: "circles", ratio } : undefined,
    });
  }

  if (!short && d.projects.length > 0) {
    const top = d.projects[0];
    const pct = `${percent(top.value, d.tokens > 0 ? d.tokens : d.projects.reduce((s, p) => s + p.value, 0))}%`;
    out.push({
      id: "project",
      kicker: "Your top project",
      figure: top.name ?? top.label,
      line: `${pct} of your tokens.`,
      strong: pct,
    });
  }

  const skill = itemSlide("skill", "Your top skill", "Used", d.skills);
  // A helper reads the way it does on Team, Sessions and Now: "General purpose", not its type id.
  const helper = itemSlide("helper", "Your go-to helper", "Called", d.agents, typeName);
  const tool = itemSlide("tool", "Your go-to tool", "Run", d.tools);
  if (short) {
    const first = skill ?? helper ?? tool;
    if (first) out.push(first);
  } else {
    for (const s of [skill, helper, tool]) if (s) out.push(s);
  }

  if (!short && d.models.length > 0) {
    const top = d.models[0];
    // Of all the tokens, not of the few models that are listed.
    const pct = `${percent(top.value, d.tokens > 0 ? d.tokens : d.models.reduce((s, m) => s + m.value, 0))}%`;
    out.push({
      id: "models",
      kicker: "Your main model",
      figure: top.label,
      line: `${pct} of your tokens.`,
      strong: pct,
    });
  }

  if (type) {
    out.push({
      id: "type",
      kicker: "Your coder type",
      figure: type.name,
      line: type.line,
    });
  }

  const card = buildCard(d, type);
  out.push({
    id: "card",
    kicker: "Your Wrapped, on one card",
    figure: card.tokens,
    unit: card.unit,
    line: "",
    card,
  });
  return out;
}

/** The start day, with its year only when the history began in an earlier year than `to`. */
function startDay(from: string, to?: string): string {
  return to && from.slice(0, 4) !== to.slice(0, 4)
    ? dayDate(from).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : shortDay(from);
}

/** "Jul 9 to today": the span the numbers cover ("Dec 9, 2025 to today" across a new year). */
export function rangeLabel(d: Pick<WrappedData, "from"> & { to?: string }): string {
  return `${startDay(d.from, d.to)} to today`;
}

/** "Jul 9 to Nov 9, 2026": the card's dated range ("Dec 9, 2025 to Jan 5, 2027" across a new year). */
export function rangeLong(d: Pick<WrappedData, "from" | "to">): string {
  return `${startDay(d.from, d.to)} to ${shortDay(d.to)}, ${dayDate(d.to).getFullYear()}`;
}
