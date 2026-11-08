import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowCounterClockwise } from "@phosphor-icons/react";
import { Button } from "../controls";
import type { Slide } from "../../lib/wrappedModel";
import { SlideView } from "./Slide";

/**
 * The story, in the page: a cover and then one slide at a time, filling the space so nothing
 * scrolls. Left/Right keys go back and on; the progress segments are buttons too. A slide changes
 * with a fade and a short rise; with reduced motion it is only the fade.
 */
export function Story({ cover, slides }: { cover: ReactNode; slides: Slide[] }) {
  const [i, setI] = useState(0);
  const last = slides.length; // 0 is the cover, 1..n are the slides
  const slide = i > 0 ? slides[i - 1] : null;

  const go = (n: number) => setI(Math.min(last, Math.max(0, n)));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      e.preventDefault();
      setI((n) => Math.min(last, Math.max(0, n + (e.key === "ArrowRight" ? 1 : -1))));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last]);

  return (
    <div className="wr-story">
      <div className="wr-prog" role="group" aria-label="Slides">
        {Array.from({ length: last + 1 }, (_, n) => (
          <button
            key={n}
            type="button"
            className="wr-prog-hit"
            data-done={n <= i ? "" : undefined}
            aria-label={n === 0 ? `Cover, 1 of ${last + 1}` : `Slide ${n + 1} of ${last + 1}: ${slides[n - 1].kicker}`}
            aria-current={n === i || undefined}
            onClick={() => go(n)}
          >
            <i />
          </button>
        ))}
      </div>

      <div className="wr-story-stage intro">
        <div key={i} className="rise wr-story-slide" aria-live="polite">
          {slide ? <SlideView slide={slide} /> : cover}
        </div>
      </div>

      <div className="wr-story-foot">
        <Button onClick={() => go(i - 1)} disabled={i === 0}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </Button>
        <span className="text-caption text-ink-2">
          {i + 1} of {last + 1}
        </span>
        {i === last ? (
          <Button variant="primary" onClick={() => go(0)}>
            <ArrowCounterClockwise size={14} aria-hidden="true" />
            Replay
          </Button>
        ) : (
          <Button variant="primary" onClick={() => go(i + 1)}>
            {i === 0 ? "Start" : "Next"}
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
