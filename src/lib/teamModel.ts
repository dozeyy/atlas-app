// Pure helpers for the Team tab: what the cards and themes say, in plain words. No React here.

import { addDays, exact, formatDuration, localDay, modelLabel, plural } from "./usage";
import type { BarDatum } from "../components/charts/shared";
import type { EndCounts, ReviewCounts, ReviewTheme, RunRow, ScorecardArgs, StartedFrom, TypeCard, VerdictCounts } from "./teamTypes";

export type TeamView = "scorecard" | "review";
export type RangeId = "7" | "30" | "90" | "all";

export const RANGES: { value: RangeId; label: string; days: number | null }[] = [
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
  { value: "90", label: "90 days", days: 90 },
  { value: "all", label: "All", days: null },
];

export const STARTED_OPTIONS: { value: StartedFrom; label: string }[] = [
  { value: "all", label: "Started from: all" },
  { value: "interactive", label: "Started from: a chat" },
  { value: "headless", label: "Started outside a chat" },
];

export interface TeamPrefs {
  view: TeamView;
  range: RangeId;
  startedFrom: StartedFrom;
}

export const DEFAULT_PREFS: TeamPrefs = { view: "scorecard", range: "30", startedFrom: "all" };

const PREFS_KEY = "atlas.team.prefs";

/** Restored before the first paint. Anything unreadable falls back to the defaults. */
export function loadPrefs(): TeamPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<TeamPrefs> | null;
    return {
      view: raw?.view === "review" ? "review" : "scorecard",
      range: RANGES.some((r) => r.value === raw?.range) ? (raw!.range as RangeId) : DEFAULT_PREFS.range,
      startedFrom: raw?.startedFrom === "interactive" || raw?.startedFrom === "headless" ? raw.startedFrom : "all",
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(p: TeamPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    // Private window or blocked storage: the choice just is not remembered.
  }
}

export function rangeDays(r: RangeId): number | null {
  return RANGES.find((x) => x.value === r)?.days ?? null;
}

export function scorecardArgs(p: TeamPrefs): ScorecardArgs {
  return { days: rangeDays(p.range), startedFrom: p.startedFrom };
}

/** Cards whose name has every typed word in it. */
export function filterCards(cards: TypeCard[], text: string): TypeCard[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return cards;
  return cards.filter((c) => {
    const hay = `${c.displayName} ${c.agentType}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** "Passed 9 of 12 reviews" only from 5 tied reviews; below that, counts alone (no rate). */
export function rateSentence(r: ReviewCounts | null): string | null {
  if (!r || !r.rateOk) return null;
  return `Passed ${r.passed} of ${r.tied} reviews`;
}

/** The counts a worker card always shows, rate or not. */
export function reviewCountsLine(r: ReviewCounts): string {
  if (r.tied === 0 && r.notTied === 0) return "No reviews yet";
  const parts: string[] = [];
  if (r.tied > 0) parts.push(`${r.passed} passed`, `${r.sentBack} sent back`);
  if (r.tied > 0 && r.other > 0) parts.push(`${r.other} other`);
  if (r.notTied > 0) parts.push(`${r.notTied} not tied to a review`);
  return parts.join(", ");
}

/** A reviewer type's own verdicts, the four rows of the sheet (a partial report counts as other). */
export function verdictRows(v: VerdictCounts): { key: string; label: string; n: number }[] {
  // Only the verdicts that were given: a row that counts nothing is noise.
  return [
    { key: "pass", label: "Passed", n: v.pass },
    { key: "findings", label: "Sent back", n: v.findings },
    { key: "other", label: "Other", n: v.other + v.partial },
    { key: "none", label: "No verdict", n: v.none },
  ].filter((r) => r.n > 0);
}

export function reviewerLine(v: VerdictCounts): string {
  const given = v.pass + v.findings + v.other + v.partial;
  if (given === 0) return "No verdicts given yet";
  return `${v.pass} passed, ${v.findings} sent back`;
}

export const TOO_FEW = "Too few runs for a typical time yet";

/** How a typical run goes, as one line: "Usually 9 min and 38 tool calls". Said once, not per number, when there are too few runs. */
export function usualLine(c: TypeCard): string {
  if (c.tooFewRuns) return TOO_FEW;
  const parts: string[] = [];
  if (c.durationMsMedian !== null) parts.push(formatDuration(c.durationMsMedian));
  if (c.toolCallsMedian !== null) parts.push(plural(c.toolCallsMedian, "tool call"));
  return parts.length ? `Usually ${parts.join(" and ")}` : TOO_FEW;
}

/** What a reviewer does, in plain words (the card and the sheet say it under the name). */
export const REVIEWER_WORDS = "Reviews other helpers' work";

/** Runs started outside a chat: by a script, a schedule or another program. "Headless" is the name Claude Code gives them. */
export const HEADLESS_HINT = "Outside a chat: started by a script, a schedule or another program. Claude Code calls this headless.";

export function startedLine(s: { interactive: number; headless: number }): string {
  return `${plural(s.interactive, "run")} from a chat, ${exact(s.headless)} outside a chat`;
}

/** The twelve weekly counts in words, for the hover on the small chart: oldest week first. */
export function weeklyTitle(weekly: number[]): string {
  const total = weekly.reduce((a, b) => a + b, 0);
  return `Runs per week, last ${weekly.length} weeks, oldest first: ${weekly.map((v) => exact(v)).join(", ")}. ${plural(total, "run")} in all.`;
}

/**
 * How runs ended, as the sheet words it: only the ways that happened. A row that counts nothing
 * is noise; a run whose ending is not known is still said, never hidden.
 */
export function endRows(e: EndCounts): { key: string; label: string; n: number }[] {
  return [
    { key: "finished", label: "Finished", n: e.finished },
    { key: "errored", label: "Hit an error", n: e.errored },
    { key: "stopped", label: "Stopped", n: e.stopped },
    { key: "unknown", label: "Not known", n: e.unknown },
  ].filter((r) => r.n > 0);
}

/**
 * The model a helper mostly ran on, with how hard it was asked to think: "Sonnet 5.5, high effort".
 * The bare word ("high") says nothing on its own.
 */
export function modelLine(model: string, effort: string | null | undefined): string {
  const name = modelLabel(model);
  return effort ? `${name}, ${effort} effort` : name;
}

/** What the small bars on every card plot, said once under the cards. */
export function weeklyLegend(weeks: number): string {
  return `The small bars on a card are its runs per week, last ${weeks} weeks.`;
}

export function finishLine(c: TypeCard): string | null {
  if (c.finishRate === null) return null;
  return `${Math.round(c.finishRate * 100)}% finished`;
}

const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/** The twelve weekly buckets as chart bars: the last one ends today. */
export function weeklyBars(weekly: number[], toTs: number): BarDatum[] {
  const n = weekly.length;
  return weekly.map((v, i) => {
    const endDay = addDays(localDay(new Date(toTs)), -(n - 1 - i) * 7);
    const start = new Date(`${addDays(endDay, -6)}T12:00:00`);
    const date = SHORT.format(start);
    return {
      key: `w${i}`,
      value: v,
      axis: date,
      title: `Week of ${date}`,
      valueText: plural(v, "run"),
      detail: "",
    };
  });
}

/** "Made a rule, Nov 9". */
export function madeLabel(madeMs: number): string {
  return `Made a rule, ${SHORT.format(new Date(madeMs))}`;
}

/** "3 high, 1 medium" most severe first; findings without a severity are "unrated". */
export function severityLine(t: ReviewTheme): string {
  return t.severities.map((s) => `${s.count} ${s.severity === "none" ? "unrated" : s.severity.toLowerCase()}`).join(", ");
}

/** What a run row says about how it went, in a few words. */
export function runOutcome(r: RunRow): string {
  if (r.verdict === "pass") return "Passed";
  if (r.verdict === "findings") return "Sent back";
  if (r.verdict === "partial") return "Partial";
  if (r.verdict === "other") return r.verdictWord ? r.verdictWord : "Other verdict";
  if (r.endStatus === "errored") return "Hit an error";
  if (r.endStatus === "stopped") return "Stopped";
  if (r.endStatus === "finished") return "Finished";
  return "Not known";
}

/** "History covers the last N days" (Will, 2026-11-09), only when the cache knows it. */
export function historyLine(days: number | null): string | null {
  return days === null ? null : `History covers the last ${plural(days, "day")}.`;
}
