import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/recursive/casl.css";
import "./styles/index.css";
import { App } from "./App";
import { AtlasProvider } from "./state/AtlasProvider";
import { getBackend } from "./lib/ipc";
import { applyBoot } from "./lib/theme";
import { armIntro, installIntroReveal } from "./lib/intro";
import { installInputModality } from "./lib/inputModality";
import { startSetup } from "./state/setupStore";

const backend = getBackend();

// Theme, platform and backdrop classes go on <html> before the first paint so
// the window never flashes the wrong colors.
applyBoot(backend.boot());
armIntro();
installIntroReveal();
installInputModality();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AtlasProvider>
      <App />
    </AtlasProvider>
  </StrictMode>,
);

// Start reading the Claude toolkit now, so the Toolkit page is already full when it is opened.
startSetup();

// Give the display face a moment to arrive (it is bundled, so this is a few ms) so the first
// frame never shows the numbers in a fallback face and then swaps. Never wait more than 150 ms.
const fontReady = Promise.race([
  document.fonts?.load('760 1em "Recursive Variable"') ?? Promise.resolve(),
  new Promise((done) => setTimeout(done, 150)),
]).catch(() => {});

// Tell Rust we have painted: it shows the (hidden until now) window.
void fontReady.then(() =>
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      backend.frontendReady().catch(() => {});
    }),
  ),
);
