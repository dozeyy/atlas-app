import { useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import { heatLayout } from "../../lib/chartPaths";
import { useIntro } from "../../lib/motion";
import { ChartTooltip } from "./ChartTooltip";
import type { TipAt } from "./ChartTooltip";
import { stepIndex } from "./shared";
import type { Readout } from "./shared";

const CELL = 13;
const GAP = 4;
const LABEL_ROOM = 20;

/**
 * The streak grid: rolling weeks, oldest top-left, today the bottom-right cell with a
 * "Today" label under it. Colour is five bands cut at 20/45/70/90 % of your active days. A
 * run of consecutive active days ending today (or yesterday) wears a clay ring; today's ring
 * is the heavier one. Keyboard: Left/Right step a day, Up/Down a row.
 */
export function HeatGrid({
  id,
  values,
  readouts,
  label,
}: {
  id: string;
  /** Daily activity, oldest first, the last entry is today. */
  values: number[];
  /** One readout per day, same order. */
  readouts: Readout[];
  label: string;
}) {
  const intro = useIntro(id);
  const [active, setActive] = useState<number | null>(null);
  const n = values.length;
  const layout = useMemo(() => heatLayout(values, CELL, GAP, 0), [values]);
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
    <div
      role="group"
      aria-label={`${label}. ${layout.streak > 0 ? `${layout.streak} days in a row.` : "No streak right now."} Use the arrow keys to read each day.`}
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
          {`${Math.round(n / 7)} weeks ago`}
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
  );
}
