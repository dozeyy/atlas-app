import { useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties, RefObject } from "react";
import { heroBoxFor } from "../../lib/posterMath";
import { contourPath } from "../../lib/topo";
import { EASES, pieceWindow, pulseAfter, seg } from "../../lib/wrappedClock";
import {
  BOXES,
  FRAME_H,
  FRAME_W,
  fitMain,
  HEAD_ROW,
  HEAD_TALL,
} from "../../lib/wrappedPoster";
import type { Box, PosterSpec } from "../../lib/wrappedPoster";
import type { Slide } from "../../lib/wrappedModel";
import { countCells, parseCount } from "./count";
import { ClockProvider, useClockCtx, useTick } from "./clock";
import { Hero } from "./Hero";
import { beatValue, put, useEl, useEls } from "./heroKit";

// One poster: the card, the frame it is laid out on, and the words (kicker, figure, line, strip).
// The hero graphic is in Hero.tsx. Everything that moves is driven by the poster's one clock.

/** The label a screen reader gets for a figure that carries a hover. */
export function figureLabel(
  slide: Pick<Slide, "figure" | "unit" | "hint">,
): string {
  return (
    [slide.figure, slide.unit].filter(Boolean).join(" ") +
    (slide.hint ? `. ${slide.hint}` : "")
  );
}

type Align = "left" | "right" | "center";

const px = (b: Box): CSSProperties => ({
  left: b.x,
  top: b.y,
  width: b.w,
  height: b.h,
});

/** Keep `--k` (design units to pixels) and `--ex` (frame units the card has left over each side) current. */
export function useFit(card: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const apply = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const k = Math.min(w / FRAME_W, h / FRAME_H);
      el.style.setProperty("--k", k.toFixed(4));
      el.style.setProperty(
        "--ex",
        Math.max(0, (w / k - FRAME_W) / 2).toFixed(1),
      );
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, [card]);
}

// ---- the words --------------------------------------------------------------------------------------

function Head({ slide }: { slide: Slide }) {
  const ctx = useClockCtx();
  const k = useEl();
  const u = useEl();
  useTick((t) => {
    const p = beatValue(ctx, "kicker", t);
    put(k.el.current, { x: -(1 - p) * 36, o: p });
    put(u.el.current, { x: (1 - p) * 36, o: p });
  });
  return (
    <div className="pr-head">
      <span ref={k.ref} className="pr-kicker">
        {slide.kicker}
      </span>
      {slide.unit ? (
        <span ref={u.ref} className="pr-chip">
          {slide.unit}
        </span>
      ) : null}
    </div>
  );
}

const isDigit = (c: string) => c >= "0" && c <= "9";

function Figure({
  slide,
  main,
  size,
  lines,
  bleed,
}: {
  slide: Slide;
  main: Box;
  size: number;
  lines: string[];
  bleed: number;
}) {
  const ctx = useClockCtx();
  const { els, ref } = useEls();
  const group = useEl();
  const chars = useMemo(
    () =>
      lines.flatMap((l, li) => Array.from(l).map((c, ci) => ({ c, li, ci }))),
    [lines],
  );
  const moving = useMemo(
    () => chars.map((x, i) => (x.c === " " ? -1 : i)).filter((i) => i >= 0),
    [chars],
  );
  const counts = lines.length === 1 && parseCount(slide.figure) !== null;
  const last = useRef("");
  const fig = ctx.beats.find((b) => b.id === "fig");
  const ease = fig ? EASES[fig.ease] : EASES.outCubic;
  useTick((t) => {
    const n = moving.length;
    moving.forEach((ci, j) => {
      if (!fig) return;
      const [a, z] = pieceWindow(fig, ctx.ms, j, n);
      let p = ease(seg(t, a, z));
      if (ctx.mood === "tick") p = Math.round(p * 5) / 5;
      const dir = ctx.mood === "heavy" ? -1 : 1;
      put(els.current[ci], {
        y: dir * (1 - p) * size * 1.05,
        o: p > 0.003 ? 1 : 0,
      });
    });
    if (counts) {
      const cells = countCells(slide.figure, beatValue(ctx, "count", t));
      const key = cells.join("|");
      if (key !== last.current) {
        last.current = key;
        cells.forEach((c, i) => {
          const el = els.current[i];
          if (el) el.textContent = c;
        });
      }
    }
    const sq = ctx.beats.find((b) => b.id === "squash");
    const q = sq
      ? pulseAfter(t, sq.start, ctx.ms, (sq.end - sq.start) * ctx.ms)
      : 0;
    put(
      group.el.current,
      ctx.mood === "heavy" ? { sx: 1 + 0.05 * q, sy: 1 - 0.09 * q } : {},
    );
  });
  const label = figureLabel(slide);
  let at = -1;
  return (
    <div
      className="pr-fig"
      title={slide.hint}
      tabIndex={slide.hint ? 0 : undefined}
      role={slide.hint ? "group" : "img"}
      aria-label={label}
      data-count={counts ? "" : undefined}
      style={{
        fontSize: size,
        width: main.w,
        transform: bleed
          ? `translateX(calc(${bleed.toFixed(1)}px + ${bleed > 0 ? "" : "-1 * "}var(--ex, 0) * 1px))`
          : undefined,
      }}
    >
      <div ref={group.ref} className="pr-fig-in" aria-hidden="true">
        {lines.map((line, li) => (
          <div key={li} className="pr-fig-line">
            {Array.from(line).map((c, ci) => {
              at++;
              return c === " " ? (
                <span key={ci} className="pr-sp" />
              ) : (
                <span
                  key={ci}
                  className="pr-c"
                  data-d={isDigit(c) ? "" : undefined}
                >
                  <span ref={ref(at)} className="pr-ci">
                    {c}
                  </span>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function Line({ text, box, align }: { text: string; box: Box; align: Align }) {
  const ctx = useClockCtx();
  const el = useEl();
  useTick((t) => {
    const p = beatValue(ctx, "line", t);
    put(el.el.current, { y: (1 - p) * 22, o: p });
  });
  return (
    <p
      ref={el.ref}
      className="pr-line"
      style={{ ...px(box), textAlign: align }}
    >
      {text}
    </p>
  );
}

function Strip({
  slide,
  box,
  pad,
  align,
}: {
  slide: Slide;
  box: Box;
  pad: number;
  align: Align;
}) {
  const ctx = useClockCtx();
  const bg = useEl();
  const tx = useEl();
  const fromLeft = box.x + box.w / 2 <= FRAME_W / 2;
  useTick((t) => {
    const p = beatValue(ctx, "strip", t);
    put(bg.el.current, { sx: p, sy: 1 });
    put(tx.el.current, {
      x: (fromLeft ? -1 : 1) * (1 - p) * 40,
      o: p > 0.55 ? (p - 0.55) / 0.45 : 0,
    });
  });
  const c = slide.compare;
  if (!c) return null;
  return (
    <div
      className="pr-strip"
      style={{
        ...px(box),
        paddingLeft: fromLeft ? pad : 28,
        paddingRight: fromLeft ? 28 : pad,
        textAlign: align,
      }}
      title={c.hint}
    >
      <i
        ref={bg.ref}
        className="pr-strip-bg"
        style={{
          transformOrigin: fromLeft ? "0 50%" : "100% 50%",
          left: box.x <= 0 ? "calc(var(--ex, 0) * -1px)" : 0,
          right: box.x + box.w >= FRAME_W ? "calc(var(--ex, 0) * -1px)" : 0,
        }}
      />
      <span ref={tx.ref} className="pr-strip-text" tabIndex={0}>
        {c.text}
      </span>
    </div>
  );
}

// ---- the background field ----------------------------------------------------------------------------------

/** Three drifting shapes and, on some cards, a thin topo overlay. Transform only; none of it carries text. */
export function Field({ spec, id }: { spec: PosterSpec; id: string }) {
  const b = BOXES[spec.layout];
  const away = b.side === "r" ? 0 : 1;
  const up = b.top ? 1 : 0;
  const topo = useMemo(
    () =>
      spec.topo
        ? contourPath({
            width: FRAME_W,
            height: FRAME_H,
            seed: id.length * 7 + id.charCodeAt(0),
          })
        : "",
    [spec.topo, id],
  );
  return (
    <>
      {topo ? (
        <svg
          className="pr-topo"
          viewBox={`0 0 ${FRAME_W} ${FRAME_H}`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
          focusable="false"
        >
          <path d={topo} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      <div className="pr-field" aria-hidden="true">
        <i
          className="pr-blob pr-blob-a"
          style={{ left: away ? 700 : -140, top: up ? 380 : -200 }}
        />
        <i
          className="pr-blob pr-blob-b"
          style={{ left: away ? -120 : 820, top: up ? -130 : 450 }}
        />
        <i
          className="pr-blob pr-blob-c"
          style={{ left: away ? 560 : 120, top: up ? 60 : 340 }}
        />
      </div>
    </>
  );
}

// ---- the poster ---------------------------------------------------------------------------------------------------------

export interface PosterProps {
  slide: Slide;
  spec: PosterSpec;
  /** The poster going out: laid out and finished, no clock. */
  frozen?: boolean;
  paused?: boolean;
  /** ms the clock waits before it starts (the wipe is still crossing). */
  delay?: number;
  onFrame?: (t: number) => void;
}

export function Poster({
  slide,
  spec,
  frozen = false,
  paused = false,
  delay = 0,
  onFrame,
}: PosterProps) {
  const card = useRef<HTMLDivElement>(null);
  useFit(card);
  const b = BOXES[spec.layout];
  const hbox = useMemo(() => heroBoxFor(b), [b]);
  const headH = b.main.w < 500 ? HEAD_TALL : HEAD_ROW;
  const fit = useMemo(
    () => fitMain(slide.figure, b.main, headH),
    [slide.figure, b, headH],
  );
  const bleed = spec.bleed
    ? (b.align === "right" ? 1 : -1) *
      (FRAME_W - (b.main.x + b.main.w) + fit.size * 0.02)
    : 0;
  const mainStyle: CSSProperties = {
    ...px(b.main),
    justifyContent: b.anchor === "end" ? "flex-end" : "flex-start",
    alignItems:
      b.align === "right"
        ? "flex-end"
        : b.align === "center"
          ? "center"
          : "flex-start",
    textAlign: b.align,
    transform: b.tilt ? `rotate(${b.tilt}deg)` : undefined,
    ["--jc" as string]:
      b.align === "right"
        ? "flex-end"
        : b.align === "center"
          ? "center"
          : "flex-start",
  };
  return (
    <div
      ref={card}
      className="pr"
      data-pair={spec.pair}
      data-layout={spec.layout}
      data-mood={spec.mood}
      data-slide={slide.id}
      data-frozen={frozen ? "" : undefined}
    >
      <ClockProvider
        mood={spec.mood}
        delay={delay}
        frozen={frozen}
        paused={paused}
        onFrame={onFrame}
        runRef={card}
      >
        <Field spec={spec} id={slide.id} />
        <div className="pr-frame">
          {slide.chart ? (
            <div className="pr-hero" style={px(b.hero)}>
              <Hero slide={slide} box={hbox} />
            </div>
          ) : null}
          <Strip
            slide={slide}
            box={b.strip}
            pad={b.stripPad}
            align={b.align === "center" ? "center" : b.align}
          />
          <div className="pr-main" style={mainStyle}>
            <Head slide={slide} />
            <Figure
              slide={slide}
              main={b.main}
              size={fit.size}
              lines={fit.lines}
              bleed={bleed}
            />
          </div>
          <Line text={slide.line} box={b.line} align={b.align} />
        </div>
        <div className="pr-grain" aria-hidden="true" />
      </ClockProvider>
    </div>
  );
}
