import { useMemo, useState } from "react";
import { Table } from "@phosphor-icons/react";
import { Button, Card, SegmentedControl } from "../controls";
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
} from "../../lib/usage";
import type { RangeKind } from "../../lib/usage";
import type { Timeline } from "../../lib/types";
import { CostText } from "./CostText";
import { ErrorBlock, Skeleton } from "./StateBlocks";

type Metric = "tokens" | "cost";

const RANGE_NAME: Record<RangeKind, string> = { today: "Today", "30d": "Last 30 days", "12w": "Last 12 weeks" };

/** Tokens or estimated cost over time as activity bars, with a table twin for anyone who prefers numbers. */
export function ActivityCard({ today }: { today: string }) {
  const backend = getBackend();
  const [range, setRange] = useState<RangeKind>("30d");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [asTable, setAsTable] = useState(false);
  const span = useMemo(() => rangeFor(range, today), [range, today]);
  const tl = useFetched<Timeline>(() => backend.usageTimeline(span), [span.from, span.to, span.bucket]);
  useLiveReload(tl.reload);

  const points = tl.data?.points ?? [];
  const data: BarDatum[] = useMemo(
    () =>
      points.map((p) => {
        const tokens = headline(p.tokens);
        const usd = p.cost.usd ?? 0;
        return {
          key: p.start,
          value: metric === "tokens" ? tokens : usd,
          axis: axisLabel(p.start, span.bucket),
          title: bucketTitle(p.start, span.bucket),
          valueText: metric === "tokens" ? compact(tokens) : formatUsd(usd),
          detail:
            metric === "tokens"
              ? `tokens, ${p.cost.usd === null ? "no price" : `${formatUsd(usd)} estimated`}, ${plural(p.sessions, "session")} started`
              : `estimated, ${compact(tokens)} tokens, ${plural(p.sessions, "session")} started`,
        };
      }),
    [points, metric, span.bucket],
  );

  const totals = useMemo(() => {
    let tokens = 0;
    let usd = 0;
    for (const p of points) {
      tokens += headline(p.tokens);
      usd += p.cost.usd ?? 0;
    }
    return { tokens, usd };
  }, [points]);

  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="d d-figure text-ink">Activity</h2>
          <p className="mt-0.5 text-caption text-ink-2" data-testid="chart-readout">
            {RANGE_NAME[range]}: {metric === "tokens" ? `${compact(totals.tokens)} tokens` : `${formatUsd(totals.usd)} estimated`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            label="Measure"
            value={metric}
            options={[
              { value: "tokens", label: "Tokens" },
              { value: "cost", label: "Cost" },
            ]}
            onChange={setMetric}
          />
          <SegmentedControl label="Time range" value={range} options={RANGES} onChange={setRange} />
          <Button
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
            title={asTable ? "Show the chart" : "Show the numbers as a table"}
          >
            <Table size={14} aria-hidden="true" />
            {asTable ? "Chart" : "Table"}
          </Button>
        </div>
      </div>

      {tl.loading && !tl.data ? (
        <div role="status" aria-label="Loading activity">
          <Skeleton className="h-[184px] w-full" />
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
                <th scope="col" className="px-3 py-2 text-right font-medium">Est. cost</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Sessions started</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {points.map((p) => (
                <tr key={p.start} className="border-t border-line">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-ink">
                    {bucketTitle(p.start, span.bucket)}
                  </th>
                  <td className="px-3 py-1.5 text-right" title={exact(headline(p.tokens))}>{compact(headline(p.tokens))}</td>
                  <td className="px-3 py-1.5 text-right"><CostText cost={p.cost} /></td>
                  <td className="px-3 py-1.5 text-right">{exact(p.sessions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Bars
          id={`activity:${range}:${metric}`}
          data={data}
          label={`${metric === "tokens" ? "Tokens" : "Estimated cost"}, ${RANGE_NAME[range].toLowerCase()}`}
          formatTick={(v) => (metric === "tokens" ? compact(v) : formatUsd(v).replace(/\.00$/, ""))}
        />
      )}
      <p className="mt-3 text-caption text-ink-2">
        Tokens count what you sent and what Claude wrote, plus cache writes. Cache reads are listed apart.
      </p>
    </Card>
  );
}
