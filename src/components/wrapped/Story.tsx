import { useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import { Button } from "../controls";
import { prefersReducedMotion } from "../../lib/motion";
import type { Slide } from "../../lib/wrappedModel";
import { plan, WIPE_LEAD, WIPE_MS } from "../../lib/wrappedPoster";
import type { PosterSpec } from "../../lib/wrappedPoster";
import { CardPoster } from "./CardSlide";
import { Poster } from "./Poster";

/** How long a press has to last before it is a hold (the story freezes) and not a tap. */
const HOLD_MS = 180;

/** What a key press on these belongs to the menu or list, not the story. */
const MENU_PARTS =
  '[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="listbox"],[role="option"]';
/** A dialog or an open menu: the story keeps its hands off every key while one is up. */
const OPEN_LAYERS =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

interface At {
  i: number;
  /** The poster going out, frozen, until the wipe has covered it. */
  prev: number | null;
  dir: "fwd" | "back";
  /** Counts moves, so a late timer from an earlier move cannot clear a later one. */
  n: number;
}

function PosterOrCard({
  slide,
  spec,
  frozen,
  paused,
  delay,
  onFrame,
}: {
  slide: Slide;
  spec: PosterSpec;
  frozen?: boolean;
  paused?: boolean;
  delay?: number;
  onFrame?: (t: number) => void;
}) {
  return slide.card ? (
    <CardPoster
      slide={slide}
      spec={spec}
      frozen={frozen}
      paused={paused}
      delay={delay}
      onFrame={onFrame}
    />
  ) : (
    <Poster
      slide={slide}
      spec={spec}
      frozen={frozen}
      paused={paused}
      delay={delay}
      onFrame={onFrame}
    />
  );
}

/**
 * The story, in the page: one full-bleed poster at a time, filling the space so nothing scrolls.
 * Right, Left and Space go on and back; a click on the poster goes on (the left third goes back);
 * hold anywhere to freeze it; the progress segments are buttons too. A move is a colour wipe into the
 * next poster's colour while the words cross over; with reduced motion it is a fade.
 */
export function Story({
  slides,
  onLeave,
}: {
  slides: Slide[];
  /** Esc: leave the story (back to the page before it). */
  onLeave?: () => void;
}) {
  const leave = useRef(onLeave);
  leave.current = onLeave;
  const [at, setAt] = useState<At>({ i: 0, prev: null, dir: "fwd", n: 0 });
  const [wiping, setWiping] = useState(false);
  const [paused, setPaused] = useState(false);
  const last = slides.length - 1;
  const { i, prev, dir } = at;
  const specs = useMemo(() => plan(slides.map((s) => s.id)), [slides]);
  const reduced = prefersReducedMotion();

  const move = (to: number) =>
    setAt((cur) => {
      const t = Math.min(last, Math.max(0, to));
      return t === cur.i
        ? cur
        : {
            i: t,
            prev: reduced ? null : cur.i,
            dir: t > cur.i ? "fwd" : "back",
            n: cur.n + 1,
          };
    });
  const go = (n: number) => move(n);

  useEffect(() => {
    let spaceDown = false;
    // Whether the person got to the focused control with the keyboard. :focus-visible cannot say:
    // WebView2 can flip it to true after any key event, even on a button a mouse click focused. So
    // it is tracked here instead: a Tab (or Shift+Tab) says "keyboard", any pointer press says "mouse".
    let tabbed = false;
    const onPointer = () => {
      tabbed = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab") tabbed = true;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (
        e.key !== "ArrowRight" &&
        e.key !== "ArrowLeft" &&
        e.key !== " " &&
        e.key !== "Escape"
      )
        return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
      )
        return;
      // A menu (or a list you pick from) owns these keys, and so does a dialog: the story never pages
      // behind one, and Space on a focused menu item is that item's.
      if (t && t.closest(MENU_PARTS)) return;
      if (document.querySelector(OPEN_LAYERS)) return;
      // Esc leaves the story for the page you came from.
      if (e.key === "Escape") {
        if (!leave.current) return;
        e.preventDefault();
        leave.current();
        return;
      }
      // Space on a control you Tabbed to presses it. A control a mouse click left focused (a title-bar
      // or caption button) must not: Space belongs to the story, so it is swallowed there.
      if (
        e.key === " " &&
        t &&
        t.closest('button, a, [role="button"]') &&
        tabbed
      )
        return;
      e.preventDefault();
      // Paging the story is not a walk round the controls, so it must not leave a keyboard ring on a
      // control a click left focused. The input-modality listener (document, after this window one)
      // flips to keyboard on every arrow, so hand it back once the event has finished.
      if (!tabbed)
        window.setTimeout(() => {
          document.documentElement.dataset.input = "pointer";
        }, 0);
      // Holding a key repeats it; one press is one move, so the repeats are swallowed, not stepped.
      if (e.repeat) return;
      if (e.key === " ") spaceDown = true;
      const by = e.key === "ArrowLeft" ? -1 : 1;
      setAt((cur) => {
        const to = Math.min(last, Math.max(0, cur.i + by));
        return to === cur.i
          ? cur
          : {
              i: to,
              prev: prefersReducedMotion() ? null : cur.i,
              dir: to > cur.i ? "fwd" : "back",
              n: cur.n + 1,
            };
      });
    };
    // The click a button makes on Space comes on key-up in some engines: that one is swallowed too.
    const onUp = (e: KeyboardEvent) => {
      if (e.key !== " " || !spaceDown) return;
      spaceDown = false;
      e.preventDefault();
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("mousedown", onPointer, true);
    // Capture phase on the window, so the story sees the key before any control does and its
    // preventDefault stops a focused button from being pressed.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("keyup", onUp, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("mousedown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onUp, true);
    };
  }, [last]);

  // The wipe: the old poster leaves once the block covers it (half way); the block leaves at the end.
  const first = useRef(true);
  const n = at.n;
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced) return;
    setWiping(true);
    const half = setTimeout(
      () => setAt((c) => (c.n === n ? { ...c, prev: null } : c)),
      WIPE_MS / 2,
    );
    const done = setTimeout(() => setWiping(false), WIPE_MS);
    return () => {
      clearTimeout(half);
      clearTimeout(done);
    };
  }, [n, reduced]);

  // Hold to freeze: a press that lasts HOLD_MS pauses the clock; letting go resumes it and the click
  // that follows is not a step.
  const hold = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  const release = () => {
    if (hold.current) clearTimeout(hold.current);
    hold.current = null;
    setPaused(false);
  };
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    held.current = false;
    if ((e.target as HTMLElement).closest("button, a, canvas, input")) return;
    hold.current = setTimeout(() => {
      held.current = true;
      setPaused(true);
    }, HOLD_MS);
  };
  useEffect(
    () => () => {
      if (hold.current) clearTimeout(hold.current);
    },
    [],
  );

  // A tap on the poster itself goes on, like a story; anything you can press keeps its job.
  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    if (held.current) {
      held.current = false;
      return;
    }
    if (
      (e.target as HTMLElement).closest(
        'button, a, canvas, input, [tabindex]:not([tabindex="-1"]), [title]',
      )
    )
      return;
    if (window.getSelection()?.toString()) return;
    const box = e.currentTarget.getBoundingClientRect();
    move(i + (e.clientX - box.left < box.width / 3 ? -1 : 1));
  };

  // The current progress segment fills with the poster's clock: one write per frame, no React state.
  const fill = useRef<HTMLElement | null>(null);
  const onFrame = (t: number) => {
    if (fill.current) fill.current.style.transform = `scaleX(${t.toFixed(4)})`;
  };

  const slide = slides[i];
  const outgoing = prev !== null && prev !== i ? slides[prev] : null;
  // Fixed for the life of the poster (it is keyed by the slide), so the clock starts once.
  const lead = n > 0 && !reduced ? WIPE_LEAD : 0;

  return (
    <div className="pr-story">
      <div className="pr-prog" role="group" aria-label="Slides">
        {slides.map((s, k) => (
          <button
            key={s.id}
            type="button"
            className="pr-prog-hit"
            data-done={k < i ? "" : undefined}
            data-now={k === i ? "" : undefined}
            aria-label={`Slide ${k + 1} of ${slides.length}: ${s.kicker}`}
            aria-current={k === i || undefined}
            onClick={() => go(k)}
          >
            <i
              key={k === i ? "now" : "off"}
              ref={k === i ? (el) => void (fill.current = el) : undefined}
            />
          </button>
        ))}
      </div>

      {/* The stage's click is the story-style tap; the keys and the buttons do the same for everyone else. */}
      <div
        className="pr-stage"
        data-hold={paused ? "" : undefined}
        data-dir={dir}
        onClick={onStageClick}
        onPointerDown={onDown}
        onPointerUp={release}
        onPointerCancel={release}
        onPointerLeave={release}
      >
        <div
          key={i}
          className="pr-slot"
          data-in={n > 0 ? (reduced ? "fade" : "wipe") : undefined}
          aria-live="polite"
        >
          <PosterOrCard
            slide={slide}
            spec={specs[i]}
            paused={paused}
            delay={lead}
            onFrame={onFrame}
          />
        </div>
        {outgoing && (
          <div key={`out${prev}`} className="pr-slot pr-out" aria-hidden="true">
            <PosterOrCard
              slide={outgoing}
              spec={specs[prev as number]}
              frozen
            />
          </div>
        )}
        {wiping && !reduced && (
          <i
            key={`w${n}`}
            className="pr-wipe"
            data-pair={specs[i].pair}
            data-dir={dir}
            aria-hidden="true"
          />
        )}
      </div>

      <div className="pr-foot">
        <Button onClick={() => go(i - 1)} disabled={i === 0}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </Button>
        <span className="text-caption text-ink-2">
          {i + 1} of {slides.length}
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
