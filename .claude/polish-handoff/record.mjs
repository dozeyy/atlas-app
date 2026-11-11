// Screen recording of the Atlas browser preview (mock backend): headless Chrome over CDP, frames
// from Page.startScreencast, encoded to H.264 mp4 by ffmpeg with the real per-frame timing.
// No dependencies (Node 24's built-in WebSocket + fetch). Sister of shoot.mjs.
//
//   node record.mjs --base http://127.0.0.1:<port> --out <file.mp4> --size 1180x780
//        --theme dark|light|silver [--side expanded|collapsed] [--query k=v] --script <file.mjs>
//        [--tail 0.6] [--quality 90] [--fps 60] [--crf 20] [--keep]
//
// The script file's default export is a JS source string, run in the page as an async function
// body with `t` (= window.__t: sleep, waitFor, press, clickText, home, go(n), type). What it
// returns is printed as a note. An optional named export `setup` (same form) runs before the
// recording starts, for getting to a starting point that should not be in the clip.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { dropProfile, pruneOld } from "./tmpclean.mjs";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const here = path.dirname(fileURLToPath(import.meta.url));
const base = String(arg("base", "http://127.0.0.1:5201")).replace(/\/$/, "");
const outArg = arg("out", null);
const scriptArg = arg("script", null);
const [w, h] = String(arg("size", "1180x780")).split("x").map(Number);
const theme = String(arg("theme", "dark"));
const side = String(arg("side", "auto"));
const query = arg("query", "");
const tail = Number(arg("tail", 0.6));
const quality = Number(arg("quality", 90));
const fps = Number(arg("fps", 60));
const crf = Number(arg("crf", 20));
const keep = !!arg("keep", false);
if (!outArg || outArg === true || !scriptArg || scriptArg === true || !w || !h) {
  console.error("usage: node record.mjs --base http://127.0.0.1:<port> --out <file.mp4> --size 1180x780 --theme dark|light|silver [--side expanded|collapsed] [--query k=v] --script <file.mjs>");
  process.exit(2);
}
const out = path.resolve(outArg);
const mod = await import(pathToFileURL(path.resolve(scriptArg)).href);
if (typeof mod.default !== "string") {
  console.error(`${scriptArg}: the default export must be a string of JS (an async function body using t)`);
  process.exit(2);
}

const FFMPEG_FALLBACK =
  "C:/Users/Will/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe";
const ffmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 ? "ffmpeg" : FFMPEG_FALLBACK;

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9400 + Math.floor(Math.random() * 400);
pruneOld("atlas-record-"); // leftovers of crashed runs: keep the newest 3
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-record-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--force-device-scale-factor=1",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--hide-scrollbars",
  `--window-size=${w},${h}`,
  "about:blank",
], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function json(url, init) {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(url, init);
      return await r.json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error(`no answer from ${url}`);
}

async function open() {
  await json(`http://127.0.0.1:${port}/json/version`);
  const t = await json(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  const handlers = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && waiting.has(d.id)) {
      const { res, rej } = waiting.get(d.id);
      waiting.delete(d.id);
      d.error ? rej(new Error(d.error.message)) : res(d.result);
    } else if (d.method === "Runtime.exceptionThrown") {
      errors.push(d.params.exceptionDetails?.exception?.description ?? d.params.exceptionDetails?.text);
    } else if (d.method === "Runtime.consoleAPICalled" && d.params.type === "error") {
      errors.push(d.params.args.map((a) => a.value ?? a.description ?? "").join(" ").slice(0, 300));
    } else if (d.method && handlers.has(d.method)) {
      handlers.get(d.method)(d.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const n = ++id;
      waiting.set(n, { res, rej });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, errors, on: (method, fn) => handlers.set(method, fn), close: () => ws.close() };
}

// Same helpers as shoot.mjs.
const HELPERS = `
window.__t = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  async waitFor(sel, ms = 5000) {
    const end = Date.now() + ms;
    for (;;) {
      const el = document.querySelector(sel);
      if (el) return el;
      if (Date.now() > end) return null;
      await this.sleep(80);
    }
  },
  press(key, mod = false) {
    const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ctrlKey: mod }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true, ctrlKey: mod }));
  },
  clickText(sel, text) {
    for (const el of document.querySelectorAll(sel)) {
      if ((el.textContent ?? "").trim().toLowerCase().includes(text.toLowerCase())) { el.click(); return true; }
    }
    return false;
  },
  async home() {
    for (let i = 0; i < 3; i++) { this.press("Escape"); await this.sleep(120); }
  },
  async go(n) { await this.home(); this.press(String(n), true); await this.sleep(250); },
  type(el, text) {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus(); set.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true }));
  },
};
`;

const frameDir = fs.mkdtempSync(path.join(here, "rec-frames-"));
const frames = []; // { file, ts } with ts in seconds (Chrome's wall clock)
let note = "";
let failed = 0;
let endTs = 0;
let pageErrors = [];
try {
  const page = await open();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  await page.send("Emulation.setEmulatedMedia", {
    features: [
      { name: "prefers-color-scheme", value: theme === "dark" ? "dark" : "light" },
      // Never "reduce": the point of a recording is the motion.
      { name: "prefers-reduced-motion", value: "no-preference" },
    ],
  });
  const boot = `
    try {
      localStorage.setItem("atlas.mock.settings", JSON.stringify({ theme: ${JSON.stringify(theme)} }));
      ${side === "auto" ? 'localStorage.removeItem("atlas.sidebar");' : `localStorage.setItem("atlas.sidebar", ${JSON.stringify(side)});`}
    } catch {}
    ${HELPERS}
  `;
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: boot });
  await page.send("Page.navigate", { url: `${base}/${query && query !== true ? `?${query}` : ""}` });
  await sleep(2500);
  const up = await page.evaluate(`window.__t.waitFor(".titlebar", 15000).then((el) => !!el)`);
  if (!up) throw new Error(`the app did not come up at ${base} (no .titlebar after 15 s)`);
  await sleep(800);
  const reducedNow = await page.evaluate(
    `matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.classList.contains("reduced")`,
  );
  if (reducedNow) console.warn("warning: the page reports reduced motion; animations will not play");
  if (typeof mod.setup === "string") {
    await page.evaluate(`(async () => { const t = window.__t; ${mod.setup} })()`);
    await sleep(300);
  }

  page.on("Page.screencastFrame", (p) => {
    // Ack first so Chrome keeps sending at full rate, then keep the frame with its own timestamp.
    page.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    const file = path.join(frameDir, `f${String(frames.length).padStart(6, "0")}.jpg`);
    frames.push({ file, ts: p.metadata?.timestamp ?? Date.now() / 1000 });
    fs.writeFileSync(file, Buffer.from(p.data, "base64"));
  });
  await page.send("Page.startScreencast", { format: "jpeg", quality, maxWidth: w, maxHeight: h, everyNthFrame: 1 });
  await sleep(250);
  try {
    note = (await page.evaluate(`(async () => { const t = window.__t; ${mod.default} })()`)) ?? "";
  } catch (e) {
    note = `script failed: ${String(e).slice(0, 300)}`;
    failed = 1;
  }
  await sleep(Math.max(0, tail) * 1000);
  endTs = Date.now() / 1000;
  await page.send("Page.stopScreencast");
  await sleep(150);
  pageErrors = [...new Set(page.errors)].slice(0, 10);
  page.close();
} catch (e) {
  console.error(String(e));
  failed = 1;
} finally {
  chrome.kill();
  await dropProfile(chrome, profile); // the run's own Chrome profile is never left in Temp
}

function cleanFrames() {
  if (keep) {
    console.log(`frames kept: ${frameDir}`);
    return;
  }
  // One file at a time, then the empty folder (recursive deletes are blocked on this PC).
  for (const name of fs.readdirSync(frameDir)) fs.unlinkSync(path.join(frameDir, name));
  fs.rmdirSync(frameDir);
}

if (frames.length === 0) {
  console.error("no frames: Page.startScreencast sent nothing, so no clip was written");
  cleanFrames();
  process.exit(1);
}

// Concat list with each frame's real duration: the screencast only sends a frame when the page
// changes, so a still second is one frame held for a second, not 60 of them.
frames.sort((a, b) => a.ts - b.ts);
const esc = (p) => p.replace(/\\/g, "/").replace(/'/g, "'\\''");
const lines = ["ffconcat version 1.0"];
let total = 0;
for (let i = 0; i < frames.length; i++) {
  const next = i + 1 < frames.length ? frames[i + 1].ts : Math.max(endTs, frames[i].ts + 0.04);
  const d = Math.max(0.001, next - frames[i].ts);
  total += d;
  // "option framerate 1000": a still image is read on a 1/25 s clock by default, which would snap
  // every frame time to 40 ms and pile a 60+ fps burst onto the same tick. 1 ms keeps the timing.
  lines.push(`file '${esc(frames[i].file)}'`, "option framerate 1000", `duration ${d.toFixed(6)}`);
}
// The concat demuxer drops the last duration unless the last file is named once more. ffmpeg then
// holds that repeat for a guessed length (the gap before it), so the encode is cut at the real
// total with -t below.
lines.push(`file '${esc(frames[frames.length - 1].file)}'`, "option framerate 1000");
const list = path.join(frameDir, "list.txt");
fs.writeFileSync(list, lines.join("\n") + "\n");

fs.mkdirSync(path.dirname(out), { recursive: true });
const enc = spawnSync(ffmpeg, [
  "-y", "-hide_banner", "-loglevel", "error",
  "-f", "concat", "-safe", "0", "-i", list,
  // JPEG frames are full range; players expect limited-range yuv420p, so convert, not just relabel.
  "-vf", `fps=${fps},pad=ceil(iw/2)*2:ceil(ih/2)*2,scale=in_range=pc:out_range=tv,format=yuv420p`,
  "-c:v", "libx264", "-preset", "slow", "-crf", String(crf), "-color_range", "tv",
  "-t", total.toFixed(3),
  "-movflags", "+faststart", "-an",
  out,
], { encoding: "utf8" });
if (enc.status !== 0) {
  console.error(`ffmpeg failed (${enc.status}): ${(enc.stderr || enc.error?.message || "").slice(0, 2000)}`);
  failed = 1;
}
cleanFrames();

if (note) console.log(`note: ${note}`);
for (const e of pageErrors) console.log(`page error: ${e}`);
if (enc.status === 0) {
  const kb = (fs.statSync(out).size / 1024).toFixed(0);
  console.log(`${out}\n  ${total.toFixed(2)} s, ${frames.length} frames captured, ${w}x${h} ${theme}, ${kb} KB`);
}
process.exit(failed);
