import { defineConfig } from "vite";

// Atlas Setup's own page (setup.html), built apart from the app so the installer carries
// only what it shows: no React, no Tailwind. Output goes to dist-setup/, which
// crates/setup embeds. Dev port 1421 matches crates/setup/tauri.conf.json devUrl.
export default defineConfig({
  clearScreen: false,
  server: { port: 1421, strictPort: true, host: "127.0.0.1" },
  build: {
    target: "es2022",
    sourcemap: false,
    outDir: "dist-setup",
    emptyOutDir: true,
    rollupOptions: { input: { setup: "setup.html" } },
  },
});
