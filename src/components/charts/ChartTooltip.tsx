import { useLayoutEffect, useRef, useState } from "react";
import { kindRows } from "../../lib/usage";
import type { Readout } from "./shared";

export interface TipAt extends Readout {
  /** Anchor point in the chart's own pixels (the caret points here). */
  x: number;
  y: number;
}

/**
 * The dark three-line tooltip with a caret. It is clamped inside the chart so it never
 * clips at a card edge; the caret keeps pointing at the item. The last content stays while
 * it fades out. Purely visual: screen readers get the sr-only live line the chart renders.
 */
export function ChartTooltip({ tip, width }: { tip: TipAt | null; width: number }) {
  const last = useRef<TipAt | null>(null);
  if (tip) last.current = tip;
  const shown = tip ?? last.current;
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(120);

  useLayoutEffect(() => {
    if (ref.current) setW(ref.current.offsetWidth);
  }, [shown?.title, shown?.valueText, shown?.detail, shown?.kinds]);

  if (!shown) return null;
  const half = w / 2;
  const left = Math.min(Math.max(shown.x, half + 2), Math.max(half + 2, width - half - 2));
  const caret = Math.min(Math.max(half + (shown.x - left), 14), w - 14);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`tip${tip ? " show" : ""}`}
      style={{ left, top: shown.y, ["--caret" as string]: `${caret}px` }}
    >
      <div className="t1">{shown.title}</div>
      <div className="t2 tabular-nums">{shown.valueText}</div>
      {shown.kinds && (
        <div className="t-rows">
          {kindRows(shown.kinds).map((r) => (
            <div key={r.label} className={r.sum ? "t-sum" : undefined}>
              <span>{r.label}</span>
              <span>{r.value}</span>
            </div>
          ))}
        </div>
      )}
      {shown.detail && <div className="t3">{shown.detail}</div>}
    </div>
  );
}
