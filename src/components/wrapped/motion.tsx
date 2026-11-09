import { Fragment, useLayoutEffect, useState } from "react";
import type { CSSProperties } from "react";
import { prefersReducedMotion } from "../../lib/motion";
import { easeOutExpo } from "../../lib/useCountUp";

// The small pieces the story's entrances are built from. Everything here is driven by CSS
// (transform and opacity only); the one piece of script is the number that counts up, and it only
// ever changes the text of a box that is already final-sized.

const NUM = /^(\d[\d,]*(?:\.\d+)?)([kMBT]?)$/;

export interface CountParts {
  n: number;
  decimals: number;
  commas: boolean;
  suffix: string;
}

/** A bare four-digit number in the calendar's range is a year, not a quantity: it must not count up from zero. */
const YEAR = /^(?:19|20)\d{2}$/;

/** "851M" -> 851 with suffix "M"; "1,234" -> 1234 with commas. Null for anything else (a date, a year, a name). */
export function parseCount(text: string): CountParts | null {
  const m = NUM.exec(text);
  if (!m || YEAR.test(text)) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return { n, decimals: (m[1].split(".")[1] ?? "").length, commas: m[1].includes(","), suffix: m[2] };
}

export function formatCount(v: number, p: CountParts): string {
  const body = p.commas
    ? v.toLocaleString("en-US", { minimumFractionDigits: p.decimals, maximumFractionDigits: p.decimals })
    : v.toFixed(p.decimals);
  return body + p.suffix;
}

const COUNT_MS = 1000;

/**
 * The text of a figure while it counts up from zero, starting after `delay` ms. Every time the
 * slide mounts it counts again (a story is meant to be replayed). Reduced motion, or a figure that
 * is not a plain number, shows the final text at once.
 */
export function useCountText(text: string, delay: number): string {
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const p = parseCount(text);
    if (!p || prefersReducedMotion()) {
      setShown(text);
      return;
    }
    setShown(formatCount(0, p));
    let raf = 0;
    const t0 = performance.now() + delay;
    const tick = (now: number) => {
      const k = Math.min(1, Math.max(0, (now - t0) / COUNT_MS));
      if (k >= 1) {
        setShown(text);
        return;
      }
      setShown(formatCount(p.n * easeOutExpo(k), p));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, delay]);
  return shown;
}

/**
 * A number that counts up inside a box already as wide as the final text (the sizing twin is a CSS
 * pseudo-element, so the text is not doubled). Screen readers get the final figure, never the ticks.
 */
export function Num({ text, delay = 0, className = "" }: { text: string; delay?: number; className?: string }) {
  const shown = useCountText(text, delay);
  const running = shown !== text;
  return (
    <span className={`wr-num ${className}`} data-final={text}>
      <span aria-hidden={running || undefined}>{shown}</span>
      {running && <span className="sr-only">{text}</span>}
    </span>
  );
}

/** A sentence whose words land one after another. The spaces stay real text, so it reads and wraps normally. */
export function Words({ text }: { text: string }) {
  const words = text.split(" ");
  return (
    <>
      {words.map((w, i) => (
        <Fragment key={i}>
          {i > 0 && " "}
          <span className="wr-w" style={{ "--w": i } as CSSProperties}>
            {w}
          </span>
        </Fragment>
      ))}
    </>
  );
}

/** Spark and ring positions for the finale: fixed, spread round the card, nothing random. */
export const SPARKS = Array.from({ length: 16 }, (_, i) => {
  const a = (i / 16) * Math.PI * 2 + 0.35;
  const rx = 360 + (i % 3) * 70;
  const ry = 150 + (i % 2) * 40;
  return {
    dx: Math.round(Math.cos(a) * rx),
    dy: Math.round(Math.sin(a) * ry),
    size: 12 + (i % 4) * 5,
    delay: 760 + i * 26,
    sand: i % 3 === 0,
  };
});

/**
 * The one celebration: contour rings spreading from the card like the map's rings, and a ring of
 * small four-point sparks flying out and fading. Transform and opacity only; clipped to the slide;
 * it plays once when the slide arrives and is replaced by a plain fade under reduced motion.
 */
export function Celebration() {
  return (
    <div className="wr-celebrate" aria-hidden="true">
      {[0, 1, 2].map((r) => (
        <i key={r} className="wr-ring" style={{ "--rd": `${700 + r * 170}ms` } as CSSProperties} />
      ))}
      {SPARKS.map((s, i) => (
        <svg
          key={i}
          className="wr-spark"
          data-sand={s.sand ? "" : undefined}
          viewBox="0 0 10 10"
          width={s.size}
          height={s.size}
          style={{ "--dx": `${s.dx}px`, "--dy": `${s.dy}px`, "--sd": `${s.delay}ms` } as CSSProperties}
        >
          <path d="M5 0 6.1 3.9 10 5 6.1 6.1 5 10 3.9 6.1 0 5 3.9 3.9Z" />
        </svg>
      ))}
    </div>
  );
}
