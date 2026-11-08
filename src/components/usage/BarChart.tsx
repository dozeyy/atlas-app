import { useState } from "react";
import type { KeyboardEvent } from "react";
import { niceMax } from "../../lib/usage";

export interface BarDatum {
  key: string;
  value: number;
  /** Short x-axis label, shown on some bars only. */
  axis: string;
  /** Readout heading when this bar is hovered or focused. */
  title: string;
  /** Readout headline, already formatted. */
  valueText: string;
  /** Readout detail line. */
  detail: string;
}

export interface Readout {
  title: string;
  valueText: string;
  detail: string;
}

/**
 * One series of vertical bars, hand-drawn in HTML so it scales with the card.
 * Hover (or the arrow keys) moves a readout above the plot; the bar under it keeps the
 * accent and the others step back. Zero buckets keep a hairline so gaps read as "none".
 */
export function BarChart({
  data,
  fallback,
  formatTick,
  label,
  height = 168,
}: {
  data: BarDatum[];
  /** What the readout says when nothing is hovered (the range total). */
  fallback: Readout;
  formatTick: (v: number) => string;
  label: string;
  height?: number;
}) {
  const [active, setActive] = useState<number | null>(null);
  const n = data.length;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const step = Math.max(1, Math.ceil(n / 6));
  const shown = active !== null && data[active] ? data[active] : null;
  const readout: Readout = shown ?? fallback;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const at = active ?? (e.key === "ArrowLeft" ? n : -1);
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(n - 1, at + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    setActive(next);
  };

  return (
    <div>
      <div className="mb-3 min-h-[52px]" aria-live="off" data-testid="chart-readout">
        <div className="text-caption text-ink-2">{readout.title}</div>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-title font-semibold tabular-nums text-ink">{readout.valueText}</span>
          <span className="text-body text-ink-2">{readout.detail}</span>
        </div>
      </div>

      <div className="flex gap-2">
        <div
          aria-hidden="true"
          className="flex w-10 shrink-0 flex-col justify-between text-right text-caption tabular-nums text-ink-2"
          style={{ height }}
        >
          <span className="-mt-2">{formatTick(max)}</span>
          <span>{formatTick(max / 2)}</span>
          <span className="-mb-2">0</span>
        </div>

        <div className="min-w-0 flex-1">
          <div
            role="group"
            aria-label={`${label}. Use the left and right arrow keys to read each bar.`}
            tabIndex={0}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
            onMouseLeave={() => setActive(null)}
            className="relative rounded-control outline-offset-4"
            style={{ height }}
          >
            {[0, 0.5, 1].map((f) => (
              <div
                key={f}
                aria-hidden="true"
                className="absolute inset-x-0 border-t border-line"
                style={{ top: `${(1 - f) * 100}%` }}
              />
            ))}
            <div className="absolute inset-0 flex items-end gap-[2px]">
              {data.map((d, i) => {
                const h = (d.value / max) * 100;
                const dim = active !== null && active !== i;
                return (
                  <div
                    key={d.key}
                    className="flex h-full min-w-0 flex-1 cursor-default items-end"
                    onMouseEnter={() => setActive(i)}
                  >
                    {d.value > 0 ? (
                      <div
                        className="w-full rounded-t-[4px] bg-accent"
                        style={{
                          height: `max(${h}%, 2px)`,
                          opacity: dim ? 0.45 : 1,
                          transition: "opacity var(--dur-fast) var(--ease-out)",
                        }}
                      />
                    ) : (
                      <div className="h-px w-full bg-line-strong" style={{ opacity: dim ? 0.5 : 1 }} />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          <div aria-hidden="true" className="mt-1.5 flex gap-[2px] text-caption text-ink-2">
            {data.map((d, i) => (
              <div key={d.key} className="relative h-4 min-w-0 flex-1">
                {i % step === 0 && <span className="absolute left-0 whitespace-nowrap">{d.axis}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
