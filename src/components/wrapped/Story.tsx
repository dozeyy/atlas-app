import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowCounterClockwise,
} from "@phosphor-icons/react";
import { Button } from "../controls";
import { prefersReducedMotion } from "../../lib/motion";
import type { Slide } from "../../lib/wrappedModel";
import { FRAME_H, FRAME_W, SlideView } from "./SlideView";
import { Trail } from "./Trail";

/** What a key press on these belongs to the menu or list, not the story. */
const MENU_PARTS =
  '[role="menu"],[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="listbox"],[role="option"]';
/** A dialog or an open menu: the story keeps its hands off every key while one is up. */
const OPEN_LAYERS =
  '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]';

/** How long the slide that is leaving stays under the one arriving (its fade and drift). */
const LEAVE_MS = 280;
/** The frame is never drawn larger than this, so a big window does not blow the slide up. */
const MAX_SCALE = 1.3;
/** Under this scale the window is a small one: the end card sits beside its button, not above it. */
const SMALL_SCALE = 0.8;

interface At {
  i: number;
  /** The slide going out, frozen, until its fade has finished. */
  prev: number | null;
  dir: "fwd" | "back";
  /** Counts moves, so a late timer from an earlier move cannot clear a later one. */
  n: number;
}

/**
 * The story, in the page: one slide at a time on a quiet sheet, the trail above it, Back and Next
 * under it. Right, Left and Space go on and back; a click on the sheet goes on (the left third goes
 * back); the trail's waypoints are buttons too. A move is a cross-fade with a 24 px drift in the
 * trail's direction; with reduced motion it is a plain fade. Slides are laid out in a fixed
 * 1008 x 625 frame that is scaled to the sheet, so the layout is the same at every window size.
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
  const last = slides.length - 1;
  // The data can reload under the story with fewer slides: the position never reads past the end.
  const { prev, dir, n } = at;
  const i = Math.max(0, Math.min(at.i, last));
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
  const go = (k: number) => move(k);

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

  // ...and the stored position follows, so the keys and the buttons start from where the story is.
  useEffect(() => {
    setAt((c) => (last >= 0 && c.i > last ? { ...c, i: last, prev: null, n: c.n + 1 } : c));
  }, [last]);

  // The slide that is leaving goes once its fade is done.
  useEffect(() => {
    if (prev === null) return;
    const t = setTimeout(() => setAt((c) => (c.n === n ? { ...c, prev: null } : c)), LEAVE_MS);
    return () => clearTimeout(t);
  }, [n, prev]);

  // The frame scales to the sheet (never up past MAX_SCALE).
  const sheet = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = sheet.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w > 0 && h > 0) setScale(Math.min(MAX_SCALE, w / FRAME_W, h / FRAME_H));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A tap on the sheet itself goes on, like a story; anything you can press or that has a hover keeps its job.
  const onStageClick = (e: MouseEvent<HTMLDivElement>) => {
    if (
      (e.target as HTMLElement).closest(
        'button, a, canvas, input, [tabindex]:not([tabindex="-1"]), [title], [data-tip]',
      )
    )
      return;
    if (window.getSelection()?.toString()) return;
    const box = e.currentTarget.getBoundingClientRect();
    move(i + (e.clientX - box.left < box.width / 3 ? -1 : 1));
  };

  if (slides.length === 0) return null;
  const slide = slides[i];
  const outgoing = prev !== null && prev !== i ? (slides[prev] ?? null) : null;

  return (
    <div className="sm-story">
      <Trail slides={slides} at={i} onGo={go} />

      {/* The sheet's click is the story-style tap; the keys and the buttons do the same for everyone else. */}
      <div className="sm-stage" data-dir={dir} onClick={onStageClick}>
        <div ref={sheet} className="sm-sheet">
          <div
            className="sm-scaler"
            // --sm-k lets the small print keep a readable size on screen when the frame is scaled
            // down (summit.css); a small window also gets the tighter card layout.
            data-small={scale < SMALL_SCALE ? "" : undefined}
            style={
              {
                width: FRAME_W,
                height: FRAME_H,
                transform: `translate(-50%, -50%) scale(${scale})`,
                "--sm-k": scale,
              } as CSSProperties
            }
          >
            <div
              key={i}
              className="sm-slot"
              data-in={n > 0 ? dir : undefined}
              aria-live="polite"
            >
              <SlideView slide={slide} />
            </div>
            {outgoing && (
              <div key={`out${prev}`} className="sm-slot sm-out" data-out={dir} aria-hidden="true">
                <SlideView slide={outgoing} settled />
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sm-foot">
        <Button onClick={() => go(i - 1)} disabled={i === 0}>
          <ArrowLeft size={14} aria-hidden="true" />
          Back
        </Button>
        <span className="sm-foot-at text-caption text-ink-2">
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
