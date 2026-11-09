import type { CSSProperties } from "react";
import type { Slide as SlideSpec } from "../../lib/wrappedModel";
import { CardSlide } from "./CardSlide";
import { Countdown, DayBars, HourBars, RankBars, SplitBar, WeekdayBars } from "./charts";
import { Celebration, Num, parseCount, Words } from "./motion";

function Chart({ slide }: { slide: SlideSpec }) {
  const c = slide.chart;
  if (!c) return null;
  switch (c.kind) {
    case "days":
      return <DayBars values={c.values} />;
    case "hours":
      return <HourBars values={c.values} />;
    case "weekdays":
      return <WeekdayBars values={c.values} />;
    case "bars":
      return <RankBars rows={c.rows} />;
    case "countdown":
      return <Countdown rows={c.rows} />;
    case "split":
      return <SplitBar rows={c.rows} />;
  }
}

/** How a figure that is not a plain number arrives. They take turns down the story. */
const FIGURE_FX = ["slam", "drop", "tilt"] as const;

/** Countdown timing (ms): first row, gap between rows, and the held breath before number one. */
export const COUNT_FIRST = 640;
export const COUNT_STEP = 460;
export const COUNT_BEAT = 420;

/**
 * When the big figure lands. Most slides: right away. The coder type waits behind a drumroll, and
 * the top skills wait for the countdown to reach number one.
 */
export function figureDelay(slide: SlideSpec): number {
  if (slide.id === "type") return 1500;
  if (slide.chart?.kind === "countdown") return COUNT_FIRST + (slide.chart.rows.length - 1) * COUNT_STEP + COUNT_BEAT + 120;
  return 140;
}

/** One slide: a kicker, one big figure, one sentence, at most one chart. The last is the card. */
export function SlideView({ slide, index, lead = 0 }: { slide: SlideSpec; index: number; lead?: number }) {
  // `lead` holds every entrance back while a curtain is still sweeping across.
  const style = {
    "--fd": `${figureDelay(slide)}ms`,
    "--t0": `${lead}ms`,
    "--cf": `${COUNT_FIRST}ms`,
    "--cs": `${COUNT_STEP}ms`,
    "--cb": `${COUNT_BEAT}ms`,
  } as CSSProperties;
  if (slide.card) {
    return (
      <div className="wr-slide" data-tone={slide.tone} style={style}>
        <div className="wr-kicker wr-in" style={{ "--s": 0 } as CSSProperties}>
          {slide.kicker}
        </div>
        <CardSlide card={slide.card} note={slide.line} />
        <Celebration />
      </div>
    );
  }
  const long = slide.figure.length > 10;
  const counts = parseCount(slide.figure) !== null;
  const fx = counts ? "count" : FIGURE_FX[index % FIGURE_FX.length];
  const delay = figureDelay(slide) + lead;
  return (
    <div className="wr-slide" data-tone={slide.tone} data-slide={slide.id} style={style}>
      <div className="wr-kicker wr-in" style={{ "--s": 0 } as CSSProperties}>
        {slide.kicker}
      </div>
      <div className="wr-figwrap">
        {slide.id === "type" && (
          <div className="wr-drum" aria-hidden="true">
            <span>And you are</span>
            <i />
            <i />
            <i />
          </div>
        )}
        <div
          className="wr-fig d"
          data-fx={fx}
          data-long={long ? "" : undefined}
          data-pop={slide.celebrate ? "" : undefined}
          title={slide.hint}
          tabIndex={slide.hint ? 0 : undefined}
        >
          {counts ? <Num text={slide.figure} delay={delay} /> : <span>{slide.figure}</span>}
          {slide.unit && <span className="wr-unit">{slide.unit}</span>}
        </div>
      </div>
      <p className="wr-line">
        <Words text={slide.line} />
      </p>
      {slide.aside && (
        <p className="wr-aside wr-in" style={{ "--s": 7 } as CSSProperties} title={slide.aside.hint} tabIndex={0}>
          {slide.aside.text}
        </p>
      )}
      {slide.chart && (
        <div className="wr-chart wr-in" data-count={slide.chart.kind === "countdown" ? "" : undefined} style={{ "--s": 5 } as CSSProperties}>
          <Chart slide={slide} />
        </div>
      )}
    </div>
  );
}
