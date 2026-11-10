import { useMemo, useState } from "react";
import { Card, SegmentedControl } from "../controls";
import { OptionField, OptionsMenu } from "../OptionsMenu";
import { Bars } from "../charts/Bars";
import type { BarDatum } from "../charts/Bars";
import { getBackend } from "../../lib/ipc";
import { useFetched, useLiveReload } from "../../lib/useUsage";
import {
  RANGES,
  axisLabel,
  bucketTitle,
  compact,
  exact,
  formatUsd,
  headline,
  plural,
  rangeFor,
  tokenHint,
} from "../../lib/usage";
import type { RangeKind } from "../../lib/usage";
import type { Timeline } from "../../lib/types";
import { ErrorBlock, Skeleton } from "./StateBlocks";

const RANGE_NAME: Record<RangeKind, string> = { today: "Today", "30d": "Last 30 days", "12w": "Last 12 weeks" };
/** What the total counts: it lives in the total's hover, not in a sentence on the card. */
const TOKEN_MEANING = "Tokens count what you sent, what Claude wrote and what it saved for reuse (cache writes).\nWhat it reused (cache reads) is listed apart.";

/**
 * Tokens over time as activity bars, with a table twin for anyone who prefers numbers. Tokens only
 * (Will, 2026-11-08); the API-price estimate for a bar or a row is in its hover.
 */
export function ActivityCard({ today }: { today: string }) {
  const backend = getBackend();
  const [range, setRange] = useState<RangeKind>("30d");
  const [asTable, setAsTable] = useState(false);
  const span = useMemo(() => rangeFor(range, today), [range, today]);
  const tl = useFetched<Timeline>(() => backend.usageTimeline(span), [span.from, span.to, span.bucket]);
  useLiveReload(tl.reload);

  const points = tl.data?.points ?? [];
  const data: BarDatum[] = useMemo(
    () =>
      points.map((p, i) => {
        const tokens = headline(p.tokens);
        // The newest bar says what it is in words: "Today" under the day that is today, "This week".
        const newest = i === points.length - 1;
        const axis =
          newest && span.bucket === "week"
            ? "This week"
            : newest && span.bucket === "day" && p.start.slice(0, 10) === today
              ? "Today"
              : axisLabel(p.start, span.bucket);
        return {
          key: p.start,
          value: tokens,
          axis,
          title: bucketTitle(p.start, span.bucket),
          valueText: `${compact(tokens)} tokens`,
          detail: `${p.cost.usd === null ? "No price" : `${formatUsd(p.cost.usd)} estimated`}, ${plural(p.sessions, "session")} started`,
        };
      }),
    [points, span.bucket, today],
  );

  // The accent bar is "now": the newest day or week, and on the hourly view the hour it is.
  const hourNow = new Date().getHours();
  const nowBar =
    span.bucket === "hour" ? points.findIndex((p) => p.start.slice(0, 10) === today && Number(p.start.slice(11, 13)) === hourNow) : points.length - 1;

  const total = useMemo(() => points.reduce((s, p) => s + headline(p.tokens), 0), [points]);

  return (
    <Card className="h-full px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="d d-figure text-ink">Activity</h2>
          <p className="mt-0.5 text-caption text-ink-2" data-testid="chart-readout" title={TOKEN_MEANING}>
            {RANGE_NAME[range]}: {compact(total)} tokens
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* The range is this card's main control and stays out in the open; the rest hides in one button. */}
          <SegmentedControl label="Time range" value={range} options={RANGES} onChange={setRange} />
          <OptionsMenu label="Chart options" count={asTable ? 1 : 0} onReset={() => setAsTable(false)} width={260}>
            <OptionField label="As">
              <SegmentedControl
                label="Chart or table"
                value={asTable ? "table" : "chart"}
                options={[
                  { value: "chart", label: "Chart" },
                  { value: "table", label: "Table" },
                ]}
                onChange={(v) => setAsTable(v === "table")}
              />
            </OptionField>
          </OptionsMenu>
        </div>
      </div>

      {tl.loading && !tl.data ? (
        <div role="status" aria-label="Loading activity">
          <Skeleton className="h-[158px] w-full" />
        </div>
      ) : tl.error ? (
        <ErrorBlock title="Could not load activity" message={tl.error} onRetry={() => tl.reload(false)} />
      ) : asTable ? (
        <div className="max-h-[300px] overflow-auto rounded-control border border-line">
          <table className="w-full text-body">
            <caption className="sr-only">{`${RANGE_NAME[range]}, one row per ${span.bucket}`}</caption>
            <thead className="sticky top-0 bg-surface text-left text-caption text-ink-2">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  {span.bucket === "hour" ? "Hour" : span.bucket === "week" ? "Week of" : "Day"}
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Tokens</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Sessions started</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {points.map((p) => (
                <tr key={p.start} className="border-t border-line">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-ink">
                    {bucketTitle(p.start, span.bucket)}
                  </th>
                  <td className="px-3 py-1.5 text-right" title={tokenHint(headline(p.tokens), p.cost)}>{compact(headline(p.tokens))}</td>
                  <td className="px-3 py-1.5 text-right">{exact(p.sessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Bars
          id={`activity:${range}`}
          data={data}
          label={`Tokens, ${RANGE_NAME[range].toLowerCase()}`}
          formatTick={compact}
          height={158}
          highlight={nowBar}
          anchor={span.bucket === "hour" ? "start" : "end"}
        />
      )}
    </Card>
  );
}
