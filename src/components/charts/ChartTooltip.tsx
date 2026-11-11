import { useLayoutEffect, useRef, useState } from "react";
import { kindRows } from "../../lib/usage";
import type { Readout } from "./shared";

export interface TipAt extends Readout {
  /** Anchor point in the chart's own pixels (the caret points here). */
  x: number;
  y: number;
  /** Where the caret points when the tip has to open below: under the item, so the point or
   *  the whole box stays in view. */
  yBelow: number;
}

const GAP = 10; // between the point and the tip (matches the CSS offset)
const EDGE = 8; // the tip never gets closer than this to the top of the page area

/** The top edge a tip must stay below: the scrolling page area it sits in, else the window. */
function ceiling(el: HTMLElement): number {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === "auto" || oy === "scroll" || oy === "hidden") {
      const top = p.getBoundingClientRect().top;
      if (oy !== "hidden" || p.scrollHeight > p.clientHeight) return Math.max(0, top);
    }
  }
  return 0;
}

/**
 * The dark three-line tooltip with a caret. It is clamped inside the chart so it never
 * clips at a card edge; the caret keeps pointing at the item. It sits above the item, and
 * flips below it when the top of the page area would cut it off. The last content stays while
 * it fades out. Purely visual: screen readers get the sr-only live line the chart renders.
 */
export function ChartTooltip({ tip, width }: { tip: TipAt | null; width: number }) {
  const last = useRef<TipAt | null>(null);
  if (tip) last.current = tip;
  const shown = tip ?? last.current;
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(120);
  const [below, setBelow] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !shown) return;
    setW(el.offsetWidth);
    const host = el.offsetParent as HTMLElement | null;
    const pointTop = (host?.getBoundingClientRect().top ?? 0) + shown.y;
    setBelow(pointTop - GAP - el.offsetHeight < ceiling(el) + EDGE);
  }, [shown, shown?.title, shown?.valueText, shown?.detail, shown?.kinds, shown?.x, shown?.y]);

  if (!shown) return null;
  const half = w / 2;
  const left = Math.min(Math.max(shown.x, half + 2), Math.max(half + 2, width - half - 2));
  const caret = Math.min(Math.max(half + (shown.x - left), 14), w - 14);
  return (
    <div
      ref={ref}
      aria-hidden="true"
      className={`tip${tip ? " show" : ""}${below ? " below" : ""}`}
      style={{ left, top: below ? shown.yBelow : shown.y, ["--caret" as string]: `${caret}px` }}
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
