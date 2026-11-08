import { useRef } from "react";
import type { PointerEvent } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import type { Slide as SlideSpec } from "../../lib/wrappedModel";
import { DayBars, HourBars, RankBars, SplitBar } from "./charts";

const MAX_TILT = 4; // degrees

function Chart({ slide }: { slide: SlideSpec }) {
  const c = slide.chart;
  if (!c) return null;
  switch (c.kind) {
    case "days":
      return <DayBars values={c.values} />;
    case "hours":
      return <HourBars values={c.values} />;
    case "bars":
      return <RankBars rows={c.rows} />;
    case "split":
      return <SplitBar rows={c.rows} />;
  }
}

/** One slide: a kicker, one big figure, one sentence, at most one chart. Used small and large. */
export function SlideView({ slide, size }: { slide: SlideSpec; size: "card" | "story" }) {
  const long = slide.figure.length > 10;
  return (
    <div className="wr-slide" data-tone={slide.tone} data-size={size}>
      <div className="wr-kicker">{slide.kicker}</div>
      <div className="wr-fig d" data-long={long ? "" : undefined} data-pop={slide.celebrate && size === "story" ? "" : undefined}>
        <span>{slide.figure}</span>
        {slide.unit && <span className="wr-unit">{slide.unit}</span>}
      </div>
      <p className="wr-line">{slide.line}</p>
      {slide.chart && size === "story" && (
        <div className="wr-chart">
          <Chart slide={slide} />
        </div>
      )}
      {slide.chart && size === "card" && slide.chart.kind !== "bars" && (
        <div className="wr-chart">
          <Chart slide={slide} />
        </div>
      )}
    </div>
  );
}

/**
 * A slide as a card you can open. The button is a fixed box that owns the click; the face inside
 * tips toward the pointer (at most 4 degrees), so the hit box never moves.
 */
export function SlideCard({ slide, onOpen, index }: { slide: SlideSpec; onOpen: () => void; index: number }) {
  const face = useRef<HTMLDivElement>(null);
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    const el = face.current;
    if (!el || prefersReducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `rotateY(${(x * 2 * MAX_TILT).toFixed(2)}deg) rotateX(${(-y * 2 * MAX_TILT).toFixed(2)}deg)`;
  };
  const leave = () => {
    if (face.current) face.current.style.transform = "";
  };
  return (
    <button
      type="button"
      className="wr-card rise"
      style={{ ["--i" as string]: index + 2 }}
      aria-label={`${slide.kicker}: ${slide.figure}${slide.unit ? ` ${slide.unit}` : ""}. Open the story here.`}
      onClick={onOpen}
      onPointerMove={move}
      onPointerLeave={leave}
      onBlur={leave}
    >
      <div ref={face} className="wr-card-face">
        <SlideView slide={slide} size="card" />
      </div>
    </button>
  );
}
