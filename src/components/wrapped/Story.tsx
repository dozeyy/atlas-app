import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, ArrowCounterClockwise, X } from "@phosphor-icons/react";
import { Button, IconButton } from "../controls";
import type { Slide } from "../../lib/wrappedModel";
import { SlideView } from "./Slide";

/**
 * The story: one slide at a time on a quiet stage. Right/Space/Enter go on, Left goes back, Esc
 * closes. Progress segments are buttons too. Slides change with a fade and a short rise; with
 * reduced motion it is only the fade.
 */
export function Story({ slides, start = 0, onClose }: { slides: Slide[]; start?: number; onClose: () => void }) {
  const [i, setI] = useState(Math.min(Math.max(0, start), slides.length - 1));
  const root = useRef<HTMLDivElement>(null);
  const last = slides.length - 1;
  const slide = slides[i];

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  const go = (n: number) => setI(Math.min(last, Math.max(0, n)));

  const onKey = (e: KeyboardEvent) => {
    // Space and Enter on a focused button should still press it.
    const onButton = (e.target as HTMLElement).tagName === "BUTTON";
    switch (e.key) {
      case "Escape":
        e.stopPropagation();
        e.preventDefault();
        onClose();
        break;
      case "ArrowRight":
        e.preventDefault();
        go(i + 1);
        break;
      case "ArrowLeft":
        e.preventDefault();
        go(i - 1);
        break;
      case " ":
      case "Enter":
        if (onButton) return;
        e.preventDefault();
        if (i === last) onClose();
        else go(i + 1);
        break;
    }
  };

  if (!slide) return null;
  return createPortal(
    <div ref={root} className="wr-story" role="dialog" aria-modal="true" aria-label="Your story" tabIndex={-1} onKeyDown={onKey}>
      <div className="wr-story-top">
        <div className="wr-prog" role="group" aria-label="Slides">
          {slides.map((s, n) => (
            <button
              key={s.id}
              type="button"
              className="wr-prog-hit"
              data-done={n <= i ? "" : undefined}
              aria-label={`Slide ${n + 1} of ${slides.length}: ${s.kicker}`}
              aria-current={n === i || undefined}
              onClick={() => go(n)}
            >
              <i />
            </button>
          ))}
        </div>
        <IconButton aria-label="Close the story" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="wr-story-stage intro">
        <div key={slide.id} className="rise w-full" style={{ display: "grid", placeItems: "center" }} aria-live="polite">
          <SlideView slide={slide} size="story" />
        </div>
      </div>

      <div className="wr-story-foot">
        <Button onClick={() => go(i - 1)} disabled={i === 0}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </Button>
        <span className="text-caption text-ink-2">
          {i + 1} of {slides.length}
        </span>
        {i === last ? (
          <div className="flex items-center gap-2">
            <Button onClick={() => go(0)}>
              <ArrowCounterClockwise size={14} aria-hidden="true" />
              Replay
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        ) : (
          <Button variant="primary" onClick={() => go(i + 1)}>
            Next
            <ArrowRight size={14} aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>,
    document.body,
  );
}
