import { binEvenly, compact, formatUsd, formatWhen, headline, plural } from "../../lib/usage";
import type { MessagePoint } from "../../lib/types";
import type { BarDatum } from "../charts/shared";

function axisFor(first: number, durationMs: number): string {
  const longRun = durationMs > 24 * 3_600_000;
  const withSeconds = durationMs < 10 * 60_000; // a short run needs seconds or neighbouring bars share a label
  if (longRun) return new Date(first).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return new Date(first).toLocaleTimeString(
    "en-US",
    withSeconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit", hour12: false },
  );
}

/** The bars of "tokens through the session": at most 48, each a run of nearby messages. */
export function timelineBars(timeline: MessagePoint[], durationMs: number): BarDatum[] {
  if (timeline.length === 0) return [];
  return binEvenly(timeline, 48).map((group, i) => {
    const tokens = group.reduce((s, m) => s + headline(m.tokens), 0);
    const usd = group.reduce((s, m) => s + (m.cost.usd ?? 0), 0);
    const first = group[0].ts;
    return {
      key: String(i),
      value: tokens,
      axis: axisFor(first, durationMs),
      title: `${formatWhen(first)}, ${plural(group.length, "message")}`,
      valueText: compact(tokens),
      detail: `tokens, ${formatUsd(usd)} estimated`,
    };
  });
}

/** Spend per stretch of the run, for the ridge in the hero: at most 20 points. */
export function spendRidge(timeline: MessagePoint[], durationMs: number): BarDatum[] {
  if (timeline.length === 0) return [];
  return binEvenly(
    [...timeline].sort((a, b) => a.ts - b.ts),
    20,
  ).map((group, i) => {
    const usd = group.reduce((s, m) => s + (m.cost.usd ?? 0), 0);
    const tokens = group.reduce((s, m) => s + headline(m.tokens), 0);
    const first = group[0].ts;
    return {
      key: String(i),
      value: usd,
      axis: axisFor(first, durationMs),
      title: `${formatWhen(first)}, ${plural(group.length, "message")}`,
      valueText: formatUsd(usd),
      detail: `estimated, ${compact(tokens)} tokens`,
    };
  });
}

/** A peak worth a spark: the top point is well above a typical one (at least twice the median). */
export function hasClearPeak(values: number[]): boolean {
  const live = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (live.length < 3) return false;
  const median = live[Math.floor(live.length / 2)];
  return live[live.length - 1] >= median * 2;
}
