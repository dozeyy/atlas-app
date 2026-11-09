import { compact } from "../../lib/usage";
import { hourLabel, peakHour, WEEKDAYS, WEEKDAYS_SHORT } from "../../lib/wrappedModel";

const FILL = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--slate)"];

/** Bars on a baseline. The tallest is the accent; the rest sit back. */
function Bars({ values, height, label, gap = 0.25, minH = 2 }: { values: number[]; height: number; label: string; gap?: number; minH?: number }) {
  const n = Math.max(1, values.length);
  const max = Math.max(1, ...values);
  const top = values.indexOf(Math.max(...values));
  const W = 1000;
  const slot = W / n;
  const bw = slot * (1 - gap);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      {values.map((v, i) => {
        const h = v <= 0 ? minH : Math.max(minH + 2, (v / max) * (height - 4));
        return (
          <rect
            key={i}
            className="wr-bar"
            data-peak={i === top && v > 0 ? "" : undefined}
            data-zero={v <= 0 ? "" : undefined}
            x={i * slot + (slot - bw) / 2}
            y={height - h}
            width={bw}
            height={h}
            rx={Math.min(6, bw / 2)}
            style={{ ["--i" as string]: i }}
          />
        );
      })}
    </svg>
  );
}

/** Tokens per day across the whole span. */
export function DayBars({ values, height = 72 }: { values: number[]; height?: number }) {
  const total = values.reduce((a, b) => a + b, 0);
  return <Bars values={values} height={height} gap={values.length > 60 ? 0.1 : 0.3} label={`Tokens per day, ${compact(total)} in all`} />;
}

/** Tokens by hour of day, with a few hour marks underneath. */
export function HourBars({ values, height = 96 }: { values: number[]; height?: number }) {
  const peak = peakHour(values);
  return (
    <div>
      <Bars values={values} height={height} label={peak === null ? "Tokens by hour of day" : `Tokens by hour of day, busiest around ${hourLabel(peak)}`} />
      <div className="mt-1 flex justify-between text-caption text-ink-2" aria-hidden="true">
        <span>12 AM</span>
        <span>6 AM</span>
        <span>12 PM</span>
        <span>6 PM</span>
        <span>11 PM</span>
      </div>
    </div>
  );
}

/** Tokens by weekday, Monday first, the busiest one in the accent. */
export function WeekdayBars({ values, height = 96 }: { values: number[]; height?: number }) {
  const top = values.indexOf(Math.max(...values));
  return (
    <div>
      <Bars values={values} height={height} gap={0.4} label={`Tokens by weekday, busiest on ${WEEKDAYS[top] ?? "none"}`} />
      <div className="mt-1 grid grid-cols-7 text-center text-caption text-ink-2" aria-hidden="true">
        {WEEKDAYS_SHORT.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * A countdown: the list reads 1 to 5 top to bottom, and it arrives 5 first, 1 last, so the favorite
 * lands at the end. With reduced motion the rows only fade in.
 */
export function Countdown({ rows }: { rows: { label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="wr-count" aria-label={`Top ${rows.length}, ranked`}>
      {rows.map((r, i) => (
        <li key={r.label} data-first={i === 0 ? "" : undefined} style={{ ["--r" as string]: rows.length - 1 - i }}>
          <span className="wr-rank d" aria-hidden="true">
            {i + 1}
          </span>
          <span className="truncate text-body font-medium text-ink">{r.label}</span>
          <span className="text-caption text-ink-2">{r.note ?? compact(r.value)}</span>
          <span className="share-bar wr-count-bar" aria-hidden="true">
            <i style={{ width: `${Math.max(3, (r.value / max) * 100)}%`, background: i === 0 ? "var(--accent)" : "var(--ink-2)" }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** A short ranked list with a bar behind each name. */
export function RankBars({ rows }: { rows: { label: string; value: number; note?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ol className="m-0 flex list-none flex-col gap-2.5 p-0" aria-label="Ranked">
      {rows.map((r, i) => (
        <li key={r.label} className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1">
          <span className="truncate text-body font-medium text-ink">{r.label}</span>
          <span className="text-caption text-ink-2">{r.note ?? compact(r.value)}</span>
          <span className="share-bar col-span-2" aria-hidden="true">
            <i style={{ width: `${Math.max(3, (r.value / max) * 100)}%`, ["--i" as string]: i, background: i === 0 ? "var(--accent)" : "var(--ink-2)" }} />
          </span>
        </li>
      ))}
    </ol>
  );
}

/** One bar cut into shares, with the names under it. */
export function SplitBar({ rows }: { rows: { label: string; value: number }[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <div>
      <div className="wr-split" role="img" aria-label={rows.map((r) => `${r.label} ${Math.round((r.value / total) * 100)}%`).join(", ")}>
        {rows.map((r, i) => (
          <i key={r.label} style={{ flexGrow: r.value, background: FILL[i % FILL.length], ["--i" as string]: i }} />
        ))}
      </div>
      <ul className="m-0 mt-3 flex list-none flex-wrap gap-x-5 gap-y-1.5 p-0">
        {rows.map((r, i) => (
          <li key={r.label} className="flex min-w-0 items-center gap-2 text-body text-ink">
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ background: FILL[i % FILL.length] }} />
            <span className="truncate">{r.label}</span>
            <span className="text-ink-2">{Math.round((r.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
