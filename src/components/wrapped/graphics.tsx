// The one graphic a Summit slide may carry. Each is hand-drawn SVG from real numbers: a day is a
// cell, an hour or a weekday a bar, a chat a circle. Nothing here is decoration, nothing overlaps,
// and every colour is a token (summit.css). They draw once when the slide arrives (CSS only).

import { addDays, compact } from "../../lib/usage";
import { barTop, heatLayout, ZERO_STUB } from "../../lib/chartPaths";
import { hourLabel, longDay, WEEKDAYS_SHORT, weekdayTied } from "../../lib/wrappedModel";
import type { SlideGraphic } from "../../lib/wrappedModel";

/** The four-point clay spark: planted on a peak, and the trail's "you are here". Unit size 1. */
export const SPARK = "M0-1Q.16-.16 1 0Q.16 .16 0 1Q-.16 .16-1 0Q-.16-.16 0-1Z";

/** The spark's radius, how far its centre floats above the bar it marks, and the room a chart must keep
 * above its tallest bar so the whole spark (and the spring's overshoot while it pops in) is inside the
 * SVG. A chart sets its top from SPARK_HEAD instead of nudging one number, so a bar at 100 % never clips. */
export const SPARK_SIZE = 11;
export const SPARK_LIFT = 20;
export const SPARK_HEAD = SPARK_LIFT + Math.ceil(SPARK_SIZE * 1.25) + 3;

export function Spark({
  x,
  y,
  size,
  delay = 0,
}: {
  x: number;
  y: number;
  size: number;
  delay?: number;
}) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path
        className="sm-spark"
        d={SPARK}
        transform={`scale(${size})`}
        style={{ animationDelay: `${delay}ms` }}
      />
    </g>
  );
}

/** The width the calendar may take beside the words. */
const HEAT_W = 470;
/** Room around the grid so the rings on the edge cells and the end of a label are not cut off. */
const HEAT_PAD = 4;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function dateOf(to: string, back: number): string {
  return addDays(to, -back);
}

function HeatArt({ g }: { g: Extract<SlideGraphic, { kind: "heat" }> }) {
  const n = g.values.length;
  // The first column is padded at the top so today is the bottom-right cell (heatLayout).
  const weeks = Math.max(1, Math.ceil(n / 7));
  // Biggest cell that lets every week fit the width (26 px steps in the mockup at 18 weeks). A short
  // history gets larger cells, up to 34 px, so a few weeks do not sit as a small patch in the corner.
  const step = Math.max(10, Math.min(34, Math.floor(HEAT_W / weeks)));
  const gap = Math.max(3, Math.round(step * 0.23));
  const cell = step - gap;
  const lay = heatLayout(g.values, cell, gap, 0);
  const top = 24;
  const run = g.run;
  const labels: { x: number; text: string }[] = [];
  let lastMonth = -1;
  lay.cells.forEach((c) => {
    const date = dateOf(g.to, n - 1 - c.index);
    const month = Number(date.slice(5, 7)) - 1;
    // A month is named where its first full column starts: the first cell of a column in a new month.
    if (month !== lastMonth && c.row <= 1) {
      lastMonth = month;
      labels.push({ x: c.x, text: MONTHS[month] });
    }
  });
  const last = lay.todayCell;
  const height = top + lay.height + 26;
  return (
    <svg
      className="sm-art"
      width={lay.width + 2 * HEAT_PAD}
      height={height}
      viewBox={`${-HEAT_PAD} 0 ${lay.width + 2 * HEAT_PAD} ${height}`}
      role="img"
      aria-label="Your active days, week by week"
    >
      {labels.map((l) => (
        <text key={l.x} className="sm-cap" x={l.x} y={12}>
          {l.text}
        </text>
      ))}
      <g transform={`translate(0 ${top})`}>
        {lay.cells.map((c) => {
          const v = g.values[c.index];
          const date = dateOf(g.to, n - 1 - c.index);
          return (
            <rect
              key={c.index}
              className="sm-cell"
              data-band={c.band}
              x={c.x}
              y={c.y}
              width={cell}
              height={cell}
              rx={Math.max(3, Math.round(cell / 4))}
              style={{ animationDelay: `${c.col * 14}ms` }}
              data-tip={`${longDay(date)}\n${v > 0 ? `${compact(v)} tokens` : "No usage"}`}
            />
          );
        })}
        {run &&
          lay.cells
            .slice(run[0], run[1] + 1)
            .map((c) => (
              <rect
                key={`r${c.index}`}
                className="sm-ring"
                x={c.x - 1.5}
                y={c.y - 1.5}
                width={cell + 3}
                height={cell + 3}
                rx={Math.max(3, Math.round(cell / 4)) + 1.5}
                style={{ animationDelay: `${520 + (c.index - run[0]) * 28}ms` }}
                pointerEvents="none"
              />
            ))}
        {last && (
          <text
            className="sm-cap"
            x={last.x + cell}
            y={lay.height + 20}
            textAnchor="end"
          >
            Today
          </text>
        )}
      </g>
    </svg>
  );
}

function bars(
  values: number[],
  max: number,
  base: number,
  top: number,
  w: number,
  gap: number,
  x0: number,
) {
  return values.map((v, i) => {
    const y = v > 0 ? barTop(v, max, base, top) : base - ZERO_STUB;
    return { v, i, x: x0 + i * (w + gap), y, h: base - y };
  });
}

function HoursArt({ g }: { g: Extract<SlideGraphic, { kind: "hours" }> }) {
  const max = Math.max(...g.values, 0);
  const w = 14;
  const gap = 4;
  const base = 236;
  const bs = bars(g.values, max, base, SPARK_HEAD, w, gap, 12);
  const width = 12 + 24 * (w + gap) + 6; // the right 6 are the peak spark's room when the peak is 11 PM
  const pk = bs[g.peak];
  return (
    <svg
      className="sm-art"
      width={width}
      height={290}
      viewBox={`0 0 ${width} 290`}
      role="img"
      aria-label="Your tokens by hour of the day"
    >
      {bs.map((b) => (
        <rect
          key={b.i}
          className="sm-bar"
          data-peak={b.i === g.peak ? "" : undefined}
          data-zero={b.v > 0 ? undefined : ""}
          x={b.x}
          y={b.y}
          width={w}
          height={b.h}
          rx={4}
          style={{ animationDelay: `${b.i * 16}ms` }}
          // A hover only when it has a number to give: an hour with next to nothing says nothing.
          data-tip={
            b.v / g.days >= 1
              ? `${hourLabel(b.i)}\n${compact(Math.round(b.v / g.days))} tokens a day on average`
              : undefined
          }
        />
      ))}
      <Spark x={pk.x + w / 2} y={pk.y - SPARK_LIFT} size={SPARK_SIZE} delay={520} />
      <line
        className="sm-axis"
        x1={8}
        x2={width}
        y1={base + 0.5}
        y2={base + 0.5}
      />
      {[0, 6, 12, 18].map((i) => [hourLabel(i), i] as const).map(([t, i]) => (
        <text key={t} className="sm-cap" x={12 + i * (w + gap)} y={base + 24}>
          {t}
        </text>
      ))}
      {/* The axis is named to its end: the last bar is the 11 PM hour, its label ends where the bar does. */}
      <text className="sm-cap" x={12 + 23 * (w + gap) + w} y={base + 24} textAnchor="end">
        {hourLabel(23)}
      </text>
    </svg>
  );
}

function WeekdaysArt({
  g,
}: {
  g: Extract<SlideGraphic, { kind: "weekdays" }>;
}) {
  const max = Math.max(...g.values, 0);
  const tied = weekdayTied(g.values);
  const w = 64;
  const gap = 28;
  const base = 128; // the total height stays 162: the bars give up the spark's headroom, the SVG does not grow
  const bs = bars(g.values, max, base, SPARK_HEAD, w, gap, 4);
  const width = 4 + 7 * w + 6 * gap + 4;
  return (
    <svg
      className="sm-art"
      width={width}
      height={base + 34}
      viewBox={`0 0 ${width} ${base + 34}`}
      role="img"
      aria-label="Your tokens by weekday"
    >
      {bs.map((b) => (
        <rect
          key={b.i}
          className="sm-bar"
          data-peak={tied.includes(b.i) && max > 0 ? "" : undefined}
          data-zero={b.v > 0 ? undefined : ""}
          x={b.x}
          y={b.y}
          width={w}
          height={b.h}
          rx={8}
          style={{ animationDelay: `${b.i * 40}ms` }}
        />
      ))}
      {bs.map(
        (b) =>
          b.v === max &&
          max > 0 && (
            <Spark
              key={`s${b.i}`}
              x={b.x + w / 2}
              y={b.y - SPARK_LIFT}
              size={SPARK_SIZE}
              delay={420}
            />
          ),
      )}
      <line
        className="sm-axis"
        x1={0}
        x2={width}
        y1={base + 0.5}
        y2={base + 0.5}
      />
      {bs.map((b) => (
        <text
          key={`t${b.i}`}
          className="sm-cap"
          x={b.x + w / 2}
          y={base + 24}
          textAnchor="middle"
        >
          {WEEKDAYS_SHORT[b.i]}
        </text>
      ))}
    </svg>
  );
}

function SpikeArt({ g }: { g: Extract<SlideGraphic, { kind: "spike" }> }) {
  const max = Math.max(...g.values, 0);
  const w = 20;
  const gap = 9;
  const base = 128; // the total height stays 162: the bars give up the spark's headroom, the SVG does not grow
  const bs = bars(g.values, max, base, SPARK_HEAD, w, gap, 4);
  const width = 4 + g.values.length * w + (g.values.length - 1) * gap + 4;
  const pk = bs[g.peak];
  return (
    <svg
      className="sm-art"
      width={width}
      height={base + 34}
      viewBox={`0 0 ${width} ${base + 34}`}
      role="img"
      aria-label="The days around your busiest day"
    >
      {bs.map((b) => (
        <rect
          key={b.i}
          className="sm-bar"
          data-peak={b.i === g.peak ? "" : undefined}
          data-zero={b.v > 0 ? undefined : ""}
          x={b.x}
          y={b.y}
          width={w}
          height={b.h}
          rx={5}
          style={{ animationDelay: `${b.i * 22}ms` }}
        />
      ))}
      <Spark x={pk.x + w / 2} y={pk.y - SPARK_LIFT} size={SPARK_SIZE} delay={520} />
      <line
        className="sm-axis"
        x1={0}
        x2={width}
        y1={base + 0.5}
        y2={base + 0.5}
      />
      <text className="sm-cap" x={4} y={base + 24}>
        {g.first}
      </text>
      <text className="sm-cap" x={width - 4} y={base + 24} textAnchor="end">
        {g.last}
      </text>
    </svg>
  );
}

/** Two circles with areas in the true ratio: the big one is this chat, the small one a usual chat. */
function CirclesArt({ g }: { g: Extract<SlideGraphic, { kind: "circles" }> }) {
  const R = 89;
  const r = Math.max(4, R / Math.sqrt(g.ratio));
  const floor = 261;
  return (
    <svg
      className="sm-art"
      width={330}
      height={300}
      viewBox="0 0 330 300"
      role="img"
      aria-label="This session next to a usual session, drawn to scale"
    >
      <circle className="sm-dot-usual" cx={44} cy={floor - r} r={r} />
      <text className="sm-cap" x={44} y={286} textAnchor="middle">
        A usual session
      </text>
      <circle className="sm-dot-big" cx={220} cy={floor - R} r={R} />
      <text className="sm-cap" x={220} y={286} textAnchor="middle">
        This one
      </text>
    </svg>
  );
}

export function Graphic({ g }: { g: SlideGraphic }) {
  switch (g.kind) {
    case "heat":
      return <HeatArt g={g} />;
    case "hours":
      return <HoursArt g={g} />;
    case "weekdays":
      return <WeekdaysArt g={g} />;
    case "spike":
      return <SpikeArt g={g} />;
    case "circles":
      return <CirclesArt g={g} />;
  }
}
