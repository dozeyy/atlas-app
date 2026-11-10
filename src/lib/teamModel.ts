// Pure helpers for the Team tab: what the cards and themes say, in plain words. No React here.

import { addDays, formatDuration, localDay, plural } from "./usage";
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
  { value: "headless", label: "Started from: headless" },
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
  return [
    { key: "pass", label: "Passed", n: v.pass },
    { key: "findings", label: "Sent back", n: v.findings },
    { key: "other", label: "Other", n: v.other + v.partial },
    { key: "none", label: "No verdict", n: v.none },
  ];
}

export function reviewerLine(v: VerdictCounts): string {
  const given = v.pass + v.findings + v.other + v.partial;
  if (given === 0) return "No verdicts given yet";
  return `${v.pass} passed, ${v.findings} sent back`;
}

export const TOO_FEW = "Too few runs yet";

export function medianTime(c: TypeCard): string {
  return c.tooFewRuns || c.durationMsMedian === null ? TOO_FEW : `${formatDuration(c.durationMsMedian)} typical`;
}

export function medianCalls(c: TypeCard): string {
  return c.tooFewRuns || c.toolCallsMedian === null ? TOO_FEW : `${plural(c.toolCallsMedian, "tool call")} typical`;
}

/** How runs ended, as the sheet words it. Unknown runs are said, never hidden. */
export function endRows(e: EndCounts): { key: string; label: string; n: number }[] {
  return [
    { key: "finished", label: "Finished", n: e.finished },
    { key: "errored", label: "Hit an error", n: e.errored },
    { key: "stopped", label: "Stopped", n: e.stopped },
    { key: "unknown", label: "Not known", n: e.unknown },
  ];
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

/** Where a theme was found, as one short line: "Found in work by builder (3), tester (1)". */
export function foundLine(t: ReviewTheme, nameOf: (type: string) => string): string {
  const parts = t.foundInWorkBy.map((x) => `${nameOf(x.agentType)} (${x.count})`);
  if (t.notTied > 0) parts.push(`not tied to one helper (${t.notTied})`);
  return parts.length ? parts.join(", ") : "Not tied to one helper";
}

export function raisedLine(t: ReviewTheme, nameOf: (type: string) => string): string {
  return t.reviewers.map((x) => `${nameOf(x.agentType)} (${x.count})`).join(", ");
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
