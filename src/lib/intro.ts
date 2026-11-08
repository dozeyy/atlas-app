// The main window's half of the launch intro. While the splash plays, the page is
// painted but hidden, with #root pre-scaled to 0.96 (`data-intro="pending"`). At the
// handoff Rust shows the window under the splash and calls __atlasIntroReveal, which
// lets the app land (scale 0.96 -> 1, CSS in index.css) and tells Rust the first
// frame is on screen so the splash can slide away.

import { invoke } from "@tauri-apps/api/core";

declare global {
  interface Window {
    __ATLAS_INTRO__?: boolean;
    __atlasIntroReveal?: (instant: boolean, ack: boolean) => void;
  }
}

const LAND_MS = 560;

/** Before the first paint: start pre-scaled when the intro is going to play. */
export function armIntro(root: HTMLElement = document.documentElement): void {
  if (window.__ATLAS_INTRO__) root.dataset.intro = "pending";
}

/** Install the hook Rust calls. Safe to call (and to be called) without an intro. */
export function installIntroReveal(root: HTMLElement = document.documentElement): void {
  window.__atlasIntroReveal = (instant, ack) => {
    const settle = () => {
      if (instant) delete root.dataset.intro;
      else {
        root.dataset.intro = "play";
        window.setTimeout(() => delete root.dataset.intro, LAND_MS + 80);
      }
    };
    // Two frames: the shown window has drawn the pending state before it moves.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        settle();
        if (ack) void invoke("intro_main_painted").catch(() => {});
      }),
    );
  };
}
