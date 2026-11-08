import type { Slide as SlideSpec } from "../../lib/wrappedModel";
import { DayBars, HourBars, RankBars, SplitBar } from "./charts";

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

/** One slide: a kicker, one big figure, one sentence, at most one chart. */
export function SlideView({ slide }: { slide: SlideSpec }) {
  const long = slide.figure.length > 10;
  return (
    <div className="wr-slide" data-tone={slide.tone}>
      <div className="wr-kicker">{slide.kicker}</div>
      <div className="wr-fig d" data-long={long ? "" : undefined} data-pop={slide.celebrate ? "" : undefined}>
        <span>{slide.figure}</span>
        {slide.unit && <span className="wr-unit">{slide.unit}</span>}
      </div>
      <p className="wr-line">{slide.line}</p>
      {slide.chart && (
        <div className="wr-chart">
          <Chart slide={slide} />
        </div>
      )}
    </div>
  );
}
