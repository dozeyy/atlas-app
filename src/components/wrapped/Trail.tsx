import type { CSSProperties } from "react";
import type { Slide } from "../../lib/wrappedModel";
import { SPARK_BOX, SPARK_PATHS } from "../../lib/sparkMark";

/** The mark's box on the trail, in px (the SVG is 26 x 26; the mark sits centred in it). */
const TRAIL_MARK = 22;

/**
 * The progress row is the trail: a dotted line across the top, filled clay behind you, a waypoint
 * for every slide (each one a button) and the clay spark (the Atlas mark) standing on the one you
 * are at. The spark walks to the next waypoint (summit.css; with reduced motion it just moves).
 */
export function Trail({ slides, at, onGo }: { slides: Slide[]; at: number; onGo: (i: number) => void }) {
  const last = Math.max(1, slides.length - 1);
  const frac = (i: number) => (slides.length > 1 ? i / last : 0);
  const scale = TRAIL_MARK / SPARK_BOX;
  return (
    <div className="sm-trail" role="group" aria-label="Slides" style={{ "--n": slides.length } as CSSProperties}>
      <i className="sm-trail-track" aria-hidden="true" />
      <i className="sm-trail-fill" aria-hidden="true" style={{ "--at": frac(at) } as CSSProperties} />
      {slides.map((s, k) => (
        <button
          key={s.id}
          type="button"
          className="sm-wp"
          data-done={k < at ? "" : undefined}
          data-now={k === at ? "" : undefined}
          style={{ "--at": frac(k) } as CSSProperties}
          // The dots carry no words, so the hover names the stop (the label says the same, with its place).
          title={s.kicker}
          aria-label={`Slide ${k + 1} of ${slides.length}: ${s.kicker}`}
          aria-current={k === at || undefined}
          onClick={() => onGo(k)}
        />
      ))}
      <svg className="sm-trail-spark" viewBox="-13 -13 26 26" aria-hidden="true" style={{ "--at": frac(at) } as CSSProperties}>
        <g transform={`scale(${scale}) translate(${-SPARK_BOX / 2} ${-SPARK_BOX / 2})`}>
          {SPARK_PATHS.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </g>
      </svg>
    </div>
  );
}
