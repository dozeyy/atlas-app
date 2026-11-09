// WebKit screenshots of every page, the engine macOS draws Atlas with (WKWebView).
//
//   npm install --no-save playwright@1.64.1 && npx playwright install webkit
//   VITE_ATLAS_TOUR=1 npx vite build --outDir dist-tour     (the tour is only in a tour build)
//   ATLAS_DIST=dist-tour node tools/webkit-shots.mjs [OUT_DIR]   (default: shots-webkit)
//
// Serves the built frontend (ATLAS_DIST, default dist/) itself, opens it with the mock backend as macOS (`?platform=macos&tour`), and lets
// src/lib/shotTour.ts walk every page at 1280x800 and 900x600, light and dark. Fails (exit 1) on any
// console error, page error or failed request, or when a tour does not finish. Runs the same on
// Windows and macOS; the macOS proof run (.github/workflows/mac-check.yml) uses it.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { webkit } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.resolve(root, process.env.ATLAS_DIST || "dist");
const out = path.resolve(process.argv[2] ?? path.join(root, "shots-webkit"));
fs.mkdirSync(out, { recursive: true });
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error(`${dist}/index.html is missing: run \`VITE_ATLAS_TOUR=1 npx vite build --outDir dist-tour\` first.`);
  process.exit(2);
}
// A frontend built without the tour would wait out every timeout: say so at once instead.
const assets = path.join(dist, "assets");
if (!fs.existsSync(assets) || !fs.readdirSync(assets).some((f) => f.startsWith("shotTour"))) {
  console.error(`${dist} has no screenshot tour in it: build it with VITE_ATLAS_TOUR=1.`);
  process.exit(2);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".json": "application/json" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let file = path.normalize(path.join(dist, decodeURIComponent(url.pathname)));
  if (!file.startsWith(dist)) return res.writeHead(403).end();
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const log = [];
const problems = [];
const say = (line) => {
  log.push(line);
  console.log(line);
};

const browser = await webkit.launch();
say(`webkit ${browser.version()}`);
for (const [w, h] of [
  [1280, 800],
  [900, 600],
]) {
  for (const scheme of ["light", "dark"]) {
    const prefix = `webkit-${scheme}-${w}x${h}`;
    const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(`${prefix} console: ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`${prefix} page error: ${e.message}`));
    page.on("requestfailed", (r) => problems.push(`${prefix} request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
    let finish;
    const done = new Promise((r) => (finish = r));
    await page.exposeFunction("__atlasCapture", async (name) => {
      await page.screenshot({ path: path.join(out, `${name}.png`) });
    });
    await page.exposeFunction("__atlasLog", (line) => say(line));
    await page.exposeFunction("__atlasTourDone", () => finish());
    await page.goto(`${base}?platform=macos&tour=1&prefix=${prefix}`);
    const timedOut = await Promise.race([done.then(() => false), new Promise((r) => setTimeout(() => r(true), 240_000))]);
    if (timedOut) problems.push(`${prefix}: the tour did not finish in 240 s`);
    await context.close();
  }
}
await browser.close();
server.close();

fs.writeFileSync(path.join(out, "webkit-tour.log"), log.join("\n") + "\n");
fs.writeFileSync(path.join(out, "webkit-problems.log"), problems.join("\n") + (problems.length ? "\n" : ""));
if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n` + problems.join("\n"));
  process.exit(1);
}
console.log(`\nNo console errors. Shots in ${out}`);
