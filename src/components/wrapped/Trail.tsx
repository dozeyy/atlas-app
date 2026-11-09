import type { CSSProperties } from "react";
import type { Slide } from "../../lib/wrappedModel";
import { SPARK } from "./graphics";

/**
 * The progress row is the trail: a dotted line across the top, filled clay behind you, a waypoint
 * for every slide (each one a button) and the clay spark standing on the one you are at. The
 * spark walks to the next waypoint (summit.css; with reduced motion it just moves).
 */
export function Trail({ slides, at, onGo }: { slides: Slide[]; at: number; onGo: (i: number) => void }) {
  const last = Math.max(1, slides.length - 1);
  const frac = (i: number) => (slides.length > 1 ? i / last : 0);
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
          aria-label={`Slide ${k + 1} of ${slides.length}: ${s.kicker}`}
          aria-current={k === at || undefined}
          onClick={() => onGo(k)}
        />
      ))}
      <svg className="sm-trail-spark" viewBox="-13 -13 26 26" aria-hidden="true" style={{ "--at": frac(at) } as CSSProperties}>
        <path d={SPARK} transform="scale(12)" />
      </svg>
    </div>
  );
}
