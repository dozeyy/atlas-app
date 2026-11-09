// Wrapped: the story told from real numbers. Pure functions only; the queries live in
// wrappedLoad.ts. Nothing here invents data: a slide whose numbers are missing is not built.

import { addDays, compact, exact, formatDuration, headline, plural } from "./usage";
import { compare as compareRung, compareTokens as compareTokensRung, WORDS_PER_TOKEN } from "./wrappedCompare";
import type { CompareWords, Comparison, LadderId } from "./wrappedCompare";
import type { ItemUse, SessionRow, TimelinePoint, WrappedHabits } from "./usageTypes";

export { WORDS_PER_TOKEN };

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
  /** The chat that used the most tokens, and the first chat there is. */
  biggest: SessionRow | null;
  first: SessionRow | null;
  /** Chat shapes, helper work and the chat with the most helpers; null if the query failed. */
  habits: WrappedHabits | null;
  /** How many days Claude Code keeps its logs (`cleanupPeriodDays`); null when the setting is not set. */
  keepDays: number | null;
}

export type SlideTone = "accent" | "sand" | "slate" | "plain";

/** Where the hero graphic sits against the words. */
export type SlideLayout = "over" | "split" | "splitR" | "center" | "stack";

export interface Row {
  label: string;
  value: number;
  note?: string;
  /** The bare name when label carries a hint to tell two of the same name apart. */
  name?: string;
  /** What sets this row apart from another of the same name (a folder's parent). */
  hint?: string;
}

/**
 * One hero graphic per kind, and no two slides share a kind. The model hands each its real data;
 * src/components/wrapped/Hero.tsx draws it.
 */
export type SlideChart =
  /** Every day of the history as a ridge; the busiest day is the summit. */
  | { kind: "ridge"; values: number[] }
  /** A shelf of novels. */
  | { kind: "spines"; count: number }
  /** A trail from the oldest chat to today. */
  | { kind: "trail"; from: string; to: string; days: number }
  /** The calendar of the last weeks; `run` is the best streak (inclusive day indexes) to ring. */
  | { kind: "heat"; values: number[]; start: number; run: [number, number] | null; weeks: number }
  /** One tower against the average chat. */
  | { kind: "tower"; value: number; avg: number }
  /** A dial: hours of one sitting, a lap per twelve. */
  | { kind: "dial"; hours: number }
  /** Projects as tiles sized by tokens. */
  | { kind: "tiles"; rows: Row[] }
  /** The top skills on a podium. */
  | { kind: "podium"; rows: Row[] }
  /** Helpers as lollipops. */
  | { kind: "lollipop"; rows: Row[] }
  /** A chat with its helpers around it. */
  | { kind: "burst"; count: number }
  /** Tools as a terminal: one command bar per tool, sized by its count. */
  | { kind: "terminal"; rows: Row[] }
  /** The days around the busiest one; `peak` is its index. */
  | { kind: "spike"; values: number[]; peak: number; first: string; last: string }
  /** Seven spokes, Monday first. */
  | { kind: "spokes"; values: number[] }
  /** The 24 hours of the day as a strip. */
  | { kind: "strip"; values: number[] }
  /** Models as a ring. */
  | { kind: "donut"; rows: Row[]; whole?: number }
  /** The cover: a collage of shapes, no data. */
  | { kind: "cover" }
  /** The coder type: an emblem and its gauge (`score` = value / bar, 1 is the bar). */
  | { kind: "badge"; id: string; name: string; score: number; traits: { name: string; score: number; note: string }[] };

/** What the share card says. Only numbers, project, skill and model names: never a chat name. */
export interface ShareCard {
  title: string;
  /** The one big figure ("48M") and its unit. */
  tokens: string;
  unit: string;
  /** "22 active days of 31". */
  days: string;
  tiles: { label: string; value: string }[];
  /** "Oct 9 to Nov 8". */
  range: string;
  /** Today, local YYYY-MM-DD: the saved file's name. */
  day: string;
  /** The history as a small ridge along the card: 0..1 heights, left to right. */
  ridge: number[];
}

export interface Slide {
  id: string;
  tone: SlideTone;
  kicker: string;
  figure: string;
  unit?: string;
  line: string;
  /** Where the big figure comes from, shown on hover (title). */
  hint?: string;
  /** A quieter line under the sentence, with its own hover. */
  aside?: { text: string; hint: string };
  chart?: SlideChart;
  /** How the words and the graphic are laid out. */
  layout: SlideLayout;
  /** The fun comparison under the big number, and where its numbers come from (the hover). */
  compare?: Comparison;
  /** One of the (at most three) moments that get a small pop. */
  celebrate?: boolean;
  /** The last slide: the whole story on one card. */
  card?: ShareCard;
}

/** Fewer active days than this tells a shorter story. */
export const SHORT_STORY_DAYS = 7;
export const MAX_CELEBRATIONS = 3;

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

export function hourLabel(h: number): string {
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

function partOfDay(h: number): string {
  if (h >= 5 && h < 12) return "in the morning";
  if (h >= 12 && h < 17) return "in the afternoon";
  if (h >= 17 && h < 21) return "in the evening";
  return "late at night";
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

// ---- scale lines ---------------------------------------------------------------------------

/** Stated conversion for the novels slide: an estimate, never a measurement. */
export const WORDS_PER_NOVEL = 100_000;

export function novelsOf(tokens: number): number {
  return (tokens * WORDS_PER_TOKEN) / WORDS_PER_NOVEL;
}

/** Silent reading speed for adults, words a minute (Brysbaert, 2019: 238 for non-fiction). */
export const READ_WORDS_PER_MIN = 238;

/** The hours it takes to read this many tokens as words, at the stated speed. */
export function readingHours(tokens: number): number {
  return (tokens * WORDS_PER_TOKEN) / READ_WORDS_PER_MIN / 60;
}

/** The conversion behind the novel count, for the figure's hover. */
export function novelsHint(tokens: number): string {
  return (
    `${compact(tokens)} tokens x ${WORDS_PER_TOKEN} words per token / ${exact(WORDS_PER_NOVEL)} words per novel = about ${compact(novelsOf(tokens))}.\n` +
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
  /** Every habit that had numbers, strongest first: the winner and its runners-up. */
  traits: { name: string; score: number; note: string }[];
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
  /** A few words for the runner-up list. */
  note: (d: WrappedData, v: number) => string;
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
    note: (_d, v) => `${pct(v)} at night`,
  },
  {
    id: "bird",
    name: "Early Bird",
    line: "You get going before most people are up.",
    bar: 0.3,
    value: (d) => hourShare(d, EARLY_HOURS),
    why: (d, v) => `${pct(v)} of your tokens came between 5 am and 9 am${recently(d)}. Early Bird starts at 30%.`,
    note: (_d, v) => `${pct(v)} before 9 am`,
  },
  {
    id: "delegator",
    name: "Delegator",
    line: "You hand a lot of the work to helpers.",
    bar: 0.35,
    value: (d) => (d.habits && d.habits.allTokens > 0 ? d.habits.helperTokens / d.habits.allTokens : null),
    why: (_d, v) => `Helpers spent ${pct(v)} of your tokens. Delegator starts at 35%.`,
    note: (_d, v) => `${pct(v)} by helpers`,
  },
  {
    id: "marathoner",
    name: "Marathoner",
    line: "You stay in one chat for hours.",
    bar: 0.2,
    value: (d) => chatShare(d, (h) => h.longChats),
    why: (d, v) => `${exact(d.habits?.longChats ?? 0)} of ${exact(d.habits?.chats ?? 0)} chats (${pct(v)}) ran two hours or more. Marathoner starts at 20%.`,
    note: (_d, v) => `${pct(v)} ran 2 h+`,
  },
  {
    id: "sprinter",
    name: "Sprinter",
    line: "You get in, get it done, get out.",
    bar: 0.5,
    value: (d) => chatShare(d, (h) => h.shortChats),
    why: (d, v) => `${exact(d.habits?.shortChats ?? 0)} of ${exact(d.habits?.chats ?? 0)} chats (${pct(v)}) were over in under ten minutes. Sprinter starts at 50%.`,
    note: (_d, v) => `${pct(v)} under 10 min`,
  },
  {
    id: "toolsmith",
    name: "Toolsmith",
    line: "You reach for a skill in nearly every chat.",
    bar: 1,
    value: (d) => (d.habits && d.habits.chats >= MIN_CHATS_FOR_TYPE ? d.skillUses / d.habits.chats : null),
    why: (d) => `${exact(d.skillUses)} skill uses across ${exact(d.habits?.chats ?? 0)} chats. Toolsmith starts at one skill use per chat.`,
    note: (_d, v) => `${v.toFixed(1)} skills a chat`,
  },
  {
    id: "loyalist",
    name: "Loyalist",
    line: "One project gets most of you.",
    bar: 0.7,
    value: (d) => (d.projects.length > 0 && d.tokens > 0 ? d.projects[0].value / d.tokens : null),
    why: (d, v) => `${pct(v)} of your tokens went to ${d.projects[0]?.label ?? "one project"}. Loyalist starts at 70%.`,
    note: (_d, v) => `${pct(v)} in one project`,
  },
  {
    id: "regular",
    name: "Regular",
    line: "You show up nearly every day.",
    bar: 0.8,
    value: (d) => (d.spanDays >= 14 ? d.activeDays / d.spanDays : null),
    why: (d, v) => `You used Claude Code on ${exact(d.activeDays)} of ${exact(d.spanDays)} days (${pct(v)}). Regular starts at 80%.`,
    note: (d) => `${exact(d.activeDays)} of ${exact(d.spanDays)} days`,
  },
];

export const STEADY: Omit<CoderType, "traits"> = {
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
  const traits = scored.filter((s) => s.score > 0).map((s) => ({ name: s.r.name, score: s.score, note: s.r.note(d, s.v) }));
  const top = scored[0];
  if (top.score >= 1) return { id: top.r.id, name: top.r.name, line: top.r.line, why: top.r.why(d, top.v), traits };
  // "No habit stands out" needs at least two habits to compare; one number is not a comparison.
  if (scored.length < 2) return null;
  return { ...STEADY, traits };
}

// ---- the share card ------------------------------------------------------------------------

/**
 * What goes on the card: totals, a project, a skill, a model and the type. Built from numbers and
 * from project, skill and model names only. Chat names can come from the first prompt, so none
 * is ever read here.
 */
export function buildCard(d: WrappedData, type: CoderType | null): ShareCard {
  const tiles: { label: string; value: string }[] = [];
  // One short word each: the card is shown small, so the labels are drawn big and have to fit a third.
  if (d.projects.length > 0) tiles.push({ label: "Project", value: d.projects[0].name ?? d.projects[0].label });
  if (d.skills.length > 0) tiles.push({ label: "Skill", value: plainNames(d.skills.map((i) => i.id))[0] });
  if (d.models.length > 0) tiles.push({ label: "Model", value: d.models[0].label });
  if (type) tiles.push({ label: "Type", value: type.name });
  return {
    title: "My Claude Code, so far",
    tokens: compact(d.tokens),
    unit: "tokens",
    days: `${exact(d.activeDays)} active ${d.activeDays === 1 ? "day" : "days"} of ${exact(d.spanDays)}`,
    tiles,
    range: `${shortDay(d.from)} to ${shortDay(d.to)}`,
    day: d.to,
    ridge: cardRidge(d.dayTokens),
  };
}


// ---- the hero graphics' data -----------------------------------------------------------------

/** The calendar graphic shows at most this many days (26 weeks) so the cells stay big enough to read. */
export const HEAT_DAYS = 182;
/** The days around the busiest one that the spike graphic shows. */
export const SPIKE_DAYS = 21;

/** The last weeks as a calendar, with the longest run of days in a row (two or more) to be ringed. */
export function heatChart(d: Pick<WrappedData, "to" | "dayTokens">): Extract<SlideChart, { kind: "heat" }> | undefined {
  const values = d.dayTokens.slice(-HEAT_DAYS);
  if (values.length < 2) return undefined;
  const start = weekdayOf(addDays(d.to, -(values.length - 1)));
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
  const run = best && (best as [number, number])[1] - (best as [number, number])[0] >= 1 ? (best as [number, number]) : null;
  return { kind: "heat", values, start, run, weeks: Math.ceil((start + values.length) / 7) };
}

/** Up to SPIKE_DAYS days around the busiest day, which is the peak. */
export function spikeChart(d: Pick<WrappedData, "from" | "to" | "dayTokens">, busyDay: string): Extract<SlideChart, { kind: "spike" }> | undefined {
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

/** The top rows of a list as ranked rows. */
/**
 * The name a poster shows for each skill or helper: a plugin's own prefix ("design:design-critique")
 * is dropped, because it only makes the name longer than the graphic can print. Two names that would
 * then read the same keep their prefix, so they stay apart.
 */
export function plainNames(ids: string[]): string[] {
  const plain = ids.map((id) => id.slice(id.lastIndexOf(":") + 1) || id);
  return ids.map((id, i) => (plain.filter((p) => p === plain[i]).length > 1 ? id : plain[i]));
}

function itemRows(items: ItemUse[], n = 5): Row[] {
  const names = plainNames(items.map((i) => i.id));
  return items.slice(0, n).map((i, k) => ({ label: names[k], value: i.uses, note: plural(i.uses, "use") }));
}

function share(rows: { value: number }[], n: number): number {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

function localDayOf(ms: number): string {
  const x = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

// A poster names a chat by its project, never by the chat's own name: that can be the first prompt
// cut off mid-sentence, and no transcript text goes on a poster (or into a shared image).

function ago(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${exact(days)} days ago`;
}

const MS_PER_HOUR = 3_600_000;

/**
 * The comparisons of one Wrapped. A thing is compared once (its rung leaves every ladder, Apollo 11
 * included, once it has been said) and a number is compared once: `stat` names what the amount is,
 * and a stat that already has its line gets no second one, whatever the thing.
 */
function comparer(used: Set<string>) {
  const once = (stat: string, run: () => Comparison | null): Comparison | undefined => {
    const key = `stat:${stat}`;
    if (used.has(key)) return undefined;
    const c = run();
    if (c) used.add(key);
    return c ?? undefined;
  };
  return {
    compare: (stat: string, l: LadderId, n: number, w: CompareWords) => once(stat, () => compareRung(l, n, w, used)),
    tokens: (stat: string, n: number, w: CompareWords) => once(stat, () => compareTokensRung(n, w, used)),
  };
}

/**
 * The type slide's comparison: the real amount the winning habit counted, against its own ladder.
 * Every lead names its subject (the slide itself only says the type); a type whose number was already
 * compared on an earlier slide, or that has no number of its own, gets no line.
 */
function typeCompare(d: WrappedData, id: string, cmp: ReturnType<typeof comparer>): Comparison | undefined {
  const h = d.habits;
  const at = (hours: number[]) => hours.reduce((s, x) => s + (d.hours[x] ?? 0), 0);
  // The hour data can cover fewer days than the whole history: the hover says how many.
  const windowed = (c: Comparison | undefined): Comparison | undefined => (c ? { ...c, hint: `${c.hint}${hoursWindow(d, " Hour totals cover", ".")}` } : undefined);
  switch (id) {
    case "owl":
      return windowed(cmp.tokens("nightTokens", at(NIGHT_HOURS), { lead: "Nights add up to about" }));
    case "bird":
      return windowed(cmp.tokens("morningTokens", at(EARLY_HOURS), { lead: "Mornings add up to about" }));
    case "delegator":
      return h ? cmp.tokens("helperTokens", h.helperTokens, { lead: "Helpers add up to about" }) : undefined;
    case "marathoner":
      // Each long chat ran two hours or more, so this is a floor.
      return h ? cmp.compare("longChats", "hours", h.longChats * LONG_CHAT_HOURS, { lead: "Long chats run at least", atLeast: true }) : undefined;
    case "sprinter":
      return h ? cmp.compare("shortChats", "count", h.shortChats, { lead: "Quick chats number about" }) : undefined;
    case "toolsmith":
      return cmp.compare("skillUses", "count", d.skillUses, { lead: "Skill uses number about" });
    case "loyalist":
      // The same number as the project slide's, so it has a line here only if that slide had none.
      return d.projects[0] ? cmp.tokens("topProject", d.projects[0].value, { lead: "Your top project is about" }) : undefined;
    default:
      // Regular and All-Rounder are counts of days and habits already shown: no number of their own.
      return undefined;
  }
}

const LONG_CHAT_HOURS = 2;

/**
 * The slides, in order. Each exists only if its numbers do. Under SHORT_STORY_DAYS active days the
 * story is the short one: the total, one favorite, the busiest day, and the card. Every slide has
 * its own kind of hero graphic and, where the number reaches a rung, one comparison line.
 */
export function buildSlides(d: WrappedData): Slide[] {
  const out: Slide[] = [];
  let celebrations = 0;
  const pop = (ok: boolean) => {
    if (!ok || celebrations >= MAX_CELEBRATIONS) return false;
    celebrations++;
    return true;
  };
  const short = d.activeDays < SHORT_STORY_DAYS;
  // Each thing, and each number, is compared once in the whole story.
  const cmp = comparer(new Set<string>());
  const skillChart = (): SlideChart | undefined => (d.skills.length > 1 ? { kind: "podium", rows: itemRows(d.skills) } : undefined);
  const uses = (stat: string, n: number, lead: string) => cmp.compare(stat, "count", n, { lead });

  if (d.tokens > 0) {
    out.push({
      id: "tokens",
      tone: "accent",
      layout: "over",
      kicker: "The grand total",
      figure: compact(d.tokens),
      unit: "tokens",
      line: `That is ${plural(d.sessions, "session")} over ${plural(d.activeDays, "active day")}. You have been busy.`,
      hint: `${exact(d.tokens)} tokens in all: input, output and cache writes.`,
      compare: cmp.tokens("tokens", d.tokens, { lead: "About" }),
      chart: d.dayTokens.some((v) => v > 0) ? { kind: "ridge", values: d.dayTokens } : undefined,
      celebrate: pop(true),
    });
  }

  const novels = novelsOf(d.tokens);
  if (!short && novels >= 1) {
    const rounded = novels >= 10 ? Number(novels.toPrecision(2)) : Math.round(novels);
    out.push({
      id: "novels",
      tone: "sand",
      layout: "splitR",
      kicker: "In book terms",
      figure: compact(rounded),
      unit: rounded === 1 ? "novel" : "novels",
      line: "That is quite a shelf.",
      hint: novelsHint(d.tokens),
      compare: cmp.compare("reading", "hours", readingHours(d.tokens), { lead: "Reading takes about" }),
      chart: { kind: "spines", count: rounded },
    });
  }

  if (!short && d.first) {
    const day = localDayOf(d.first.startedAt);
    const since = daysBetween(day, d.to);
    out.push({
      id: "first",
      tone: "slate",
      layout: "center",
      kicker: "Oldest chat still here",
      figure: shortDay(day),
      line: `${ago(since)}: a session in ${d.first.projectName}. Still standing.`,
      compare: cmp.compare("since", "days", since, { lead: "Since then, about" }),
      chart: since > 0 ? { kind: "trail", from: day, to: d.to, days: since } : undefined,
    });
  }

  if (!short && d.activeDays > 0) {
    out.push({
      id: "days",
      tone: "plain",
      layout: "stack",
      kicker: "You keep showing up",
      figure: exact(d.activeDays),
      unit: d.activeDays === 1 ? "active day" : "active days",
      line:
        d.longestStreak > 1
          ? `Your best run: ${plural(d.longestStreak, "day")} in a row${d.streak > 1 ? `. You are ${plural(d.streak, "day")} into the next one` : ""}.`
          : `Out of ${plural(d.spanDays, "day")}.`,
      compare: cmp.compare("activeDays", "days", d.activeDays, { lead: "That is about" }),
      chart: heatChart(d),
      celebrate: pop(d.longestStreak >= 3),
    });
  }

  if (!short && d.biggest && headline(d.biggest.tokens) > 0) {
    const big = headline(d.biggest.tokens);
    // The average covers the same chats the count does: the numerator is those chats' own tokens,
    // never the range total (which also holds chats that are gone from disk).
    const h = d.habits;
    const avg = h && h.chats > 1 && h.chatTokens > 0 ? h.chatTokens / h.chats : 0;
    out.push({
      id: "biggest",
      tone: "accent",
      layout: "splitR",
      kicker: "Your biggest chat",
      figure: compact(big),
      unit: "tokens",
      line: `One chat in ${d.biggest.projectName} did all that.`,
      hint: `${exact(big)} tokens in one chat. The Longest sitting slide goes by time; this one goes by tokens.`,
      compare: cmp.tokens("biggestChat", big, { lead: "That one chat is about" }),
      chart: avg > 0 ? { kind: "tower", value: big, avg } : undefined,
    });
  }

  if (!short && d.longest && d.longest.durationMs > 0) {
    out.push({
      id: "long",
      tone: "sand",
      layout: "split",
      kicker: "Longest sitting",
      figure: formatDuration(d.longest.durationMs),
      line: `A sitting in ${d.longest.projectName}, ${shortDay(localDayOf(d.longest.startedAt))}. Did you ever close it?`,
      compare: cmp.compare("longestSitting", "hours", d.longest.durationMs / MS_PER_HOUR, { lead: "That sitting is about" }),
      chart: { kind: "dial", hours: d.longest.durationMs / MS_PER_HOUR },
    });
  }

  if (!short && d.projects.length > 0) {
    const top = d.projects[0];
    out.push({
      id: "project",
      tone: "plain",
      layout: "stack",
      kicker: "Your biggest project",
      figure: top.name ?? top.label,
      line: `${share(d.projects, top.value)}% of the tokens you can see by project.${share(d.projects, top.value) >= 50 ? " Clear favorite." : ""}`,
      compare: cmp.tokens("topProject", top.value, { lead: "That project is about" }),
      chart: d.projects.length > 1 ? { kind: "tiles", rows: d.projects } : undefined,
    });
  }

  const favorite = (): Slide | null => {
    const kinds: [ItemUse[], string, string][] = [
      [d.skills, "Favorite skill", "skill"],
      [d.agents, "Favorite helper", "helper"],
      [d.tools, "Go-to tool", "tool"],
    ];
    for (const [list, kicker, id] of kinds) {
      if (list.length === 0) continue;
      const top = list[0];
      // A lone tool still gets its graphic (its runs, drawn as dots); a lone skill or helper has no set to draw.
      const chart: SlideChart | undefined =
        id === "skill" ? skillChart() : id === "tool" ? { kind: "terminal", rows: itemRows(list) } : list.length > 1 ? { kind: "lollipop", rows: itemRows(list) } : undefined;
      return {
        id,
        tone: "slate",
        layout: id === "skill" ? "center" : id === "helper" ? "split" : "stack",
        kicker,
        figure: plainNames(list.map((i) => i.id))[0],
        line: `Used ${plural(top.uses, "time")} in ${plural(top.sessions, "session")}. You know what works.`,
        compare: uses(`${id}Uses`, top.uses, "That is about"),
        chart,
      };
    }
    return null;
  };

  if (short) {
    const f = favorite();
    if (f) out.push(f);
  } else {
    if (d.skills.length > 0) {
      const top = d.skills[0];
      out.push({
        id: "skill",
        tone: "slate",
        layout: "center",
        kicker: d.skills.length > 1 ? `Your top ${d.skills.length} skills, counted down` : "Favorite skill",
        figure: plainNames(d.skills.map((i) => i.id))[0],
        line: `Number one: used ${plural(top.uses, "time")} in ${plural(top.sessions, "session")}.`,
        compare: uses("skillUses", top.uses, "That is about"),
        chart: skillChart(),
      });
    }
    if (d.agents.length > 0) {
      const top = d.agents[0];
      out.push({
        id: "helper",
        tone: "plain",
        layout: "split",
        kicker: "Your go-to helper",
        figure: plainNames(d.agents.map((i) => i.id))[0],
        line: `Called on ${plural(top.uses, "time")} in ${plural(top.sessions, "session")}. Reliable.`,
        compare: uses("helperUses", top.uses, "That is about"),
        chart: d.agents.length > 1 ? { kind: "lollipop", rows: itemRows(d.agents) } : undefined,
      });
    }
    const crowd = d.habits?.mostHelpers;
    if (crowd && crowd.agentCount >= 2) {
      out.push({
        id: "crowd",
        tone: "sand",
        layout: "splitR",
        kicker: "Most helpers in one chat",
        figure: exact(crowd.agentCount),
        unit: "helpers",
        line: `One chat in ${crowd.projectName}. A whole crew.`,
        compare: cmp.compare("crowd", "crew", crowd.agentCount, { lead: "Enough helpers to fill", atLeast: true }),
        chart: { kind: "burst", count: crowd.agentCount },
      });
    }
    if (d.tools.length > 0) {
      const top = d.tools[0];
      out.push({
        id: "tool",
        tone: "slate",
        layout: "stack",
        kicker: "Go-to tool",
        figure: top.id,
        line: `Run ${plural(top.uses, "time")} in ${plural(top.sessions, "session")}. Old faithful.`,
        compare: uses("toolUses", top.uses, "That is about"),
        // One tool has nothing to be set against, so the graphic draws its runs; it is never left bare.
        chart: { kind: "terminal", rows: itemRows(d.tools) },
      });
    }
  }

  if (d.busiest && d.busiest.tokens > 0) {
    out.push({
      id: "busiest",
      tone: "accent",
      layout: "over",
      kicker: "Your busiest day",
      figure: longDay(d.busiest.day),
      line: `${compact(d.busiest.tokens)} tokens over ${plural(d.busiest.sessions, "session")}. Nobody could stop you.`,
      compare: cmp.tokens("busiestDay", d.busiest.tokens, { lead: "That one day is about" }),
      chart: spikeChart(d, d.busiest.day),
      celebrate: pop(!short),
    });
  }

  const week = weekdayAverages(d.from, d.dayTokens);
  const weekTotal = week.reduce((a, b) => a + b, 0);
  if (!short && weekTotal > 0) {
    const best = Math.max(...week);
    const top = week.indexOf(best);
    // Days that share the top mark share the headline: a tie never says "beats every other day".
    const tied = WEEKDAYS.filter((_, i) => week[i] === best);
    const topLine =
      tied.length === 1
        ? `${WEEKDAYS[top]} beats every other day. Plan around it.`
        : tied.length === 2
          ? `${tied[0]} and ${tied[1]} tie for the top. Plan around both.`
          : `${tied.length} days tie for the top: ${tied.join(", ")}.`;
    out.push({
      id: "weekday",
      tone: "plain",
      layout: "splitR",
      kicker: "Your busiest weekday",
      figure: `${share(week.map((v) => ({ value: v })), week[top])}%`,
      unit: "of your week",
      line: topLine,
      hint: `${compact(week[top])} tokens on an average ${WEEKDAYS[top]} since ${shortDay(d.from)}, counting every ${WEEKDAYS[top]} in that time.`,
      compare: cmp.tokens("weekday", week[top], { lead: `A ${WEEKDAYS[top]} is about` }),
      chart: { kind: "spokes", values: week },
    });
  }

  const peak = peakHour(d.hours);
  if (!short && peak !== null) {
    out.push({
      id: "rhythm",
      tone: "slate",
      layout: "stack",
      kicker: "Your prime time",
      figure: hourLabel(peak),
      line: `Your busiest hour${hoursWindow(d, " over", "")}. Prime time, ${partOfDay(peak)}.`,
      hint: hoursWindow(d, "Hour totals cover", ".") || undefined,
      compare: cmp.tokens("peakHour", d.hours[peak], { lead: `${hourLabel(peak)} adds up to about` }),
      chart: { kind: "strip", values: d.hours },
    });
  }

  // Tokens, not dollars (Will, 2026-11-08): the model slide says which model carried the tokens.
  if (!short && d.models.length > 0) {
    const top = d.models[0];
    out.push({
      id: "models",
      tone: "sand",
      layout: "split",
      kicker: "Your main model",
      figure: top.label,
      // Of all the tokens, not of the top few models the donut draws.
      line: `${d.tokens > 0 ? Math.round((top.value / d.tokens) * 100) : share(d.models, top.value)}% of your tokens. Your ride or die.`,
      compare: cmp.tokens("topModel", top.value, { lead: "That model carried about" }),
      chart: d.models.length > 1 ? { kind: "donut", rows: d.models, whole: d.tokens > 0 ? d.tokens : undefined } : undefined,
    });
  }

  const type = short ? null : coderType(d);
  if (type) {
    out.push({
      id: "type",
      tone: "accent",
      layout: "center",
      kicker: "Your coder type",
      figure: type.name,
      line: type.line,
      hint: type.why,
      compare: typeCompare(d, type.id, cmp),
      chart: { kind: "badge", id: type.id, name: type.name, score: type.traits[0]?.score ?? 1, traits: type.traits.slice(0, 3) },
      celebrate: pop(true),
    });
  }

  const card = buildCard(d, type);
  out.push({
    id: "card",
    tone: "plain",
    layout: "stack",
    kicker: "Your Wrapped, on one card",
    figure: card.tokens,
    unit: card.unit,
    // No line: the picture carries its own dated range, and the saved status sits by the button.
    line: "",
    hint: rangeHint(d),
    card,
  });
  return out;
}

/** "Jul 9 to today": the span the numbers cover. */
export function rangeLabel(d: Pick<WrappedData, "from">): string {
  return `${shortDay(d.from)} to today`;
}

/**
 * The hover on the range: where the numbers start. The log-retention setting is named only when it
 * is set and the history is not longer than it; otherwise it would say something the data disproves.
 */
export function rangeHint(d: Pick<WrappedData, "from" | "keepDays" | "spanDays">): string {
  const first = `${shortDay(d.from)} is your first day with usage.`;
  return d.keepDays !== null && d.spanDays <= d.keepDays ? `${first} Claude Code keeps its logs for ${plural(d.keepDays, "day")}.` : first;
}

/** The first poster: the one number, then how far back it honestly goes. */
export function coverSlide(d: WrappedData): Slide {
  return {
    id: "cover",
    tone: "accent",
    layout: "center",
    kicker: "Your Claude Code so far",
    figure: compact(d.tokens),
    unit: "tokens so far",
    line: `${plural(d.sessions, "session")}. ${plural(d.activeDays, "active day")}.${d.streak > 1 ? ` ${plural(d.streak, "day")} in a row right now.` : ""} Ready?`,
    hint: rangeHint(d),
    compare: { text: rangeLabel(d), hint: rangeHint(d) },
    chart: { kind: "cover" },
  };
}