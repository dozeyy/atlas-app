import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import { slideLayout } from "../../lib/wrappedModel";
import type { Slide, SlideLayout } from "../../lib/wrappedModel";
import { CardView } from "./CardSlide";
import { countCells, parseCount, formatCount } from "./count";
import { Graphic } from "./graphics";

/** The design frame every slide is laid out in; the story scales it to the sheet (Story.tsx). */
export const FRAME_W = 1008;
export const FRAME_H = 625;

/** Largest hero size (px) and the width it may take, per layout. */
function figureBox(layout: SlideLayout, text: string): { max: number; avail: number } {
  const short = Array.from(text).length <= 6;
  switch (layout) {
    case "opener":
      return { max: 236, avail: 860 };
    case "split":
      return { max: short ? 176 : 120, avail: 430 };
    case "stack":
      return { max: 140, avail: 860 };
    default:
      return { max: short ? 236 : 128, avail: 860 };
  }
}

const MIN_FIGURE_PX = 56;
const COUNT_MS = 800;
const COUNT_DELAY_MS = 140;

/** The text a counting figure shows now, or null when it is not counting (a name, a year, reduced motion). */
function useCountUp(text: string, on: boolean): string | null {
  const parts = parseCount(text);
  const run = on && parts !== null && !prefersReducedMotion();
  const [k, setK] = useState(run ? 0 : 1);
  useEffect(() => {
    if (!run) {
      setK(1);
      return;
    }
    let raf = 0;
    const t0 = performance.now() + COUNT_DELAY_MS;
    const tick = (now: number) => {
      const p = Math.max(0, Math.min(1, (now - t0) / COUNT_MS));
      // Ease-out expo: most of the climb is early, the last digits settle.
      setK(p >= 1 ? 1 : 1 - Math.pow(2, -10 * p));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    setK(0);
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [run, text]);
  if (!run || !parts || k >= 0.9995) return null;
  return countCells(text, k)
    .join("")
    .replace(/^$/, formatCount(0, parts));
}

/** What a screen reader says for the hero: the figure, its unit and the hover. */
export function figureLabel(s: Pick<Slide, "figure" | "unit" | "hint">): string {
  return [[s.figure, s.unit].filter(Boolean).join(" "), s.hint].filter(Boolean).join(". ");
}

/**
 * The hero: Recursive, as big as its box allows. A long name shrinks to fit (one proportional
 * step: width is linear in font size), and a number counts up inside a box that is already its
 * final size, so nothing around it moves.
 */
function Figure({
  slide,
  layout,
  animate,
}: {
  slide: Slide;
  layout: SlideLayout;
  animate: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const { max, avail } = figureBox(layout, slide.figure);
  const live = useCountUp(slide.figure, animate);

  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    const fit = () => {
      node.style.fontSize = `${max}px`;
      const w = node.offsetWidth;
      if (w > avail) node.style.fontSize = `${Math.max(MIN_FIGURE_PX, Math.floor((max * avail) / w))}px`;
    };
    fit();
    // The face loads after the first paint on a cold start: measure again once it is in.
    let live = true;
    void document.fonts?.ready.then(() => live && fit());
    return () => {
      live = false;
    };
  }, [max, avail, slide.figure, slide.unit]);

  return (
    <div
      ref={el}
      className="sm-fig"
      data-layout={layout}
      title={slide.hint}
      // The hover is the exact count; a keyboard or screen reader person gets it from the label.
      tabIndex={slide.hint ? 0 : undefined}
      aria-label={slide.hint ? figureLabel(slide) : undefined}
    >
      <span className="sm-fig-num">
        {live === null ? (
          slide.figure
        ) : (
          <>
            <span className="sm-ghost">{slide.figure}</span>
            <span className="sm-live" aria-hidden="true">
              {live}
            </span>
          </>
        )}
      </span>
      {slide.unit && <span className="sm-unit">{slide.unit}</span>}
    </div>
  );
}

/** The one short line, with its bold phrase set apart (and its hover, if the phrase has a source). */
function Line({ slide }: { slide: Slide }) {
  const { line, strong, strongHint } = slide;
  if (!line) return null;
  const at = strong ? line.indexOf(strong) : -1;
  if (!strong || at < 0) return <p className="sm-line">{line}</p>;
  return (
    <p className="sm-line">
      {line.slice(0, at)}
      <strong title={strongHint}>{strong}</strong>
      {line.slice(at + strong.length)}
    </p>
  );
}

/**
 * One slide of the story, laid out in the fixed design frame: kicker, hero, one line, and at most one
 * graphic. `settled` is the picture without its entrance (the slide that is leaving, and tests).
 */
export function SlideView({ slide, settled = false }: { slide: Slide; settled?: boolean }) {
  const layout = slideLayout(slide);
  const animate = !settled;
  if (layout === "card") return <CardView slide={slide} settled={settled} />;
  if (layout === "opener") {
    return (
      <div className="sm-frame" data-slide={slide.id} data-layout={layout} data-settled={settled ? "" : undefined}>
        <div className="sm-center">
          <p className="sm-year" title={slide.hint}>
            {slide.figure}
          </p>
          <h2 className="sm-title">{slide.title}</h2>
          <p className="sm-range">{slide.line}</p>
        </div>
      </div>
    );
  }
  const words = (
    <>
      <p className="sm-kicker">{slide.kicker}</p>
      <Figure slide={slide} layout={layout} animate={animate} />
      <Line slide={slide} />
    </>
  );
  return (
    <div className="sm-frame" data-slide={slide.id} data-layout={layout} data-settled={settled ? "" : undefined}>
      {layout === "split" ? (
        <>
          <div className="sm-col">{words}</div>
          {slide.graphic && <Graphic g={slide.graphic} />}
        </>
      ) : layout === "stack" ? (
        <div className="sm-stack">
          <div className="sm-stack-words">{words}</div>
          {slide.graphic && <Graphic g={slide.graphic} />}
        </div>
      ) : (
        <div className="sm-center">{words}</div>
      )}
    </div>
  );
}
