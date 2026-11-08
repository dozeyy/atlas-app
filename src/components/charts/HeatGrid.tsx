import { useMemo, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { heatLayout } from "../../lib/chartPaths";
import { useIntro } from "../../lib/motion";
import { ChartTooltip } from "./ChartTooltip";
import type { TipAt } from "./ChartTooltip";
import { stepIndex, useWidth } from "./shared";
import type { Readout } from "./shared";

const GAP = 4;
const LABEL_ROOM = 20;
/** The cell size the grid aims for; it flexes a little so the grid meets both edges. */
export const HEAT_CELL = 13;
const MAX_CELL = 18;
export const MIN_WEEKS = 12;
export const MAX_WEEKS = 52;

/** How many whole weeks fit in `width`: at least MIN_WEEKS, at most a year. */
export function heatWeeks(width: number): number {
  return Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, Math.floor((width + GAP) / (HEAT_CELL + GAP))));
}

/** The cell edge that makes `weeks` columns fill `width` (13 to 18 px). */
export function heatCell(width: number, weeks: number): number {
  return Math.max(HEAT_CELL - 3, Math.min(MAX_CELL, Math.floor((width + GAP) / weeks - GAP)));
}

/**
 * The streak grid: rolling weeks, oldest top-left, today the bottom-right cell with a
 * "Today" label under it. Colour is five bands cut at 20/45/70/90 % of your active days. A
 * run of consecutive active days ending today (or yesterday) wears a clay ring; today's ring
 * is the heavier one. Keyboard: Left/Right step a day, Up/Down a row.
 */
export function HeatGrid({
  id,
  values: allValues,
  readouts: allReadouts,
  label,
  footer,
}: {
  id: string;
  /** Daily activity, oldest first, the last entry is today. Give it a year; the grid shows what fits. */
  values: number[];
  /** One readout per day, same order. */
  readouts: Readout[];
  /** Says what the grid shows; the week count is added. */
  label: string;
  /** Rendered under the grid with the number of weeks on show. */
  footer?: (weeks: number) => ReactNode;
}) {
  const intro = useIntro(id);
  const [active, setActive] = useState<number | null>(null);
  const [roomRef, room] = useWidth<HTMLDivElement>();
  const weeks = Math.min(heatWeeks(room), Math.max(MIN_WEEKS, Math.ceil(allValues.length / 7)));
  const values = useMemo(() => allValues.slice(-weeks * 7), [allValues, weeks]);
  const readouts = useMemo(() => allReadouts.slice(-weeks * 7), [allReadouts, weeks]);
  const CELL = heatCell(room, weeks);
  const n = values.length;
  const layout = useMemo(() => heatLayout(values, CELL, GAP, 0), [values, CELL]);
  const height = layout.height + LABEL_ROOM;
  const width = layout.width;
  const streakFrom = n - layout.streak - (layout.streakIncludesToday ? 0 : 1);

  const inStreak = (i: number) => layout.streak > 0 && i > streakFrom && i <= (layout.streakIncludesToday ? n - 1 : n - 2);

  const tip: TipAt | null =
    active !== null && layout.cells[active] && readouts[active]
      ? { x: layout.cells[active].x + CELL / 2, y: layout.cells[active].y - 6, ...readouts[active] }
      : null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepIndex(e.key, active, n, 7);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <div ref={roomRef} className="w-full">
    <div
      role="group"
      aria-label={`${label}, last ${weeks} weeks. ${layout.streak > 0 ? `${layout.streak} days in a row.` : "No streak right now."} Use the arrow keys to read each day.`}
      tabIndex={0}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
      onPointerLeave={() => setActive(null)}
      className={`chart-wrap inline-block max-w-full${intro ? " intro" : ""}`}
      style={{ width }}
    >
      <svg className="chart" width={width} height={height} aria-hidden="true">
        {layout.cells.map((c) => (
          <rect
            key={c.index}
            className={`cell${active === c.index ? " on" : ""}`}
            x={c.x}
            y={c.y}
            width={CELL}
            height={CELL}
            rx={3.5}
            style={{ fill: `var(--heat-${c.band})`, ["--c" as string]: c.col }}
            onPointerEnter={() => setActive(c.index)}
          />
        ))}
        {layout.cells.map((c) =>
          inStreak(c.index) ? (
            <rect
              key={`r${c.index}`}
              className={`streak-ring${c.index === n - 1 ? " today" : ""}`}
              x={c.x - 1.5}
              y={c.y - 1.5}
              width={CELL + 3}
              height={CELL + 3}
              rx={4.5}
            />
          ) : null,
        )}
        <text className="axis-label" x={0} y={layout.height + 15}>
          {`${weeks} weeks ago`}
        </text>
        <text className="today-label" x={width} y={layout.height + 15} textAnchor="end">
          Today
        </text>
      </svg>
      <ChartTooltip tip={tip} width={width} />
      <span className="sr-only" aria-live="polite">
        {active !== null && readouts[active] ? `${readouts[active].title}: ${readouts[active].valueText}` : ""}
      </span>
    </div>
    {footer?.(weeks)}
    </div>
  );
}
