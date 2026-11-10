import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { ZERO_STUB, axisMax, barPath, barTop, labelStep } from "../../lib/chartPaths";
import { useIntro } from "../../lib/motion";
import { ChartTooltip } from "./ChartTooltip";
import type { TipAt } from "./ChartTooltip";
import { clearPeak, stepIndex, useWidth } from "./shared";
import type { BarDatum } from "./shared";

export type { BarDatum } from "./shared";

const LEFT = 42;
const RIGHT = 4;
const TOP = 28;
const BOTTOM = 22;

/**
 * Activity bars. A bar grows from a fixed baseline; hover raises its top 4 px (scale from the
 * bottom edge) and fills it darker, a three-line tooltip follows, and the spark that sits
 * over a clear single peak (`clearPeak`: level bars get none) steps aside while a tooltip is open. Keyboard: the group takes focus,
 * Left/Right (Home/End) read each bar. The pointer target is a separate full-height slot, so
 * the bar's growth never moves what the mouse is over.
 */
export function Bars({
  id,
  data,
  label,
  formatTick,
  height: fixedHeight,
  highlight,
  anchor = "start",
  calm = false,
}: {
  /** Intro id: the entrance animation plays once per id per launch. */
  id: string;
  data: BarDatum[];
  label: string;
  formatTick: (v: number) => string;
  height?: number;
  /** Which bar wears the accent (default: the last, "now"). -1 for none. */
  highlight?: number;
  /** Which end the x labels count from. "end" keeps a label under the newest bar. */
  anchor?: "start" | "end";
  /** A calm zone (a sheet): no entrance animation and no summit spark. */
  calm?: boolean;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  // Unless told a height, the chart grows with its room: 184 px at narrow, up to 300 px when wide.
  const height = fixedHeight ?? Math.round(Math.min(300, Math.max(184, width * 0.2)));
  const introId = useIntro(id);
  const intro = introId && !calm;
  const [active, setActive] = useState<number | null>(null);
  const n = data.length;
  const max = axisMax(Math.max(0, ...data.map((d) => d.value)));
  const plotW = Math.max(40, width - LEFT - RIGHT);
  const base = height - BOTTOM;
  const slot = plotW / Math.max(1, n);
  const bw = Math.max(2, slot * 0.62);
  const yOf = (v: number) => barTop(v, max, base, TOP);
  const hot = highlight ?? n - 1;

  const busiest = useMemo(() => {
    let at = -1;
    data.forEach((d, i) => {
      if (d.value > 0 && (at < 0 || d.value > data[at].value)) at = i;
    });
    return at;
  }, [data]);
  const peak = useMemo(() => clearPeak(data.map((d) => d.value)), [data]);

  // Four or five labels across the axis (three when narrow), stepping by a count that reads well
  // (every 6 hours, every 6 days, every 3 weeks), never by 5.
  const labelEvery = labelStep(n, Math.min(5, Math.max(3, Math.floor(plotW / 150))));
  // A range with nothing in it shows its baseline and no ticks: "2 / 1 / 0" on an empty day was
  // a made-up scale.
  const empty = !data.some((d) => d.value > 0);
  const cx = (i: number) => LEFT + i * slot + slot / 2;
  const labelled = (i: number) => (anchor === "end" ? n - 1 - i : i) % labelEvery === 0;
  // Counting from the end, the newest bar's label ends at the plot's right edge (the first one
  // starts at its left edge), so neither hangs outside the chart.
  const endLabel = (i: number) => anchor === "end" && i === n - 1 && i > 0;

  const tip: TipAt | null =
    active !== null && data[active]
      ? { x: cx(active), y: Math.max(8, yOf(data[active].value) - 6), ...data[active] }
      : null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepIndex(e.key, active, n);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const summary =
    busiest >= 0
      ? `${label}. ${n} bars, busiest ${data[busiest].title} at ${data[busiest].valueText}. Use the left and right arrow keys to read each bar.`
      : `${label}. No activity in this range.`;

  return (
    <div
      ref={wrapRef}
      role="group"
      aria-label={summary}
      tabIndex={0}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
      data-tipping={tip ? 1 : 0}
      className={`chart-wrap${intro ? " intro" : ""}`}
    >
      <svg className="chart" width={width} height={height} aria-hidden="true">
        {!empty &&
          [0.5, 1].map((f) => (
            <g key={f}>
              <line className="grid-line" x1={LEFT} x2={width - RIGHT} y1={yOf(max * f)} y2={yOf(max * f)} />
              <text className="axis-label" x={LEFT - 8} y={yOf(max * f) + 4} textAnchor="end">
                {formatTick(max * f)}
              </text>
            </g>
          ))}
        <line className="base-line" x1={LEFT} x2={width - RIGHT} y1={base} y2={base} />
        {!empty && (
          <text className="axis-label" x={LEFT - 8} y={base + 4} textAnchor="end">
            0
          </text>
        )}

        {data.map((d, i) => {
          const x = LEFT + i * slot + (slot - bw) / 2;
          const top = yOf(d.value);
          const h = base - top;
          const on = active === i;
          return (
            <g key={d.key} className={`bar-g${on ? " on" : ""}`}>
              {d.value > 0 ? (
                <path
                  className={`bar${i === hot ? " today" : ""}`}
                  d={barPath(x, bw, top, base, Math.min(6, bw / 2))}
                  style={{ ["--hs" as string]: Math.min(1.6, (h + 4) / Math.max(h, 1)), ["--i" as string]: i }}
                />
              ) : (
                // Half a pixel in on every side: the stub's 1 px hairline (trail.css) then sits inside
                // the 3 px nub instead of straddling its edge and the baseline.
                <rect className="bar zero" x={x + 0.5} y={base - ZERO_STUB + 0.5} width={bw - 1} height={ZERO_STUB - 1} rx={1} style={{ ["--i" as string]: i }} />
              )}
              {/* The pointer target never moves: a full-height slot, not the bar. */}
              <rect
                className="bar-hit"
                x={LEFT + i * slot}
                y={TOP - 18}
                width={slot}
                height={base - TOP + 18}
                onPointerEnter={() => setActive(i)}
              />
              {labelled(i) && (
                <text
                  className={endLabel(i) && i === hot ? "today-label" : "axis-label"}
                  x={i === 0 ? LEFT : endLabel(i) ? width - RIGHT : cx(i)}
                  y={height - 4}
                  textAnchor={i === 0 ? "start" : endLabel(i) ? "end" : "middle"}
                >
                  {d.axis}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {peak >= 0 && !calm && (
        <span
          aria-hidden="true"
          className="spark summit"
          style={{ position: "absolute", left: cx(peak) - 9, top: Math.max(0, yOf(data[peak].value) - 28), pointerEvents: "none" }}
        />
      )}
      <ChartTooltip tip={tip} width={width} />
      <span className="sr-only" aria-live="polite">
        {active !== null && data[active] ? `${data[active].title}: ${data[active].valueText} ${data[active].detail}` : ""}
      </span>
    </div>
  );
}
