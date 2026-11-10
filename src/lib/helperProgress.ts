// What the "Helpers at work" list says about each helper: how far along it is, and whether it
// looks stuck. Pure functions of the snapshot's counts (never any step or prompt text).
//
// Helpers never keep a to-do list worth trusting, so "how far" is, in order: their own plan once
// it has moved (Step 3 of 6); else tool calls so far against the median of that kind's finished
// runs (About 60% of a typical run); else nothing to compare (docs/specs/agent-scorecard.md D43).

import { helperName, typeName } from "./helperName";
import { formatDuration, modelWithEffort } from "./usage";
import type { NowHelper } from "./nowTypes";

/** No new line for this long (and no call open) reads as "no progress". One constant for the page. */
export const STUCK_MS = 5 * 60_000;
/** While a helper runs, its fill never passes this: only finishing completes the trail. */
export const FILL_CAP = 0.9;
/** Below this share of a typical run the line says "Just started" instead of a percentage. */
export const JUST_STARTED = 0.05;

export type ProgressKind = "plan" | "typical" | "over" | "none";

export interface Progress {
  kind: ProgressKind;
  /** 0 to 1, or null when there is nothing to draw but the dotted path. */
  fill: number | null;
  text: string;
  /** The hover: only the typical-run kinds have one. */
  hint?: string;
}

// The type's name lives with the other name rules; call sites that import it from here keep working.
export { typeName };

/**
 * "Opus 5.5 (dot) high": the exact model and the effort the transcript says, through the app's one
 * label rule (`modelWithEffort`, as on Sessions, Session Detail and the chat cards). Either part that the lines do not say is left out, never
 * guessed; with neither there is nothing to show.
 */
export function modelEffort(h: Pick<NowHelper, "model" | "effort">): string | null {
  if (h.model) return modelWithEffort(h.model, h.effort);
  return h.effort || null;
}

export function progressOf(h: NowHelper): Progress {
  if (h.plan && h.plan.total >= 2) {
    const { done, total } = h.plan;
    return {
      kind: "plan",
      // Capped like every other fill: a helper whose steps are all ticked is still running until
      // it ends, and only finishing completes the trail.
      fill: Math.min(FILL_CAP, done / total),
      text: `Step ${Math.min(done + 1, total)} of ${total}`,
    };
  }
  const t = h.typical;
  if (t && t.calls > 0) {
    const hint = `A typical ${helperName(typeName(h.agentType).toLowerCase())} run: ${t.calls} tool calls, ${formatDuration(t.ms)} (median of ${t.runs} runs).`;
    if (h.toolCalls >= t.calls) return { kind: "over", fill: FILL_CAP, text: "Longer than a typical run", hint };
    const share = h.toolCalls / t.calls;
    // Almost nothing done yet: a percentage would be a made-up number.
    if (share < JUST_STARTED) return { kind: "typical", fill: share, text: "Just started", hint };
    const pct = Math.min(90, Math.max(10, Math.round(share * 10) * 10));
    return { kind: "typical", fill: Math.min(FILL_CAP, share), text: `About ${pct}% of a typical run`, hint };
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
  // The app's one way to write a length of time: past an hour it is "1 h 15 min", not "75 min".
  const quiet = formatDuration(min * 60_000);
  if (!open) return { text: `No progress for ${quiet}`, tone: "warning" };
  return { text: open.kind === "run" ? `Running ${open.word} for ${quiet}` : `Waiting on ${open.word} for ${quiet}`, tone: "calm" };
}
