// Launch splash: the Atlas mark bursts out of the middle, fills solid, swirls, booms
// into a flat clay screen, and the clay slides apart to show the app. Everything
// animates transform or opacity only. Rust shows this window over the desktop, and
// closes it once the real main window sits underneath.

import { invoke } from "@tauri-apps/api/core";
import "../styles/tokens.css";
import "./splash.css";
import { ARM_WEDGES, DOT_PATH, MARK_CENTER, MARK_VIEWBOX, SPARK_PATH } from "./markGeometry";
import { SplashPlayer, type PlayerAnimation } from "./player";
import {
  DISC_R,
  EASE_BURST,
  EASE_RIPPLE,
  EASE_SETTLE,
  EASE_SPIN_IN,
  EASE_SPIN_OUT,
  EASE_WIPE,
  T,
  cubicBezier,
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

// macOS plays the keyframes frame by frame (player.ts says why); elsewhere the Web Animations API.
// ATLAS_SPLASH_PLAYER=js|waapi picks one for tests.
const forcedPlayer = (window as { __ATLAS_SPLASH_PLAYER__?: string }).__ATLAS_SPLASH_PLAYER__;
const framePlayer = forcedPlayer ? forcedPlayer === "js" : /Mac/i.test(navigator.platform || navigator.userAgent);

const call = <R = void>(cmd: string, args?: Record<string, unknown>): Promise<R> =>
  inTauri ? invoke<R>(cmd, args) : Promise.resolve(undefined as R);

// Diagnostics (ATLAS_INTRO_TRACE=1): the page's clock, logged by Rust next to its own timings.
const traceOn = (window as { __ATLAS_INTRO_TRACE__?: boolean }).__ATLAS_INTRO_TRACE__ === true;
const trace = (msg: string) => {
  if (traceOn) void call("intro_trace", { msg: `splash page +${Math.round(performance.now())} ms: ${msg}` }).catch(() => {});
};

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

type RGB = readonly [number, number, number];
const hex = (v: string, fallback: RGB): RGB => {
  const m = /^#?([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = (c: RGB, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

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
  const ghosts = Array.from({ length: T.trail.count }, () => markLayer(mark, solid));
  const swirl = div("layer", mark);
  swirl.style.inset = "0";
  const arms = ARM_WEDGES.map((_, i) =>
    markLayer(swirl, `<g clip-path="url(#w${i})"><use href="#spark" class="ink"/></g>`),
  );
  const dotInk = markLayer(swirl, `<use href="#dot" class="ink"/>`);
  const fill = markLayer(swirl, solid);
  // The same solid mark in a lighter clay, faded in while spinning so the arms stay readable.
  const lead = markLayer(swirl, `<use href="#spark" class="clay-light"/><use href="#dot" class="clay-light"/>`);
  for (const el of [...ghosts, swirl, ...arms, fill, lead]) el.style.transformOrigin = origin;
  mark.style.willChange = "opacity";
  dotInk.style.transformOrigin = `${pct(dotCx)} ${pct(dotCy)}`;

  // Ripple discs, bottom to top, all as big as the window's diagonal and scaled from the disc's
  // rim. They sit behind the mark. The top one doubles as the solid disc and ends as flat clay.
  const D = Math.ceil(Math.hypot(W, H)) + 8;
  const rings = Array.from({ length: T.ripple.rings }, (_, i) => {
    const el = document.createElement("div");
    el.className = i === T.ripple.rings - 1 ? "ring last" : `ring r${i}`;
    Object.assign(el.style, {
      width: `${D}px`,
      height: `${D}px`,
      left: `${(W - D) / 2}px`,
      top: `${(H - D) / 2}px`,
    });
    stage.insertBefore(el, mark);
    return el;
  });
  // The wipe: a canvas (the only part that is drawn per frame) holds the flat clay and, once
  // the app is ready underneath, a growing hole in it. Hidden until the ripple has filled up.
  const dpr = window.devicePixelRatio || 1;
  const wipe = document.createElement("canvas");
  wipe.className = "wipe";
  wipe.width = Math.round(W * dpr);
  wipe.height = Math.round(H * dpr);
  stage.appendChild(wipe);
  return { S, D, k, W, H, dpr, mark, ghosts, swirl, arms, dotInk, fill, lead, rings, wipe };
}

/** The page loads at a placeholder size; Rust resizes the window to the main window's rect.
 *  Wait until the viewport really is that size before laying anything out. */
async function viewportIs(width: number, height: number): Promise<void> {
  const dpr = window.devicePixelRatio || 1;
  const close = () =>
    Math.abs(window.innerWidth * dpr - width) <= 2 && Math.abs(window.innerHeight * dpr - height) <= 2;
  const until = performance.now() + 400;
  while (!close() && performance.now() < until) await new Promise((r) => setTimeout(r, 4));
}

async function main() {
  const stage = document.getElementById("stage")!;

  // Rust fits and shows this window, then answers; the layout and timeline start after that.
  let radius = 0;
  trace(`loaded, viewport ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}, ${framePlayer ? "frame player" : "web animations"}`);
  try {
    const cfg = await call<{ radius: number; width: number; height: number }>("splash_ready");
    radius = cfg?.radius ?? 0;
    trace(`shown, asked for ${cfg?.width}x${cfg?.height}`);
    if (cfg) await viewportIs(cfg.width, cfg.height);
  } catch {
    return; // the intro was abandoned; Rust closes this window
  }
  trace(`viewport ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`);
  stage.style.setProperty("--stage-radius", `${radius}px`);
  const parts = build(stage);
  // Let the compositor raster every layer once (three frames at 1 % opacity, which no one can
  // see on a transparent window) so no frame of the real timeline pays for a first raster.
  const warm = [...parts.ghosts, ...parts.rings, parts.lead, parts.fill];
  stage.style.opacity = "0.01";
  for (const el of warm) el.style.opacity = "1";
  parts.wipe.style.visibility = "visible";
  parts.wipe.getContext("2d")?.fillRect(0, 0, 1, 1);
  for (let i = 0; i < 3; i++) await new Promise<void>((r) => requestAnimationFrame(() => r()));
  trace("warm frames done, timeline starts");
  stage.style.opacity = "";
  for (const el of warm) el.style.opacity = "";
  parts.wipe.style.visibility = "";

  const anims: PlayerAnimation[] = [];
  const player = framePlayer ? new SplashPlayer() : null;
  const run = (el: Element, keyframes: Keyframe[], opts: KeyframeAnimationOptions): PlayerAnimation => {
    const a = player ? player.run(el, keyframes, opts) : el.animate(keyframes, { fill: "both", ...opts });
    anims.push(a);
    return a;
  };

  // Frame timing, from the first frame until the splash is done.
  const deltas: number[] = [];
  let last = 0;
  let t0 = 0;
  let startMs = 0;
  let frameNo = 0;
  let sampling = true;
  const tick = (now: number) => {
    if (!sampling) return;
    frameNo++;
    if (frameNo === 1) t0 = now;
    else if (frameNo === 2) startMs = now - last; // the animations start here; reported apart
    else deltas.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  if (traceOn) {
    const probe = window.setInterval(() => {
      const a = anims[0];
      trace(
        `rAF frames ${frameNo}, timeline ${Math.round(Number(document.timeline.currentTime ?? -1))}, ` +
          `first anim ${a ? `${a.playState} ${Math.round(Number(a.currentTime ?? -1))}` : "none"}, ` +
          `${document.visibilityState}, focus ${document.hasFocus()}`,
      );
      if (!sampling) window.clearInterval(probe);
    }, 200);
  }

  let finishing = false;
  const done = () => {
    if (finishing) return;
    finishing = true;
    sampling = false;
    void call("splash_done", { report: summarizeFrames(deltas, performance.now() - t0, startMs) });
  };

  // The clay layer. radius 0 = flat clay; otherwise a hole of that radius with a soft rim
  // (a lighter clay ring inside the feather).
  const css = getComputedStyle(document.documentElement);
  const clay = hex(css.getPropertyValue("--brand-mark"), [220, 120, 77]);
  const light = hex(css.getPropertyValue("--brand-mark-light"), [240, 153, 108]);
  const ctx = parts.wipe.getContext("2d");
  const drawClay = (radius: number) => {
    if (!ctx) return;
    const { W, H, dpr } = parts;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (radius <= 0) {
      ctx.fillStyle = rgba(clay, 1);
    } else {
      const f = T.wipe.feather;
      const r1 = radius + f;
      const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, r1);
      g.addColorStop(0, rgba(clay, 0));
      g.addColorStop(radius / r1, rgba(clay, 0));
      g.addColorStop((radius + f * 0.5) / r1, rgba(light, 0.9));
      g.addColorStop(1, rgba(clay, 1));
      ctx.fillStyle = g;
    }
    ctx.fillRect(0, 0, W, H);
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
    trace(`finish: ${mode}`);
    if (mode === "wipe") {
      // The ripple played backwards: a hole opens from the middle and the clay is gone.
      const ease = cubicBezier(...EASE_WIPE);
      const rEnd = Math.hypot(parts.W, parts.H) / 2 + T.wipe.feather + 2;
      const begin = performance.now();
      const frame = (now: number) => {
        const t = Math.min(1, Math.max(0, (now - begin) / T.wipe.dur));
        drawClay(rEnd * ease(t));
        if (t < 1) requestAnimationFrame(frame);
        else done();
      };
      requestAnimationFrame(frame);
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
    player?.start();
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

  // 3. Spin with trails: the mark turns, faster and faster, and every copy of it a little behind
  // leaves a see-through trail. The trails close the gaps between the arms into a disc.
  const sp = T.spin;
  const total = sp.dur1 + sp.dur2;
  const spinKeys: Keyframe[] = [
    { transform: "rotate(0deg)", easing: EASE_SPIN_IN },
    { transform: `rotate(${sp.turn1}deg)`, offset: sp.dur1 / total, easing: EASE_SPIN_OUT },
    { transform: `rotate(${sp.turn1 + sp.turn2}deg)` },
  ];
  run(parts.swirl, spinKeys, { delay: sp.at, duration: total });
  parts.ghosts.forEach((g, i) => {
    const lag = ((i + 1) * T.trail.lagMax) / T.trail.count;
    run(g, spinKeys, { delay: sp.at + lag, duration: total });
    run(g, [{ opacity: 0 }, { opacity: T.trail.alpha }], {
      delay: sp.at + lag,
      duration: T.trail.fadeIn,
      easing: "linear",
    });
  });
  run(parts.lead, [{ opacity: 0 }, { opacity: 1 }], { delay: T.lead.at, duration: T.lead.dur, easing: EASE_SETTLE });
  run(parts.mark, [{ opacity: 1 }, { opacity: 0 }], { delay: T.markFade.at, duration: T.markFade.dur, easing: "linear" });

  // 4. The disc firms up, then the ripple rolls out: nested rings of slightly different clay,
  // the last (flat clay) fills the window.
  const rim = (DISC_R * parts.k) / (parts.D / 2);
  const top = parts.rings.length - 1;
  let rippleDone: PlayerAnimation | undefined;
  parts.rings.forEach((el, i) => {
    const start = T.ripple.at + i * T.ripple.stagger;
    const from = i === top ? rim : rim * 0.92; // the inner rings wait under the top disc
    if (i === top) {
      run(el, [{ opacity: 0 }, { opacity: 1 }], { delay: T.core.at, duration: T.core.dur, easing: EASE_SETTLE });
    } else {
      run(el, [{ opacity: 0 }, { opacity: 1 }], { delay: start, duration: 1, easing: "linear" });
    }
    const a = run(el, [{ transform: `scale(${from})` }, { transform: "scale(1)" }], {
      delay: start,
      duration: T.ripple.dur,
      easing: EASE_RIPPLE,
    });
    if (i === top) rippleDone = a;
  });
  void rippleDone!.finished.then(() => {
    // Flat clay screen: the canvas takes over (identical color), drop the rest.
    trace("clay screen");
    drawClay(0);
    parts.wipe.style.visibility = "visible";
    parts.mark.style.display = "none";
    for (const el of parts.rings) el.style.display = "none";
    void call("splash_covered", { reduced: false });
  });
  player?.start();
}

void main();
