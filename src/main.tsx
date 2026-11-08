import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./App";
import { AtlasProvider } from "./state/AtlasProvider";
import { getBackend } from "./lib/ipc";
import { applyBoot } from "./lib/theme";

const backend = getBackend();

// Theme, platform and backdrop classes go on <html> before the first paint so
// the window never flashes the wrong colors.
applyBoot(backend.boot());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AtlasProvider>
      <App />
    </AtlasProvider>
  </StrictMode>,
);

// Tell Rust we have painted: it shows the (hidden until now) window.
requestAnimationFrame(() =>
  requestAnimationFrame(() => {
    backend.frontendReady().catch(() => {});
  }),
);
