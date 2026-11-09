// Atlas Setup's window: the Trail Map. The Atlas mark draws itself at the summit, contour
// rings ripple out behind it like a map forming, and a dotted trail climbs from the corner
// toward it as the chats are read and Atlas is installed. When everything is done the
// summit spark pops and the sheet eases out as Atlas's own intro begins.
//
// All motion is transform, opacity or stroke offsets (WAAPI / CSS transitions): nothing
// runs per frame in this page, and nothing at all runs per frame on the Rust side.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "../styles/tokens.css";
import "./setup.css";
import { DOT_PATH, MARK_CENTER, MARK_VIEWBOX, SPARK_PATH } from "../splash/markGeometry";
import {
  CLEAR,
  EMPTY_SNAPSHOT,
  MARK_PX,
  RING_COUNT,
  SHEET,
  SUMMIT,
  ringPath,
  screenFor,
  splitNumbers,
  trailPath,
  trailProgress,
  isOwnPress,
  type Action,
  type KeyPress,
  type Snapshot,
} from "./view";

const NS = "http://www.w3.org/2000/svg";
const inTauri = typeof (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";

const EASE_OUT = "cubic-bezier(0.2, 0.7, 0.2, 1)";
const EASE_EXPO = "cubic-bezier(0.16, 1, 0.3, 1)";
const EASE_SPRING = "cubic-bezier(0.34, 1.56, 0.64, 1)";

const $ = <T extends Element>(id: string): T => document.getElementById(id) as unknown as T;

const call = <R = void>(cmd: string, args?: Record<string, unknown>): Promise<R> =>
  inTauri ? invoke<R>(cmd, args) : Promise.resolve(undefined as R);

let reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
let trailLen = 0;
let shown = 0;
let celebrated = false;
let dotCenter = { x: 0, y: 0 };
let ringCenter = { x: 0, y: 0 };
let current: Snapshot = EMPTY_SNAPSHOT;
/** Resolves once the opening animation has played (the finish waits for it on a quick install). */
let openingDone: () => void = () => undefined;
const openingPlayed = new Promise<void>((res) => (openingDone = res));

// ------------------------------------------------------------------ the map

function place() {
  const k = MARK_PX / MARK_VIEWBOX;
  $<SVGPathElement>("spark").setAttribute("d", SPARK_PATH);
  $<SVGPathElement>("dot").setAttribute("d", DOT_PATH);
  // The middle of the arms sits on the summit; the art's own coordinates stay untouched.
  $("mark-pos").setAttribute(
    "transform",
    `translate(${SUMMIT.x - MARK_CENTER.x * k} ${SUMMIT.y - MARK_CENTER.y * k}) scale(${k})`,
  );
  $<SVGGElement>("mark").style.transformOrigin = `${MARK_CENTER.x}px ${MARK_CENTER.y}px`;
  const box = $<SVGGraphicsElement>("dot").getBBox();
  dotCenter = {
    x: SUMMIT.x - MARK_CENTER.x * k + (box.x + box.width / 2) * k,
    y: SUMMIT.y - MARK_CENTER.y * k + (box.y + box.height / 2) * k,
  };

  // The contours are centred on the middle of the mark's ink (the arms plus the dot), so the
  // mark sits in the middle of its own rings, not just on the middle of its arms.
  const ink = ($("spark") as unknown as SVGGraphicsElement).getBBox();
  const dotBox = $<SVGGraphicsElement>("dot").getBBox();
  const x0 = Math.min(ink.x, dotBox.x);
  const y0 = Math.min(ink.y, dotBox.y);
  const x1 = Math.max(ink.x + ink.width, dotBox.x + dotBox.width);
  const y1 = Math.max(ink.y + ink.height, dotBox.y + dotBox.height);
  ringCenter = {
    x: SUMMIT.x - MARK_CENTER.x * k + ((x0 + x1) / 2) * k,
    y: SUMMIT.y - MARK_CENTER.y * k + ((y0 + y1) / 2) * k,
  };

  const rings = $("rings");
  for (let i = 0; i < RING_COUNT; i++) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", ringPath(ringCenter.x, ringCenter.y, i));
    p.style.transformOrigin = `${ringCenter.x}px ${ringCenter.y}px`;
    rings.appendChild(p);
  }

  const trail = trailPath();
  for (const id of ["trail-base", "trail-done", "trail-reveal", "trail-reveal-b", "hole-trail"]) $(id).setAttribute("d", trail);
  trailLen = $<SVGPathElement>("trail-base").getTotalLength();
  for (const id of ["trail-reveal", "trail-reveal-b"]) {
    const reveal = $<SVGPathElement>(id).style;
    reveal.strokeDasharray = `${trailLen} ${trailLen}`;
    reveal.strokeDashoffset = `${trailLen}`;
  }
  const start = $<SVGPathElement>("trail-base").getPointAtLength(0);
  $<SVGCircleElement>("walker").style.transform = `translate(${start.x}px, ${start.y}px)`;

  placeHoles(k);
}

/** The fixed gaps in the contours: the sheet's edge, the mark, the close button, the spark's
 *  rays. (The trail's gap is the trail itself, stroked wide.) There is no gap for the words
 *  or the buttons: contours run behind them. */
function placeHoles(k: number) {
  // The mark's own shape, grown by the clearance (plus a little for its pop), in its own units.
  $("hole-mark").setAttribute("transform", $("mark-pos").getAttribute("transform") ?? "");
  const grown = `${14 + (2 * (CLEAR + 3)) / k}`;
  for (const id of ["hole-spark", "hole-dot"]) $<SVGElement>(id).style.strokeWidth = grown;

  const x = $("hole-x");
  x.setAttribute("cx", `${SHEET.w - 28}`);
  x.setAttribute("cy", "28");
  x.setAttribute("r", `${20 + CLEAR}`);

  const rays = $<SVGElement>("hole-rays");
  rays.setAttribute("cx", `${dotCenter.x}`);
  rays.setAttribute("cy", `${dotCenter.y}`);
  rays.setAttribute("r", "54");
  rays.style.opacity = "0";
}

/** Move the walker and the lit part of the trail to `p` (0..1). The change eases by CSS. */
function setTrail(p: number) {
  const at = Math.min(1, Math.max(0, p));
  for (const id of ["trail-reveal", "trail-reveal-b"]) $<SVGPathElement>(id).style.strokeDashoffset = `${trailLen * (1 - at)}`;
  const pt = $<SVGPathElement>("trail-base").getPointAtLength(trailLen * at);
  $<SVGCircleElement>("walker").style.transform = `translate(${pt.x}px, ${pt.y}px)`;
}

function fade(el: Element, from: number, to: number, ms: number, delay = 0): Animation {
  return el.animate([{ opacity: from }, { opacity: to }], { duration: ms, delay, easing: EASE_OUT, fill: "both" });
}

/** The opening: the mark draws itself, the rings ripple out, then the trail and words arrive.
 *  Resolves when it has played, so the finish never cuts it short on a quick install. */
function opening(): Promise<void> {
  playOpening();
  return new Promise((done) => window.setTimeout(done, reduce ? 320 : 2000));
}

function playOpening() {
  const spark = $<SVGUseElement>("mark-spark");
  const dot = $<SVGUseElement>("mark-dot");
  const rings = [...$("rings").children];
  const finalOpacity = (i: number) => 0.3 - i * 0.027;
  const walker = $("walker");
  const base = $("trail-base");
  const done = $("trail-done");

  if (reduce) {
    for (const el of [spark, dot]) el.style.fillOpacity = "1";
    rings.forEach((r, i) => fade(r, 0, finalOpacity(i), 300));
    fade(base, 0, 0.9, 300);
    fade(done, 0, 1, 300);
    fade(walker, 0, 1, 300);
    fade($("copy"), 0, 1, 300);
    // The trail's gap arrives with the trail.
    fade($("hole-trail"), 0, 1, 300);
    return;
  }

  // The mark draws itself, stroke by stroke, then fills with clay.
  const draw = (use: SVGUseElement, path: SVGPathElement, delay: number, ms: number) => {
    const len = path.getTotalLength();
    use.style.strokeDasharray = `${len} ${len}`;
    use.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: ms, delay, easing: EASE_EXPO, fill: "both" });
    use.animate([{ fillOpacity: 0 }, { fillOpacity: 1 }], { duration: 380, delay: delay + ms * 0.62, easing: EASE_OUT, fill: "both" });
  };
  draw(spark, $<SVGPathElement>("spark"), 80, 980);
  draw(dot, $<SVGPathElement>("dot"), 780, 420);
  dot.animate(
    [{ transform: "scale(0.6)" }, { transform: "scale(1.18)", offset: 0.55 }, { transform: "scale(1)" }],
    { duration: 520, delay: 1000, easing: EASE_SPRING, fill: "both" },
  );
  (dot as SVGElement).style.transformBox = "fill-box";
  (dot as SVGElement).style.transformOrigin = "center";

  // Contour rings ripple outward from the summit like the map forming behind it.
  // Every ring grows on the SAME curve (so they stay nested, never touching, at every frame:
  // a ring that starts later would otherwise lag inside its neighbour); only the fade-in is
  // staggered, inner rings first.
  rings.forEach((r, i) => {
    r.animate(
      [{ transform: "scale(0.6)" }, { transform: "scale(1.03)", offset: 0.6 }, { transform: "scale(1)" }],
      { duration: 1100, delay: 700, easing: EASE_EXPO, fill: "both" },
    );
    r.animate(
      [{ opacity: 0 }, { opacity: finalOpacity(i) * 1.8, offset: 0.6 }, { opacity: finalOpacity(i) }],
      { duration: 800, delay: 700 + i * 90, easing: EASE_OUT, fill: "both" },
    );
  });

  // Then the trail and the words.
  fade(base, 0, 0.9, 500, 1500);
  fade(done, 0, 1, 500, 1500);
  fade(walker, 0, 1, 400, 1700);
  fade($("copy"), 0, 1, 420, 1500);
  fade($("hole-trail"), 0, 1, 500, 1500);
  $("copy").animate([{ transform: "translateY(8px)" }, { transform: "none" }], { duration: 420, delay: 1500, easing: EASE_OUT, fill: "both" });
}

/** The summit spark: eight rays and a small pop of the mark. Returns when it has played. */
function spark(): Promise<void> {
  const mark = $<SVGGElement>("mark");
  if (reduce) return Promise.resolve();
  const rays = $("rays");
  const anims: Animation[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const line = document.createElementNS(NS, "line");
    const [r0, r1] = [12, 26];
    line.setAttribute("x1", `${dotCenter.x + Math.cos(a) * r0}`);
    line.setAttribute("y1", `${dotCenter.y + Math.sin(a) * r0}`);
    line.setAttribute("x2", `${dotCenter.x + Math.cos(a) * r1}`);
    line.setAttribute("y2", `${dotCenter.y + Math.sin(a) * r1}`);
    line.style.transformOrigin = `${dotCenter.x}px ${dotCenter.y}px`;
    rays.appendChild(line);
    anims.push(
      line.animate(
        [
          { opacity: 0, transform: "scale(0.5)" },
          { opacity: 1, transform: "scale(1.1)", offset: 0.3 },
          { opacity: 0, transform: "scale(1.7)" },
        ],
        { duration: 620, easing: EASE_EXPO, fill: "both" },
      ),
    );
  }
  // The rays get a clean circle of their own in the contours while they fly.
  anims.push(
    $("hole-rays").animate([{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], {
      duration: 700,
      easing: "linear",
    }),
  );
  anims.push(
    mark.animate([{ transform: "scale(1)" }, { transform: "scale(1.07)", offset: 0.4 }, { transform: "scale(1)" }], {
      duration: 560,
      easing: EASE_SPRING,
    }),
  );
  return Promise.all(anims.map((a) => a.finished)).then(() => undefined);
}

/** The sheet eases out (scale .98 and fade, 250 ms), then the program ends. */
function leave(): Promise<void> {
  if (!inTauri) return Promise.resolve(); // a browser tab has nothing to close
  const sheet = $("sheet");
  sheet.classList.add("leaving");
  return new Promise((done) => window.setTimeout(done, reduce ? 200 : 260));
}

// ------------------------------------------------------------------ the words

const optData = $<HTMLInputElement>("opt-data");
let lastLine = "";
let lastBad = false;

function renderLine(text: string, bad: boolean) {
  if (text === lastLine && bad === lastBad) return;
  lastLine = text;
  lastBad = bad;
  const el = $("line");
  el.classList.toggle("bad", bad);
  el.replaceChildren(
    ...splitNumbers(text).map((part) => {
      if (!part.num) return document.createTextNode(part.text);
      const s = document.createElement("span");
      s.className = "num";
      s.textContent = part.text;
      return s;
    }),
  );
}

function renderButton(id: string, spec: { label: string; action: Action } | null) {
  const b = $<HTMLButtonElement>(id);
  b.hidden = spec === null;
  if (spec) {
    if (b.textContent !== spec.label) b.textContent = spec.label;
    b.dataset.action = spec.action;
  }
}

function render(s: Snapshot) {
  current = s;
  const screen = screenFor(s, optData.checked);
  renderLine(screen.line, s.phase === "error");
  renderButton("primary", screen.primary);
  $<HTMLElement>("databox").hidden = !screen.dataBox;
  $<HTMLButtonElement>("x").disabled = !screen.closable;
  // The trail only ever climbs: a read that restarts must not walk it backward. (Once a
  // person retries, it starts over from the foot.)
  shown = s.phase === "installing" && s.install <= 0.05 ? trailProgress(s) : Math.max(shown, trailProgress(s));
  setTrail(shown);
  // Installing finishes by itself: Atlas is already starting, so pop the spark and ease out.
  // (In a browser, `?spark=` holds the celebration back so designFrame can stop it mid-flight.)
  if (s.phase === "done" && s.mode === "install" && !celebrated && (inTauri || !new URLSearchParams(location.search).has("spark"))) {
    celebrated = true;
    void finishUp();
  }
}

/** Everything is installed and Atlas is starting: pop the spark, ease out, end. */
async function finishUp() {
  setTrail(1);
  await openingPlayed;
  await spark();
  await leave();
  await call("finish");
}

async function act(action: Action) {
  switch (action) {
    case "uninstall":
      await call("begin_uninstall", { removeData: optData.checked });
      break;
    case "retry":
      await call("retry");
      break;
    case "closeAtlas":
      await call("close_atlas_and_continue");
      break;
    case "close":
      await leave();
      await call("finish");
      break;
  }
}

function wire() {
  // The action buttons (Install, Close Atlas and continue, Retry, Open Atlas) act only on a
  // person's own press: a real mouse click, or a real Enter / Space keydown on that button. A click
  // that nothing human is behind (a script's .click(), a keyup with no keydown in this window)
  // does nothing, so Setup can never start installing by itself.
  let keyPress: KeyPress | null = null;
  window.addEventListener(
    "keydown",
    (e) => {
      const id = (e.target as HTMLElement | null)?.id ?? "";
      keyPress = e.isTrusted && (e.key === "Enter" || e.key === " ") && !e.repeat ? { id, at: e.timeStamp } : null;
    },
    true,
  );
  window.addEventListener("blur", () => (keyPress = null));
  $<HTMLButtonElement>("primary").addEventListener("click", (e) => {
    if (!isOwnPress(e, "primary", keyPress)) return;
    keyPress = null;
    void act($<HTMLButtonElement>("primary").dataset.action as Action);
  });
  $<HTMLButtonElement>("x").addEventListener("click", () => {
    if (current.phase === "done") void act("close");
    else void call("cancel");
  });
  // The box changes what the Done line says, so the line follows it.
  optData.addEventListener("change", () => render(current));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$<HTMLButtonElement>("x").disabled) $<HTMLButtonElement>("x").click();
  });
}

// ------------------------------------------------------------------ start

/** Outside the real program (a browser tab while designing) there is no Rust: play a short script. */
function devMock(): Promise<Snapshot> {
  const base = { ...EMPTY_SNAPSHOT };
  const q = new URLSearchParams(location.search).get("mock");
  const reading = (done: number) => ({ available: true, done, total: 1881, tokens: done * 14_500, finished: done >= 1881, failed: false, waiting: false });
  const work = { ...base, phase: "installing" as const };
  const out = { ...base, mode: "uninstall" as const };
  const frames: Record<string, Snapshot> = {
    // Installing starts by itself: these are the frames of the one window it ever shows.
    unpack: { ...work, stage: "unpack", install: 0.04, reading: reading(300) },
    installing: { ...work, stage: "install", install: 0.6, reading: reading(940) },
    opening: { ...work, stage: "opening", install: 1, reading: reading(1500) },
    done: { ...base, phase: "done", install: 1, reading: reading(1500) },
    error: { ...base, phase: "error", error: "The installer stopped before it finished (code 2). Close other programs and try again.", reading: reading(1881) },
    close: { ...base, phase: "closeAtlas", reading: reading(1881) },
    // The remover.
    remove: { ...out },
    removing: { ...out, phase: "installing", stage: "removing", install: 0.5 },
    removedata: { ...out, phase: "installing", stage: "data", install: 0.9 },
    removed: { ...out, phase: "done", install: 1 },
    removeerror: { ...out, phase: "error", error: "The remover stopped before it finished (code 5). Close other programs and try again." },
  };
  return Promise.resolve(frames[q ?? "installing"] ?? frames.installing);
}

async function start() {
  place();
  wire();
  const snap = inTauri ? await invoke<Snapshot>("setup_state") : await devMock();
  reduce = reduce || snap.reduceMotion;
  document.documentElement.classList.toggle("reduce", reduce);
  render(snap);
  if (inTauri) {
    await listen<Snapshot>("setup:state", (e) => render(e.payload));
  }
  // First frame is painted with everything still hidden; only then does Rust show the window.
  $("sheet").classList.add("show");
  await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  await call("setup_ready");
  void opening().then(openingDone);
  if (!inTauri) designFrame();
}

/** Browser-only design aid (never runs in the real program): `?t=900` stops every animation at
 *  that time so a frame can be looked at. */
function designFrame() {
  const q = new URLSearchParams(location.search);
  const t = q.get("t");
  const sparkAt = q.get("spark");
  if (sparkAt !== null && current.phase === "done") {
    celebrated = true;
    void finishUp();
  }
  if (t === null && sparkAt === null) return;
  for (const a of document.getAnimations()) {
    const el = (a.effect as KeyframeEffect | null)?.target as Element | null;
    const isSpark = !!el && (el.closest("#rays") !== null || el.id === "hole-rays" || el.id === "mark");
    const at = isSpark ? sparkAt : t;
    if (at === null) continue;
    a.pause();
    a.currentTime = Number(at);
  }
}

void start();
