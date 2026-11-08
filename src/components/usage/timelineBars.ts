import { binEvenly, compact, formatUsd, formatWhen, headline, plural } from "../../lib/usage";
import type { MessagePoint } from "../../lib/types";
import type { BarDatum } from "./BarChart";

/** The bars of "tokens through the session": at most 48, each a run of nearby messages. */
export function timelineBars(timeline: MessagePoint[], durationMs: number): BarDatum[] {
  if (timeline.length === 0) return [];
  const longRun = durationMs > 24 * 3_600_000;
  const withSeconds = durationMs < 10 * 60_000; // a short run needs seconds or neighbouring bars share a label
  return binEvenly(timeline, 48).map((group, i) => {
    const tokens = group.reduce((s, m) => s + headline(m.tokens), 0);
    const usd = group.reduce((s, m) => s + (m.cost.usd ?? 0), 0);
    const first = group[0].ts;
    const hhmm = new Date(first).toLocaleTimeString(
      "en-US",
      withSeconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit", hour12: false },
    );
    return {
      key: String(i),
      value: tokens,
      axis: longRun ? new Date(first).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : hhmm,
      title: `${formatWhen(first)}, ${plural(group.length, "message")}`,
      valueText: compact(tokens),
      detail: `tokens, ${formatUsd(usd)} estimated`,
    };
  });
}

/** Running spend after each message, for the little line in the hero. */
export function cumulativeSpend(timeline: MessagePoint[]): number[] {
  let run = 0;
  return [...timeline]
    .sort((a, b) => a.ts - b.ts)
    .map((m) => {
      run += m.cost.usd ?? 0;
      return run;
    });
}
