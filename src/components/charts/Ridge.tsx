import { useId, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { ridgeGeometry } from "../../lib/chartPaths";
import { useIntro } from "../../lib/motion";
import { ChartTooltip } from "./ChartTooltip";
import type { TipAt } from "./ChartTooltip";
import { stepIndex, useWidth } from "./shared";
import type { BarDatum } from "./shared";

/**
 * A smooth ridge over a short run of points (a week of days, the hours of a session). The
 * peak wears a summit: a dot, a dashed pole and the Atlas spark. Hover or the arrow keys read
 * each point; the summit steps aside while a tooltip is open.
 */
export function Ridge({
  id,
  data,
  label,
  height = 168,
  peakLabel = true,
  summit = true,
}: {
  id: string;
  data: BarDatum[];
  label: string;
  height?: number;
  /** Bold the axis label under the peak. */
  peakLabel?: boolean;
  /** Wear the dot, pole and spark on the peak. Off when the run has no clear peak. */
  summit?: boolean;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const intro = useIntro(id);
  const gid = useId();
  const [active, setActive] = useState<number | null>(null);
  const n = data.length;
  const g = useMemo(() => ridgeGeometry(data.map((d) => d.value), width, height), [data, width, height]);
  const any = data.some((d) => d.value > 0);
  const slot = (width - 20) / Math.max(1, n - 1);

  const tip: TipAt | null =
    active !== null && data[active]
      ? { x: g.pts[active][0], y: Math.max(8, g.pts[active][1] - 12), ...data[active] }
      : null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepIndex(e.key, active, n);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(width / 64))));

  return (
    <div
      ref={wrapRef}
      role="group"
      aria-label={
        any
          ? `${label}. ${summit ? "Busiest" : "Highest"} ${data[g.peak].title} at ${data[g.peak].valueText}. Use the left and right arrow keys to read each point.`
          : `${label}. No activity.`
      }
      tabIndex={0}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
      data-tip={tip ? 1 : 0}
      className={`chart-wrap${intro ? " intro" : ""}`}
    >
      <svg className="chart" width={width} height={height} aria-hidden="true">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.3" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line className="base-line" x1={10} x2={width - 10} y1={g.baseline} y2={g.baseline} />
        {any && (
          <>
            <path className="ridge-area" d={g.area} fill={`url(#${gid})`} />
            <path className="ridge-stroke" d={g.line} style={{ ["--len" as string]: g.length }} />
          </>
        )}
        {any && summit && (
          <g className="summit">
            <line className="pole" x1={g.pts[g.peak][0]} x2={g.pts[g.peak][0]} y1={g.pts[g.peak][1] - 24} y2={g.pts[g.peak][1] - 5} />
            <circle className="ridge-dot" cx={g.pts[g.peak][0]} cy={g.pts[g.peak][1]} r={4.5} />
          </g>
        )}
        {active !== null && g.pts[active] && (
          <circle className="ridge-dot" cx={g.pts[active][0]} cy={g.pts[active][1]} r={4.5} />
        )}
        {data.map((d, i) =>
          i % labelEvery === 0 || n <= 8 ? (
            <text
              key={`l${d.key}`}
              className={`ridge-day${peakLabel && summit && any && i === g.peak ? " peak" : ""}`}
              x={g.pts[i][0]}
              y={height - 4}
            >
              {d.axis}
            </text>
          ) : null,
        )}
        {data.map((d, i) => (
          <rect
            key={`h${d.key}`}
            className="ridge-hit"
            x={g.pts[i][0] - slot / 2}
            y={0}
            width={slot}
            height={height}
            onPointerEnter={() => setActive(i)}
          />
        ))}
      </svg>
      {any && summit && (
        <span
          aria-hidden="true"
          className="spark summit"
          style={{ position: "absolute", left: g.pts[g.peak][0] - 9, top: Math.max(0, g.pts[g.peak][1] - 46), pointerEvents: "none" }}
        />
      )}
      <ChartTooltip tip={tip} width={width} />
      <span className="sr-only" aria-live="polite">
        {active !== null && data[active] ? `${data[active].title}: ${data[active].valueText} ${data[active].detail}` : ""}
      </span>
    </div>
  );
}
