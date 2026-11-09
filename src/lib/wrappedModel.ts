// Wrapped: the story told from real numbers. Pure functions only; the queries live in
// useWrapped.ts. Nothing here invents data: a slide whose numbers are missing is not built.

import { compact, exact, formatDuration, headline, plural } from "./usage";
import type { ItemUse, SessionRow, TimelinePoint } from "./usageTypes";

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
  /** Tokens per day from `from` to `to`. */
  dayTokens: number[];
  skills: ItemUse[];
  agents: ItemUse[];
  tools: ItemUse[];
  projects: { label: string; value: number }[];
  models: { label: string; value: number }[];
  longest: SessionRow | null;
  /** How many days Claude Code keeps its logs. */
  keepDays: number;
}

export type SlideTone = "accent" | "sand" | "slate" | "plain";

export type SlideChart =
  | { kind: "days"; values: number[] }
  | { kind: "hours"; values: number[] }
  | { kind: "bars"; rows: { label: string; value: number; note?: string }[] }
  | { kind: "split"; rows: { label: string; value: number }[] };

export interface Slide {
  id: string;
  tone: SlideTone;
  kicker: string;
  figure: string;
  unit?: string;
  line: string;
  chart?: SlideChart;
  /** One of the (at most three) moments that get a small pop. */
  celebrate?: boolean;
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

/** The top rows of a list as bar rows. */
function itemRows(items: ItemUse[], n = 5): { label: string; value: number; note: string }[] {
  return items.slice(0, n).map((i) => ({ label: i.id, value: i.uses, note: plural(i.uses, "use") }));
}

function share(rows: { value: number }[], n: number): number {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return total > 0 ? Math.round((n / total) * 100) : 0;
}

/**
 * The slides, in order. Each exists only if its numbers do. Under SHORT_STORY_DAYS active days the
 * story is the short one: the total, one favorite, the busiest day, and what it covers.
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

  if (d.tokens > 0) {
    out.push({
      id: "tokens",
      tone: "accent",
      kicker: "All together",
      figure: compact(d.tokens),
      unit: "tokens",
      line: `Across ${plural(d.sessions, "session")} on ${plural(d.activeDays, "active day")}.`,
      chart: d.dayTokens.some((v) => v > 0) ? { kind: "days", values: d.dayTokens } : undefined,
      celebrate: pop(true),
    });
  }

  if (!short && d.activeDays > 0) {
    out.push({
      id: "days",
      tone: "sand",
      kicker: "Showing up",
      figure: exact(d.activeDays),
      unit: d.activeDays === 1 ? "active day" : "active days",
      line:
        d.longestStreak > 1
          ? `Your longest run was ${plural(d.longestStreak, "day")} in a row${d.streak > 1 ? `, and you are ${plural(d.streak, "day")} into a new one` : ""}.`
          : `Out of ${plural(d.spanDays, "day")}.`,
      celebrate: pop(d.longestStreak >= 3),
    });
  }

  const favorite = (): Slide | null => {
    const kinds: [ItemUse[], string, string][] = [
      [d.skills, "Favorite skill", "skill"],
      [d.agents, "Favorite helper", "helper"],
      [d.tools, "Most-used tool", "tool"],
    ];
    for (const [list, kicker, id] of kinds) {
      if (list.length === 0) continue;
      const top = list[0];
      return {
        id,
        tone: "slate",
        kicker,
        figure: top.id,
        line: `Used ${plural(top.uses, "time")} in ${plural(top.sessions, "session")}.`,
        chart: list.length > 1 ? { kind: "bars", rows: itemRows(list) } : undefined,
      };
    }
    return null;
  };

  if (short) {
    const f = favorite();
    if (f) out.push(f);
  } else {
    if (d.skills.length > 0) {
      out.push({ id: "skill", tone: "slate", kicker: "Favorite skill", figure: d.skills[0].id, line: `Used ${plural(d.skills[0].uses, "time")} in ${plural(d.skills[0].sessions, "session")}.`, chart: d.skills.length > 1 ? { kind: "bars", rows: itemRows(d.skills) } : undefined });
    }
    if (d.agents.length > 0) {
      out.push({ id: "helper", tone: "plain", kicker: "Favorite helper", figure: d.agents[0].id, line: `Called on ${plural(d.agents[0].uses, "time")} in ${plural(d.agents[0].sessions, "session")}.`, chart: d.agents.length > 1 ? { kind: "bars", rows: itemRows(d.agents) } : undefined });
    }
    if (d.tools.length > 0) {
      out.push({ id: "tool", tone: "sand", kicker: "Most-used tool", figure: d.tools[0].id, line: `Run ${plural(d.tools[0].uses, "time")} in ${plural(d.tools[0].sessions, "session")}.`, chart: d.tools.length > 1 ? { kind: "bars", rows: itemRows(d.tools) } : undefined });
    }
  }

  if (d.busiest && d.busiest.tokens > 0) {
    out.push({
      id: "busiest",
      tone: "accent",
      kicker: "Your busiest day",
      figure: longDay(d.busiest.day),
      line: `${compact(d.busiest.tokens)} tokens over ${plural(d.busiest.sessions, "session")}.`,
      celebrate: pop(!short),
    });
  }

  const peak = peakHour(d.hours);
  if (!short && peak !== null) {
    out.push({
      id: "rhythm",
      tone: "slate",
      kicker: "When you work",
      figure: hourLabel(peak),
      line: `Most of your tokens land around then, ${partOfDay(peak)}.`,
      chart: { kind: "hours", values: d.hours },
    });
  }

  if (!short && d.projects.length > 0) {
    const top = d.projects[0];
    out.push({
      id: "project",
      tone: "plain",
      kicker: "Where it went",
      figure: top.label,
      line: `${share(d.projects, top.value)}% of the tokens you can see by project.`,
      chart: d.projects.length > 1 ? { kind: "split", rows: d.projects } : undefined,
    });
  }

  if (!short && d.longest && d.longest.durationMs > 0) {
    out.push({
      id: "long",
      tone: "sand",
      kicker: "Longest sitting",
      figure: formatDuration(d.longest.durationMs),
      line: `${d.longest.name ?? `A session in ${d.longest.projectName}`}, ${shortDay(localDayOf(d.longest.startedAt))}.`,
    });
  }

  // Tokens, not dollars (Will, 2026-11-08): the model slide says which model carried the tokens.
  if (!short && d.models.length > 0) {
    const top = d.models[0];
    out.push({
      id: "models",
      tone: "plain",
      kicker: "Your main model",
      figure: top.label,
      line: `${share(d.models, top.value)}% of your tokens.`,
      chart: d.models.length > 1 ? { kind: "split", rows: d.models } : undefined,
    });
  }

  out.push({
    id: "end",
    tone: "plain",
    kicker: "What this covers",
    figure: plural(d.spanDays, "day"),
    line: coverageLine(d),
  });
  return out;
}

function localDayOf(ms: number): string {
  const x = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
}

/** The honest sentence about how far back the numbers go. */
export function coverageLine(d: Pick<WrappedData, "from" | "keepDays">): string {
  return `From ${shortDay(d.from)} to today. Claude Code clears its logs after ${d.keepDays} days, so anything older is not here.`;
}
