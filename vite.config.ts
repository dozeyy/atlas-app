import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed dev port (crates/app/tauri.conf.json devUrl).
export default defineConfig(({ command }) => ({
  plugins: [react(), tailwindcss()],
  // The screenshot tour (src/lib/shotTour.ts) is compiled in only for the dev server and for a
  // build made with VITE_ATLAS_TOUR=1 (the Mac proof's tour app and browser preview). Any other
  // build folds the check to `false`, so the tour chunk is never emitted in a release.
  define: {
    __ATLAS_TOUR_BUILD__: JSON.stringify(command === "serve" || process.env.VITE_ATLAS_TOUR === "1"),
  },
  clearScreen: false,
  server: { port: 1420, strictPort: true, host: "127.0.0.1" },
  build: {
    target: "es2022",
    sourcemap: false,
    // A font is always its own file. Vite turns any asset under 4 kB into a `data:` URL, and the
    // app's content policy (tauri.conf.json) loads fonts from the app only, so the smallest
    // Recursive face (Cyrillic extended, 3 kB) was refused in the real window.
    assetsInlineLimit: (file) => (/\.woff2?$/i.test(file) ? false : undefined),
    // Two pages: the app, and the launch splash (its own tiny bundle, no React).
    rollupOptions: { input: { main: "index.html", splash: "splash.html" } },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
  },
}));
