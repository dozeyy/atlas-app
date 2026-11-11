import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/recursive/casl.css";
import "./styles/index.css";
import { App } from "./App";
import { AtlasProvider } from "./state/AtlasProvider";
import { getBackend, inTauri } from "./lib/ipc";
import { applyBoot } from "./lib/theme";
import { armIntro, installIntroReveal } from "./lib/intro";
import { installInputModality } from "./lib/inputModality";
import { installScrollbars } from "./lib/scrollbars";
import { installFrameSync } from "./lib/frameSync";
import { startSetup } from "./state/setupStore";

const backend = getBackend();

// Theme, platform and backdrop classes go on <html> before the first paint so
// the window never flashes the wrong colors.
applyBoot(backend.boot());
armIntro();
installIntroReveal();
installInputModality();
installScrollbars();
// Windows edge drags (crates/app/src/winframe.rs): a no-op outside WebView2.
installFrameSync();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AtlasProvider>
      <App />
    </AtlasProvider>
  </StrictMode>,
);

// Start reading the Claude toolkit now, so the Toolkit page is already full when it is opened.
startSetup();

// The screenshot tour (src/lib/shotTour.ts): only a debug build started for it, or the browser
// preview with `?tour`. Loaded on demand, so a normal start never fetches it, and compiled in only
// for the dev server or a VITE_ATLAS_TOUR=1 build (vite.config.ts), so a release has no tour chunk.
if (
  __ATLAS_TOUR_BUILD__ &&
  (window.__ATLAS_TOUR__ || (!inTauri() && new URLSearchParams(window.location.search).has("tour")))
) {
  void import("./lib/shotTour").then((m) => m.startTour());
}

// Give the display face a moment to arrive (it is bundled, so this is a few ms) so the first
// frame never shows the numbers in a fallback face and then swaps. Never wait more than 150 ms.
const fontReady = Promise.race([
  document.fonts?.load('760 1em "Recursive Variable"') ?? Promise.resolve(),
  new Promise((done) => setTimeout(done, 150)),
]).catch(() => {});

// Tell Rust we have painted: it shows the (hidden until now) window. Two frames, so the first
// frame is drawn. A hidden window gets no frames on macOS (WebKit pauses requestAnimationFrame
// until the window is on screen), and this one stays hidden until Rust hears from us: there the
// page reports once it is laid out, and the intro's reveal waits for real frames after the show.
void fontReady.then(() => {
  let told = false;
  const tell = () => {
    if (told) return;
    told = true;
    backend.frontendReady().catch(() => {});
  };
  requestAnimationFrame(() => requestAnimationFrame(tell));
  if (/Mac/.test(navigator.userAgent) && document.visibilityState === "hidden") window.setTimeout(tell, 50);
});
