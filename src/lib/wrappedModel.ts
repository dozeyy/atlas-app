// Wrapped: the story told from real numbers. Pure functions only; the queries live in
// wrappedLoad.ts. Nothing here invents data: a slide whose numbers are missing is not built.

import { compact, exact, formatDuration, headline, plural } from "./usage";
import type { ItemUse, SessionRow, TimelinePoint, WrappedHabits } from "./usageTypes";

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
  projects: { label: string; value: number }[];
  models: { label: string; value: number }[];
  /** The chat that ran longest by the clock. */
  longest: SessionRow | null;
  /** The chat that used the most tokens, and the first chat there is. */
  biggest: SessionRow | null;
  first: SessionRow | null;
  /** Chat shapes, helper work and the chat with the most helpers; null if the query failed. */
  habits: WrappedHabits | null;
  /** How many days Claude Code keeps its logs. */
  keepDays: number;
}

export type SlideTone = "accent" | "sand" | "slate" | "plain";

export type SlideChart =
  | { kind: "days"; values: number[] }
  | { kind: "hours"; values: number[] }
  | { kind: "weekdays"; values: number[] }
  | { kind: "bars"; rows: { label: string; value: number; note?: string }[] }
  | { kind: "countdown"; rows: { label: string; value: number; note?: string }[] }
  | { kind: "split"; rows: { label: string; value: number }[] };

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

/** Tokens per weekday (Monday first) from the per-day totals that start on `from`. */
export function weekdayTotals(from: string, dayTokens: number[]): number[] {
  const out = new Array<number>(7).fill(0);
  const start = dayDate(from).getDay(); // 0 = Sunday
  dayTokens.forEach((v, i) => {
    out[(start + i + 6) % 7] += v;
  });
  return out;
}

// ---- scale lines ---------------------------------------------------------------------------

/** Stated conversion for the "novels" line: an estimate, never a measurement. */
export const WORDS_PER_TOKEN = 0.75;
export const WORDS_PER_NOVEL = 100_000;

export function novelsOf(tokens: number): number {
  return (tokens * WORDS_PER_TOKEN) / WORDS_PER_NOVEL;
}

/** "About 360 novels of text", with the conversion in the hover; nothing under one novel. */
export function novelsAside(tokens: number): { text: string; hint: string } | null {
  const n = novelsOf(tokens);
  if (!(n >= 1)) return null;
  const rounded = n >= 10 ? Number(n.toPrecision(2)) : Math.round(n);
  return {
    text: `About ${compact(rounded)} ${rounded === 1 ? "novel" : "novels"} of text.`,
    hint:
      `${compact(tokens)} tokens x ${WORDS_PER_TOKEN} words per token / ${exact(WORDS_PER_NOVEL)} words per novel = about ${compact(rounded)}.\n` +
      "An estimate. The count includes cache writes, so it is text that went through Claude, not words you typed.",
  };
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
  if (d.projects.length > 0) tiles.push({ label: "Top project", value: d.projects[0].label });
  if (d.skills.length > 0) tiles.push({ label: "Top skill", value: d.skills[0].id });
  if (d.models.length > 0) tiles.push({ label: "Main model", value: d.models[0].label });
  if (type) tiles.push({ label: "Coder type", value: type.name });
  return {
    title: "My Claude Code, so far",
    tokens: compact(d.tokens),
    unit: "tokens",
    days: `${exact(d.activeDays)} active ${d.activeDays === 1 ? "day" : "days"} of ${exact(d.spanDays)}`,
    tiles,
    range: `${shortDay(d.from)} to ${shortDay(d.to)}`,
    day: d.to,
  };
}

// ---- the slides ----------------------------------------------------------------------------

/** The top rows of a list as bar rows. */
function itemRows(items: ItemUse[], n = 5): { label: string; value: number; note: string }[] {
  return items.slice(0, n).map((i) => ({ label: i.id, value: i.uses, note: plural(i.uses, "use") }));
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

const chatName = (r: SessionRow) => r.name ?? `A session in ${r.projectName}`;

function ago(days: number): string {
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return `${exact(days)} days ago`;
}

/**
 * The slides, in order. Each exists only if its numbers do. Under SHORT_STORY_DAYS active days the
 * story is the short one: the total, one favorite, the busiest day, and the card.
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
  const skillChart = (): SlideChart | undefined => (d.skills.length > 1 ? { kind: "countdown", rows: itemRows(d.skills) } : undefined);

  if (d.tokens > 0) {
    out.push({
      id: "tokens",
      tone: "accent",
      kicker: "The grand total",
      figure: compact(d.tokens),
      unit: "tokens",
      line: `That is ${plural(d.sessions, "session")} over ${plural(d.activeDays, "active day")}. You have been busy.`,
      hint: `${exact(d.tokens)} tokens in all: input, output and cache writes.`,
      aside: novelsAside(d.tokens) ?? undefined,
      chart: d.dayTokens.some((v) => v > 0) ? { kind: "days", values: d.dayTokens } : undefined,
      celebrate: pop(true),
    });
  }

  if (!short && d.first) {
    const day = localDayOf(d.first.startedAt);
    out.push({
      id: "first",
      tone: "sand",
      kicker: "Day one",
      figure: shortDay(day),
      line: `${ago(daysBetween(day, d.to))}: ${chatName(d.first)}, in ${d.first.projectName}. No going back.`,
    });
  }

  if (!short && d.activeDays > 0) {
    out.push({
      id: "days",
      tone: "plain",
      kicker: "You keep showing up",
      figure: exact(d.activeDays),
      unit: d.activeDays === 1 ? "active day" : "active days",
      line:
        d.longestStreak > 1
          ? `Your best run: ${plural(d.longestStreak, "day")} in a row${d.streak > 1 ? `. You are ${plural(d.streak, "day")} into the next one` : ""}.`
          : `Out of ${plural(d.spanDays, "day")}.`,
      celebrate: pop(d.longestStreak >= 3),
    });
  }

  if (!short && d.biggest && headline(d.biggest.tokens) > 0) {
    out.push({
      id: "biggest",
      tone: "accent",
      kicker: "Your biggest chat",
      figure: compact(headline(d.biggest.tokens)),
      unit: "tokens",
      line: `${chatName(d.biggest)}, in ${d.biggest.projectName}. One chat did all that.`,
      hint: `${exact(headline(d.biggest.tokens))} tokens in one chat. The Longest sitting slide goes by time; this one goes by tokens.`,
    });
  }

  if (!short && d.longest && d.longest.durationMs > 0) {
    out.push({
      id: "long",
      tone: "sand",
      kicker: "Longest sitting",
      figure: formatDuration(d.longest.durationMs),
      line: `${chatName(d.longest)}, ${shortDay(localDayOf(d.longest.startedAt))}. Did you ever close it?`,
    });
  }

  if (!short && d.projects.length > 0) {
    const top = d.projects[0];
    out.push({
      id: "project",
      tone: "plain",
      kicker: "Your biggest project",
      figure: top.label,
      line: `${share(d.projects, top.value)}% of the tokens you can see by project.${share(d.projects, top.value) >= 50 ? " Clear favorite." : ""}`,
      chart: d.projects.length > 1 ? { kind: "split", rows: d.projects } : undefined,
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
      return {
        id,
        tone: "slate",
        kicker,
        figure: top.id,
        line: `Used ${plural(top.uses, "time")} in ${plural(top.sessions, "session")}. You know what works.`,
        chart: id === "skill" ? skillChart() : list.length > 1 ? { kind: "bars", rows: itemRows(list) } : undefined,
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
        kicker: d.skills.length > 1 ? `Your top ${d.skills.length} skills, counted down` : "Favorite skill",
        figure: top.id,
        line: `Number one: used ${plural(top.uses, "time")} in ${plural(top.sessions, "session")}.`,
        chart: skillChart(),
      });
    }
    if (d.agents.length > 0) {
      out.push({ id: "helper", tone: "plain", kicker: "Your go-to helper", figure: d.agents[0].id, line: `Called on ${plural(d.agents[0].uses, "time")} in ${plural(d.agents[0].sessions, "session")}. Reliable.`, chart: d.agents.length > 1 ? { kind: "bars", rows: itemRows(d.agents) } : undefined });
    }
    const crowd = d.habits?.mostHelpers;
    if (crowd && crowd.agentCount >= 2) {
      out.push({
        id: "crowd",
        tone: "sand",
        kicker: "Most helpers in one chat",
        figure: exact(crowd.agentCount),
        unit: "helpers",
        line: `${chatName(crowd)}, in ${crowd.projectName}. A whole crew.`,
      });
    }
    if (d.tools.length > 0) {
      out.push({ id: "tool", tone: "slate", kicker: "Go-to tool", figure: d.tools[0].id, line: `Run ${plural(d.tools[0].uses, "time")} in ${plural(d.tools[0].sessions, "session")}. Old faithful.`, chart: d.tools.length > 1 ? { kind: "bars", rows: itemRows(d.tools) } : undefined });
    }
  }

  if (d.busiest && d.busiest.tokens > 0) {
    out.push({
      id: "busiest",
      tone: "accent",
      kicker: "Your busiest day",
      figure: longDay(d.busiest.day),
      line: `${compact(d.busiest.tokens)} tokens over ${plural(d.busiest.sessions, "session")}. Nobody could stop you.`,
      celebrate: pop(!short),
    });
  }

  const week = weekdayTotals(d.from, d.dayTokens);
  const weekTotal = week.reduce((a, b) => a + b, 0);
  if (!short && weekTotal > 0) {
    const top = week.indexOf(Math.max(...week));
    out.push({
      id: "weekday",
      tone: "plain",
      kicker: "Your busiest weekday",
      figure: WEEKDAYS[top],
      line: `${share(week.map((v) => ({ value: v })), week[top])}% of your tokens land on a ${WEEKDAYS[top]}. Plan around it.`,
      hint: `${compact(week[top])} tokens on ${WEEKDAYS[top]}s since ${shortDay(d.from)}.`,
      chart: { kind: "weekdays", values: week },
    });
  }

  const peak = peakHour(d.hours);
  if (!short && peak !== null) {
    out.push({
      id: "rhythm",
      tone: "slate",
      kicker: "Your prime time",
      figure: hourLabel(peak),
      line: `Most of your tokens land around then, ${partOfDay(peak)}. That is your hour.`,
      chart: { kind: "hours", values: d.hours },
    });
  }

  // Tokens, not dollars (Will, 2026-11-08): the model slide says which model carried the tokens.
  if (!short && d.models.length > 0) {
    const top = d.models[0];
    out.push({
      id: "models",
      tone: "sand",
      kicker: "Your main model",
      figure: top.label,
      line: `${share(d.models, top.value)}% of your tokens. Your ride or die.`,
      chart: d.models.length > 1 ? { kind: "split", rows: d.models } : undefined,
    });
  }

  const type = short ? null : coderType(d);
  if (type) {
    const top = type.traits.slice(0, 3);
    out.push({
      id: "type",
      tone: "accent",
      kicker: "Your coder type",
      figure: type.name,
      line: type.line,
      hint: type.why,
      chart: type.id !== "steady" && top.length > 1 ? { kind: "bars", rows: top.map((t) => ({ label: t.name, value: t.score, note: t.note })) } : undefined,
      celebrate: pop(true),
    });
  }

  const card = buildCard(d, type);
  out.push({
    id: "card",
    tone: "plain",
    kicker: "Your Wrapped, on one card",
    figure: card.tokens,
    unit: card.unit,
    line: coverageLine(d),
    card,
  });
  return out;
}

/** The honest sentence about how far back the numbers go. */
export function coverageLine(d: Pick<WrappedData, "from" | "keepDays">): string {
  return `From ${shortDay(d.from)} to today. Claude Code clears its logs after ${d.keepDays} days, so anything older is not here.`;
}
