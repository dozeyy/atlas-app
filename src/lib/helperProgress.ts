// What the "Helpers at work" list says about each helper: how far along it is, and whether it
// looks stuck. Pure functions of the snapshot's counts (never any step or prompt text).
//
// Helpers never keep a to-do list worth trusting, so "how far" is, in order: their own plan once
// it has moved (Step 3 of 6); else tool calls so far against the median of that kind's finished
// runs (About 60% of a typical run); else nothing to compare (docs/specs/agent-scorecard.md D43).

import { formatDuration, modelLabel } from "./usage";
import type { NowHelper } from "./nowTypes";

/** No new line for this long (and no call open) reads as "no progress". One constant for the page. */
export const STUCK_MS = 5 * 60_000;
/** While a helper runs, its fill never passes this: only finishing completes the trail. */
export const FILL_CAP = 0.9;

export type ProgressKind = "plan" | "typical" | "over" | "none";

export interface Progress {
  kind: ProgressKind;
  /** 0 to 1, or null when there is nothing to draw but the dotted path. */
  fill: number | null;
  text: string;
  /** The hover: only the typical-run kinds have one. */
  hint?: string;
}

/** "code-reviewer" -> "Code reviewer", "general-purpose" -> "General purpose". */
export function typeName(t: string | null): string {
  if (!t) return "Helper";
  const s = t.replace(/[-_]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "Helper";
}

/**
 * "Opus 5.5 · high": the exact model (the app's one model-name helper, so its fixes apply here)
 * and the effort the transcript says. Either part that the lines do not say is left out, never
 * guessed; with neither there is nothing to show.
 */
export function modelEffort(h: Pick<NowHelper, "model" | "effort">): string | null {
  const parts = [h.model ? modelLabel(h.model) : null, h.effort].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function progressOf(h: NowHelper): Progress {
  if (h.plan && h.plan.total >= 2) {
    const { done, total } = h.plan;
    return {
      kind: "plan",
      fill: Math.min(1, done / total),
      text: `Step ${Math.min(done + 1, total)} of ${total}`,
    };
  }
  const t = h.typical;
  if (t && t.calls > 0) {
    const hint = `A typical ${typeName(h.agentType).toLowerCase()} run: ${t.calls} tool calls, ${formatDuration(t.ms)} (median of ${t.runs} runs).`;
    if (h.toolCalls >= t.calls) return { kind: "over", fill: FILL_CAP, text: "Longer than a typical run", hint };
    const pct = Math.min(90, Math.max(10, Math.round((h.toolCalls / t.calls) * 10) * 10));
    return { kind: "typical", fill: Math.min(FILL_CAP, h.toolCalls / t.calls), text: `About ${pct}% of a typical run`, hint };
  }
  return { kind: "none", fill: null, text: "No past runs to compare" };
}

export interface Status {
  text: string;
  /** warning: nothing has moved and nothing is open; calm: a long command is simply running. */
  tone: "phase" | "calm" | "warning";
}

/** A helper's phase word, or (after STUCK_MS of silence) how long it has been quiet and why. */
export function statusOf(h: NowHelper, now: number): Status {
  const idle = h.lastLineMs === null ? 0 : now - h.lastLineMs;
  if (h.done || idle < STUCK_MS) return { text: h.phase, tone: "phase" };
  const min = Math.floor(idle / 60_000);
  const open = h.openCall;
  if (!open) return { text: `No progress for ${min} min`, tone: "warning" };
  return { text: open.kind === "run" ? `Running ${open.word} for ${min} min` : `Waiting on ${open.word} for ${min} min`, tone: "calm" };
}
