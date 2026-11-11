import { binEvenly, clockTime, compact, formatUsd, formatWhen, headline, plural, shortDate, sumKinds } from "../../lib/usage";
import type { MessagePoint } from "../../lib/types";
import type { BarDatum } from "../charts/shared";

function axisFor(first: number, durationMs: number): string {
  const longRun = durationMs > 24 * 3_600_000;
  const withSeconds = durationMs < 10 * 60_000; // a short run needs seconds or neighbouring bars share a label
  if (longRun) return shortDate(first, first);
  return clockTime(first, { seconds: withSeconds });
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
      kinds: sumKinds(group.map((m) => m.tokens)),
      detail: `tokens, ${formatUsd(usd)} estimated`,
    };
  });
}
