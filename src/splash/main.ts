// Launch splash: the Atlas mark bursts out of the middle, fills solid, swirls, booms
// into a flat clay screen, and the clay slides apart to show the app. Everything
// animates transform or opacity only. Rust shows this window over the desktop, and
// closes it once the real main window sits underneath.

import { invoke } from "@tauri-apps/api/core";
import "../styles/tokens.css";
import "./splash.css";
import { ARM_WEDGES, DOT_PATH, MARK_CENTER, MARK_VIEWBOX, SPARK_PATH } from "./markGeometry";
import {
  EASE_BOOM,
  EASE_BURST,
  EASE_FLOOD,
  EASE_SETTLE,
  EASE_SPLIT,
  EASE_SWIRL,
  T,
  summarizeFrames,
} from "./timeline";

const NS = "http://www.w3.org/2000/svg";
const VB = MARK_VIEWBOX;
const inTauri = typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
// ATLAS_REDUCE_MOTION=1 forces the reduced path for testing (the OS setting is a system
// setting, so tests never flip it).
const reduceMotion =
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
  (window as { __ATLAS_REDUCE__?: boolean }).__ATLAS_REDUCE__ === true;

const call = <R = void>(cmd: string, args?: Record<string, unknown>): Promise<R> =>
  inTauri ? invoke<R>(cmd, args) : Promise.resolve(undefined as R);

function div(cls: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  parent.appendChild(d);
  return d;
}

/** A square layer holding an inline svg (a viewBox the size of the mark art). */
function markLayer(parent: HTMLElement, svgInner: string, cls = "layer"): HTMLDivElement {
  const d = div(cls, parent);
  d.style.inset = "0";
  d.innerHTML = `<svg viewBox="0 0 ${VB} ${VB}" aria-hidden="true">${svgInner}</svg>`;
  return d;
}

const pct = (v: number) => `${((v / VB) * 100).toFixed(3)}%`;

function build(stage: HTMLElement) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const S = Math.round(Math.min(Math.max(Math.min(W, H) * 0.42, 200), 440));
  const k = S / VB;

  // Shared shapes: one path, referenced by every layer.
  const defs = document.createElementNS(NS, "svg");
  defs.setAttribute("class", "defs");
  defs.setAttribute("aria-hidden", "true");
  defs.innerHTML =
    `<defs><path id="spark" d="${SPARK_PATH}"/><path id="dot" d="${DOT_PATH}"/>` +
    ARM_WEDGES.map((p, i) => `<clipPath id="w${i}"><polygon points="${p}"/></clipPath>`).join("") +
    `</defs>`;
  stage.appendChild(defs);

  const dotBox = (defs.querySelector("#dot") as unknown as SVGGraphicsElement).getBBox();
  const dotCx = dotBox.x + dotBox.width / 2;
  const dotCy = dotBox.y + dotBox.height / 2;

  // The mark is placed so the middle of its arms sits at the middle of the window.
  const mark = div("", stage);
  Object.assign(mark.style, {
    position: "absolute",
    width: `${S}px`,
    height: `${S}px`,
    left: `${W / 2 - MARK_CENTER.x * k}px`,
    top: `${H / 2 - MARK_CENTER.y * k}px`,
  });
  const origin = `${pct(MARK_CENTER.x)} ${pct(MARK_CENTER.y)}`;

  const solid = `<use href="#spark" class="clay"/><use href="#dot" class="clay"/>`;
  const ghosts = T.ghosts.map(() => markLayer(mark, solid));
  const swirl = div("layer", mark);
  swirl.style.inset = "0";
  const arms = ARM_WEDGES.map((_, i) =>
    markLayer(swirl, `<g clip-path="url(#w${i})"><use href="#spark" class="ink"/></g>`),
  );
  const dotInk = markLayer(swirl, `<use href="#dot" class="ink"/>`);
  const fill = markLayer(swirl, solid);
  for (const el of [...ghosts, swirl, ...arms, fill]) el.style.transformOrigin = origin;
  dotInk.style.transformOrigin = `${pct(dotCx)} ${pct(dotCy)}`;

  // The flood disc covers the window corner to corner; it grows from inside the middle.
  const D = Math.ceil(Math.hypot(W, H)) + 8;
  const disc = div("", stage);
  disc.id = "disc";
  Object.assign(disc.style, {
    width: `${D}px`,
    height: `${D}px`,
    left: `${(W - D) / 2}px`,
    top: `${(H - D) / 2}px`,
  });
  const left = div("half left", stage);
  const right = div("half right", stage);
  return { S, D, mark, ghosts, swirl, arms, dotInk, fill, disc, left, right };
}

async function main() {
  const stage = document.getElementById("stage")!;
  const parts = build(stage);

  // Rust fits and shows this window, then answers; the timeline starts after that.
  let radius = 0;
  try {
    radius = (await call<{ radius: number }>("splash_ready"))?.radius ?? 0;
  } catch {
    return; // the intro was abandoned; Rust closes this window
  }
  stage.style.setProperty("--stage-radius", `${radius}px`);

  const anims: Animation[] = [];
  const run = (el: Element, keyframes: Keyframe[], opts: KeyframeAnimationOptions) => {
    const a = el.animate(keyframes, { fill: "both", ...opts });
    anims.push(a);
    return a;
  };

  // Frame timing, from the first frame until the splash is done.
  const deltas: number[] = [];
  let last = 0;
  let t0 = 0;
  let sampling = true;
  const tick = (now: number) => {
    if (!sampling) return;
    if (last) deltas.push(now - last);
    else t0 = now;
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  let finishing = false;
  const done = () => {
    if (finishing) return;
    finishing = true;
    sampling = false;
    void call("splash_done", { report: summarizeFrames(deltas, performance.now() - t0) });
  };

  // A click or any key goes straight to the app.
  let skipped = false;
  const skip = () => {
    if (skipped) return;
    skipped = true;
    void call("intro_skip");
  };
  window.addEventListener("pointerdown", skip, { capture: true });
  window.addEventListener("keydown", skip, { capture: true });

  (window as unknown as Record<string, unknown>).__atlasSplashFinish = (mode: string) => {
    if (mode === "split") {
      const a = run(parts.left, [{ transform: "translateX(0)" }, { transform: "translateX(-101%)" }], {
        duration: T.split.dur,
        easing: EASE_SPLIT,
      });
      run(parts.right, [{ transform: "translateX(0)" }, { transform: "translateX(101%)" }], {
        duration: T.split.dur,
        easing: EASE_SPLIT,
      });
      void a.finished.then(done);
    } else if (mode === "fade") {
      void run(stage, [{ opacity: 1 }, { opacity: 0 }], { duration: T.reduced.fade, easing: "linear" }).finished.then(done);
    } else {
      done();
    }
  };

  if (reduceMotion) {
    // 150 ms fade only: the mark fades in solid, then the app replaces it.
    for (const el of [...parts.arms, parts.dotInk]) (el as HTMLElement).style.display = "none";
    const a = run(parts.fill, [{ opacity: 0 }, { opacity: 1 }], { duration: T.reduced.fade, easing: "linear" });
    void a.finished.then(() => call("splash_covered", { reduced: true }));
    return;
  }

  // 1. Burst: arms grow out of the middle with a little overshoot, staggered; the dot pops last.
  parts.arms.forEach((arm, i) => {
    run(
      arm,
      [
        { transform: "scale(0)", easing: EASE_BURST },
        { transform: "scale(1.06)", offset: 0.6, easing: EASE_SETTLE },
        { transform: "scale(1)" },
      ],
      { delay: T.burst.stagger[i] ?? 0, duration: T.burst.dur },
    );
  });
  run(
    parts.dotInk,
    [
      { transform: "scale(0)", easing: EASE_BURST },
      { transform: "scale(1.18)", offset: 0.6, easing: EASE_SETTLE },
      { transform: "scale(1)" },
    ],
    { delay: T.dot.at, duration: T.dot.dur },
  );

  // 2. Fill: every part goes solid together, on one curve.
  run(parts.fill, [{ opacity: 0 }, { opacity: 1 }], { delay: T.fill.at, duration: T.fill.dur, easing: EASE_SETTLE });

  // 3 + 4. Swirl (rotate + shrink), then the boom punch.
  const sw = T.swirl;
  const bm = T.boom;
  const total = sw.dur + bm.dur;
  const swirlEnd = `rotate(${sw.turn}deg) scale(${sw.scale})`;
  run(
    parts.swirl,
    [
      { transform: "rotate(0deg) scale(1)", easing: EASE_SWIRL },
      { transform: swirlEnd, offset: sw.dur / total, easing: EASE_BOOM },
      { transform: `rotate(${sw.turn + bm.extraTurn}deg) scale(${bm.scale})` },
    ],
    { delay: sw.at, duration: total },
  );
  // Trails: the same swirl, a few frames late and see-through, so the arms leave a sweep.
  parts.ghosts.forEach((g, i) => {
    const { lag, alpha } = T.ghosts[i];
    run(g, [{ transform: "rotate(0deg) scale(1)" }, { transform: swirlEnd }], {
      delay: sw.at + lag,
      duration: sw.dur,
      easing: EASE_SWIRL,
    });
    run(g, [{ opacity: 0 }, { opacity: alpha, offset: 0.25 }, { opacity: alpha * 0.7, offset: 0.85 }, { opacity: 0 }], {
      delay: sw.at + lag,
      duration: sw.dur,
      easing: "linear",
    });
  });

  // 4. The clay floods the whole window from the middle (same color as the mark).
  const s0 = (parts.S * 0.2) / parts.D;
  const flood = parts.disc.animate(
    [
      { transform: `scale(${s0})`, opacity: 1 },
      { transform: "scale(1)", opacity: 1 },
    ],
    { delay: T.flood.at, duration: T.flood.dur, easing: EASE_FLOOD, fill: "forwards" },
  );
  anims.push(flood);
  void flood.finished.then(() => {
    // Flat clay screen: swap in the two halves (identical color), drop the rest.
    parts.left.style.visibility = parts.right.style.visibility = "visible";
    parts.disc.style.display = parts.mark.style.display = "none";
    void call("splash_covered", { reduced: false });
  });
}

void main();
