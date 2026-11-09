import { useEffect, useRef, useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { ArrowLeft, ArrowRight, ArrowCounterClockwise } from "@phosphor-icons/react";
import { Button } from "../controls";
import type { Slide } from "../../lib/wrappedModel";
import { SlideView } from "./Slide";

/** How a slide arrives. They take turns, so no two neighbors move the same way. */
export const TRANSITIONS = ["rise", "slide", "zoom", "curtain"] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** The cover zooms in; the last slide always arrives behind the curtain; the rest take turns. */
export function transitionFor(index: number, last: number): Transition {
  if (index === 0) return "zoom";
  if (index === last) return "curtain";
  return TRANSITIONS[(index - 1) % 3];
}

/** Entrances wait this long (ms) while the curtain covers the stage; keep in step with wr-sweep. */
export const CURTAIN_LEAD = 300;

/** How long the stage hides its overflow after a change, so nothing in flight can raise a scrollbar. */
const MOVING_MS = 1300;

/**
 * The story, in the page: a cover and then one slide at a time, filling the space so nothing
 * scrolls. Right, Left and Space go on and back; a click on the slide goes on (the left third goes
 * back); the progress segments are buttons too. Each slide arrives by its own move, from the side
 * you are heading toward. With reduced motion every move is a fade.
 */
export function Story({ cover, slides }: { cover: ReactNode; slides: Slide[] }) {
  const [at, setAt] = useState<{ i: number; dir: "fwd" | "back" }>({ i: 0, dir: "fwd" });
  const [moving, setMoving] = useState(false);
  const last = slides.length; // 0 is the cover, 1..n are the slides
  const { i, dir } = at;
  const slide = i > 0 ? slides[i - 1] : null;
  const tx = transitionFor(i, last);

  const go = (n: number) =>
    setAt((cur) => {
      const to = Math.min(last, Math.max(0, n));
      return to === cur.i ? cur : { i: to, dir: to > cur.i ? "fwd" : "back" };
    });
  const step = (by: number) => go(at.i + by);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== " ") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      // Space on a focused button or link presses it; do not also advance.
      if (e.key === " " && t && (t.tagName === "BUTTON" || t.tagName === "A" || t.getAttribute("role") === "button")) return;
      if (document.querySelector('[role="dialog"],[role="alertdialog"]')) return;
      e.preventDefault();
      setAt((cur) => {
        const to = Math.min(last, Math.max(0, cur.i + (e.key === "ArrowLeft" ? -1 : 1)));
        return to === cur.i ? cur : { i: to, dir: to > cur.i ? "fwd" : "back" };
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [last]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setMoving(true);
    const t = setTimeout(() => setMoving(false), MOVING_MS);
    return () => clearTimeout(t);
  }, [i]);

  // A tap on the slide itself goes on, like a story; anything you can press or hover keeps its job.
  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button, a, canvas, input, [tabindex]:not([tabindex="-1"]), [title]')) return;
    if (window.getSelection()?.toString()) return;
    const box = e.currentTarget.getBoundingClientRect();
    step(e.clientX - box.left < box.width / 3 ? -1 : 1);
  };

  return (
    <div className="wr-story">
      <div className="wr-prog" role="group" aria-label="Slides">
        {Array.from({ length: last + 1 }, (_, n) => (
          <button
            key={n}
            type="button"
            className="wr-prog-hit"
            data-done={n <= i ? "" : undefined}
            data-now={n === i ? "" : undefined}
            aria-label={n === 0 ? `Cover, 1 of ${last + 1}` : `Slide ${n + 1} of ${last + 1}: ${slides[n - 1].kicker}`}
            aria-current={n === i || undefined}
            onClick={() => go(n)}
          >
            <i key={n === i ? i : "x"} />
          </button>
        ))}
      </div>

      {/* The stage's click is the story-style tap; the keys and the buttons do the same for everyone else. */}
      <div className="wr-story-stage intro" data-moving={moving ? "" : undefined} onClick={onStageClick}>
        {tx === "curtain" && i > 0 && <i key={`c${i}`} className="wr-curtain" data-dir={dir} aria-hidden="true" />}
        <div key={i} className="wr-story-slide" data-tx={tx} data-dir={dir} aria-live="polite">
          {slide ? <SlideView slide={slide} index={i} lead={tx === "curtain" ? CURTAIN_LEAD : 0} /> : cover}
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
          <Button onClick={() => go(0)}>
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
