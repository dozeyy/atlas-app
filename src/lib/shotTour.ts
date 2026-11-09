// The screenshot tour: walks every page the way a person would (keyboard shortcuts, clicks) and
// takes a picture at each stop. Two drivers use it, and nothing else ever loads it:
// - the real macOS app, debug build, started with ATLAS_SHOT_TOUR (crates/app/src/tour.rs and
//   tools/mac-check.sh): the script takes each picture with the system's own screencapture, light
//   and dark at 1280x800, light at 900x600;
// - the browser preview with the mock backend in Playwright WebKit (tools/webkit-shots.mjs, `?tour`):
//   Playwright sets the size and colour scheme and takes the pictures through window.__atlasCapture.
// A step whose target is missing still takes its picture and says so in the log: a page another
// branch changed must not stop the run.

import { getBackend, inTauri, tourStep } from "./ipc";
import { applyTheme } from "./theme";
import type { Theme } from "./types";

declare global {
  interface Window {
    __ATLAS_TOUR__?: boolean;
    /** Playwright: take a picture called `name`. */
    __atlasCapture?: (name: string) => Promise<void>;
    /** Playwright: a line for the run log. */
    __atlasLog?: (line: string) => Promise<void>;
    /** Playwright: the tour is over. */
    __atlasTourDone?: () => Promise<void>;
  }
}

interface Pass {
  prefix: string;
  theme?: Theme;
  size?: [number, number];
  /** Only these stops (all when absent). */
  only?: string[];
}

interface Driver {
  capture: (name: string) => Promise<void>;
  log: (line: string) => Promise<void>;
  size: (w: number, h: number) => Promise<void>;
  done: () => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor<T extends Element>(sel: string, ms = 8000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const el = document.querySelector<T>(sel);
    if (el) return el;
    if (Date.now() > end) return null;
    await sleep(100);
  }
}

const mac = () => document.documentElement.dataset.platform === "macos";

/** A key press as the keyboard sends it (Cmd on macOS, Ctrl elsewhere when `mod`). */
function press(key: string, mod = false): void {
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const init: KeyboardEventInit = { key, bubbles: true, cancelable: true, metaKey: mod && mac(), ctrlKey: mod && !mac() };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

function clickText(sel: string, text: string): boolean {
  const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.textContent?.trim() === text);
  el?.click();
  return !!el;
}

async function waitForIndex(log: Driver["log"]): Promise<void> {
  const backend = getBackend();
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    try {
      const s = await backend.usageStatus();
      if (s.firstIndexDone) {
        await log(`index ready: ${s.filesTracked} files`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  await log("index not ready after 90 s; going on");
}

type Stop = { name: string; settle: number; go: (d: Driver) => Promise<string | void> };

const go = (n: number) => async () => {
  press(String(n), true);
};

/** Every stop, in order. A stop returns a note when its target was missing. */
const STOPS: Stop[] = [
  { name: "dashboard", settle: 1600, go: go(1) },
  { name: "now", settle: 1200, go: go(2) },
  { name: "sessions", settle: 1200, go: go(3) },
  {
    name: "session-detail",
    settle: 1600,
    go: async () => {
      const row = await waitFor<HTMLElement>("main .row-btn");
      if (!row) return "no session row";
      row.click();
    },
  },
  { name: "toolkit", settle: 1200, go: go(4) },
  {
    name: "toolkit-skills",
    settle: 1200,
    go: async () => {
      const tile = (await waitFor<HTMLElement>('[data-tile^="skill"]', 4000)) ?? document.querySelector<HTMLElement>("[data-tile]");
      if (!tile) return "no type tile";
      tile.click();
    },
  },
  {
    name: "skill-item",
    settle: 1200,
    go: async () => {
      const card = await waitFor<HTMLElement>("[data-item-card]");
      if (!card) return "no item card";
      card.click();
    },
  },
  { name: "history", settle: 1400, go: async () => (press("Escape"), await sleep(300), press("5", true)) },
  { name: "settings", settle: 1000, go: go(6) },
  {
    name: "shortcuts",
    settle: 800,
    go: async () => {
      const menu = document.querySelector<HTMLElement>('button[aria-label="Menu"]');
      if (!menu) return "no menu button";
      menu.click();
      const help = await waitFor<HTMLElement>('[data-sub="help"]', 2000);
      if (!help) return "no Help entry";
      help.click();
      await sleep(200);
      if (!clickText('[role="menuitem"]', "Keyboard shortcuts")) return "no Keyboard shortcuts entry";
    },
  },
  { name: "wrapped-1", settle: 2400, go: async () => (press("Escape"), await sleep(300), press("7", true)) },
  { name: "wrapped-2", settle: 2400, go: async () => press("ArrowRight") },
  { name: "wrapped-3", settle: 2400, go: async () => press("ArrowRight") },
  { name: "wrapped-4", settle: 2400, go: async () => press("ArrowRight") },
];

async function runPass(d: Driver, pass: Pass): Promise<void> {
  if (pass.theme) {
    applyTheme(pass.theme);
    await getBackend().updateSettings({ theme: pass.theme }).catch(() => {});
  }
  if (pass.size) await d.size(pass.size[0], pass.size[1]);
  await sleep(800);
  let n = 0;
  for (const stop of STOPS) {
    if (pass.only && !pass.only.includes(stop.name)) continue;
    n += 1;
    const name = `${pass.prefix}-${String(n).padStart(2, "0")}-${stop.name}`;
    let note: string | void = undefined;
    try {
      note = await stop.go(d);
    } catch (e) {
      note = `failed: ${String(e)}`;
    }
    await sleep(stop.settle);
    try {
      await d.capture(name);
    } catch (e) {
      note = `${note ? `${note}; ` : ""}no picture: ${String(e)}`;
    }
    // The page should not scroll at 1280x800 (a standing rule); say how much it would.
    const main = document.querySelector("main");
    const over = main ? main.scrollHeight - main.clientHeight : 0;
    const scroll = over > 1 ? ` (page scrolls ${over}px)` : "";
    await d.log(`${name}: ${note ? note : "ok"}${scroll}`);
  }
  // Leave nothing open for the next pass.
  press("Escape");
  await sleep(200);
}

function realDriver(): Driver {
  return {
    capture: (name) => tourStep("capture", name),
    log: (line) => tourStep("log", line).catch(() => {}),
    size: (w, h) => tourStep("size", `${w}x${h}`),
    done: () => tourStep("done"),
  };
}

function browserDriver(): Driver {
  return {
    capture: async (name) => window.__atlasCapture?.(name),
    log: async (line) => window.__atlasLog?.(line),
    size: async () => {},
    done: async () => window.__atlasTourDone?.(),
  };
}

export async function startTour(): Promise<void> {
  const real = inTauri();
  const d = real ? realDriver() : browserDriver();
  await waitFor(".titlebar", 15_000);
  await sleep(1200);
  await d.log(`tour: ${real ? "app" : "browser"}, platform ${document.documentElement.dataset.platform}`);
  await waitForIndex(d.log);
  const small = ["dashboard", "sessions", "session-detail", "toolkit", "skill-item", "settings", "wrapped-1"];
  const passes: Pass[] = real
    ? [
        { prefix: "light", theme: "light", size: [1280, 800] },
        { prefix: "dark", theme: "dark", size: [1280, 800] },
        { prefix: "small", theme: "light", size: [900, 600], only: small },
      ]
    : [{ prefix: new URLSearchParams(window.location.search).get("prefix") ?? "web" }];
  try {
    for (const p of passes) await runPass(d, p);
  } catch (e) {
    await d.log(`tour stopped: ${String(e)}`);
  } finally {
    if (real) await getBackend().updateSettings({ theme: "system" }).catch(() => {});
    await d.done();
  }
}
