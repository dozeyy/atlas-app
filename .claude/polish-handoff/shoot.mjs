// Headless Chrome screenshot + layout audit of the Atlas browser preview (mock backend).
// No dependencies: Chrome DevTools Protocol over Node's built-in WebSocket.
//
//   node shoot.mjs --base http://127.0.0.1:5201 --out <dir> --label before
//        [--sizes 900x600,1180x780] [--themes dark,light] [--side auto,collapsed,expanded]
//        [--stops dashboard,now] [--stress] [--reduced] [--query update=0.2.0] [--noshot]
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { dropProfile, pruneOld } from "./tmpclean.mjs";
import { STOPS, STRESS } from "./stops.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const base = arg("base", "http://127.0.0.1:5201");
const out = path.resolve(arg("out", "shots"));
const label = arg("label", "before");
const sizes = String(arg("sizes", "900x600,1180x780")).split(",").map((s) => s.split("x").map(Number));
const themes = String(arg("themes", "dark,light")).split(",");
const sides = String(arg("side", "auto")).split(",");
const only = arg("stops", null) ? String(arg("stops")).split(",") : null;
const stress = !!arg("stress", false);
const reduced = !!arg("reduced", false);
const query = arg("query", "");
const noshot = !!arg("noshot", false);

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const port = 9400 + Math.floor(Math.random() * 400);
pruneOld("atlas-shoot-"); // leftovers of crashed runs: keep the newest 3
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-shoot-"));
const chrome = spawn(CHROME, [
  "--headless=new",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "--force-device-scale-factor=1",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions",
  "--window-size=1280,900",
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
  return { send, evaluate, errors, close: () => ws.close() };
}

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

const AUDIT = `
(() => {
  const out = [];
  const vw = innerWidth, vh = innerHeight;
  const rectOf = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return null;
    for (let p = el; p; p = p.parentElement) if (+getComputedStyle(p).opacity === 0) return null;
    return r;
  };
  const desc = (el) => {
    const cls = typeof el.className === "string" ? el.className.split(/\\s+/).slice(0, 3).join(".") : "";
    const txt = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 44);
    return el.tagName.toLowerCase() + (cls ? "." + cls : "") + (txt ? ' "' + txt + '"' : "");
  };
  const hasTip = (el) => {
    for (let p = el, i = 0; p && i < 4; p = p.parentElement, i++) if (p.getAttribute("title") || p.getAttribute("data-tip")) return true;
    return false;
  };
  const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
  const inSidewaysScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };
  if (document.documentElement.scrollWidth > vw + 1) out.push("PAGE-HSCROLL +" + (document.documentElement.scrollWidth - vw));
  for (const el of document.querySelectorAll("body *")) {
    if (el.closest(".sr-only")) continue;
    const r = rectOf(el);
    if (!r) continue;
    const cs = getComputedStyle(el);
    if ((cs.overflowX === "auto" || cs.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 1 && !el.closest(".cm-editor, pre, code"))
      out.push("HSCROLL +" + (el.scrollWidth - el.clientWidth) + " " + desc(el));
    if (ownText(el)) {
      const ell = cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1;
      const clamp = cs.webkitLineClamp !== "none" && cs.webkitLineClamp !== "" && el.scrollHeight > el.clientHeight + 1;
      if ((ell || clamp) && !hasTip(el)) out.push("CUT-NO-TIP " + desc(el));
      if (!ell && !clamp && (cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1)
        out.push("CLIPPED-X +" + (el.scrollWidth - el.clientWidth) + " " + desc(el));
      if ((r.right > vw + 1 || r.left < -1) && !inSidewaysScroller(el) && r.top < vh && r.bottom > 0) out.push("OFF-SCREEN " + desc(el));
    }
  }
  const inter = [...document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="radio"], [role="tab"], [role="switch"], [role="menuitem"]')]
    .map((el) => [el, rectOf(el)]).filter(([, r]) => r && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw);
  for (const [el, r] of inter) {
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    if (cy !== r.top + r.height / 2) continue;
    const top = document.elementFromPoint(cx, cy);
    if (top && top !== el && !el.contains(top) && !top.contains(el)) {
      const cst = getComputedStyle(el);
      if (cst.pointerEvents !== "none") out.push("COVERED " + desc(el) + " <- " + desc(top));
    }
  }
  for (let i = 0; i < inter.length; i++) for (let j = i + 1; j < inter.length; j++) {
    const [a, ra] = inter[i], [b, rb] = inter[j];
    if (a.contains(b) || b.contains(a)) continue;
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w > 3 && h > 3) out.push("OVERLAP " + Math.round(w) + "x" + Math.round(h) + " " + desc(a) + " <> " + desc(b));
  }
  const main = document.querySelector("main");
  if (main) out.push("INFO page-scroll " + Math.max(0, main.scrollHeight - main.clientHeight));
  return out;
})()
`;

const report = {};
let failed = 0;
try {
  for (const side of sides) {
    for (const theme of themes) {
      for (const [w, h] of sizes) {
        const page = await open();
        await page.send("Page.enable");
        await page.send("Runtime.enable");
        await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await page.send("Emulation.setEmulatedMedia", {
          features: [
            { name: "prefers-color-scheme", value: theme === "dark" ? "dark" : "light" },
            { name: "prefers-reduced-motion", value: reduced ? "reduce" : "no-preference" },
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
        await page.send("Page.navigate", { url: `${base}/${query ? `?${query}` : ""}` });
        await sleep(2500);
        await page.evaluate(`window.__t.waitFor(".titlebar", 15000).then(() => true)`);
        await sleep(800);
        if (stress) {
          await page.evaluate(STRESS);
          await sleep(300);
        }
        for (const stop of STOPS) {
          if (only && !only.includes(stop.name)) continue;
          let note = "";
          try {
            note = (await page.evaluate(`(async () => { const t = window.__t; ${stop.js} })()`)) ?? "";
          } catch (e) {
            note = `failed: ${String(e).slice(0, 200)}`;
          }
          await sleep(stop.settle ?? 1200);
          const tag = `${theme}-${w}x${h}${side === "auto" ? "" : `-${side}`}${stress ? "-stress" : ""}${reduced ? "-reduced" : ""}`;
          const issues = await page.evaluate(AUDIT);
          if (note) issues.unshift(`NOTE ${note}`);
          report[`${stop.name} ${tag}`] = issues;
          if (!noshot) {
            const dir = path.join(out, stop.name);
            fs.mkdirSync(dir, { recursive: true });
            const shot = await page.send("Page.captureScreenshot", { format: "png" });
            fs.writeFileSync(path.join(dir, `${label}-${tag}.png`), Buffer.from(shot.data, "base64"));
            if (stop.scroll) {
              await page.evaluate(`document.querySelector("main")?.scrollTo(0, 1e6)`);
              await sleep(400);
              const s2 = await page.send("Page.captureScreenshot", { format: "png" });
              fs.writeFileSync(path.join(dir, `${label}-${tag}-bottom.png`), Buffer.from(s2.data, "base64"));
              await page.evaluate(`document.querySelector("main")?.scrollTo(0, 0)`);
            }
          }
        }
        if (page.errors.length) report[`ERRORS ${theme}-${w}x${h}-${side}`] = [...new Set(page.errors)].slice(0, 10);
        page.close();
      }
    }
  }
} catch (e) {
  console.error(String(e));
  failed = 1;
} finally {
  chrome.kill();
  await dropProfile(chrome, profile); // the run's own Chrome profile is never left in Temp
}

fs.mkdirSync(out, { recursive: true });
const name = `audit-${label}${stress ? "-stress" : ""}${reduced ? "-reduced" : ""}.json`;
fs.writeFileSync(path.join(out, name), JSON.stringify(report, null, 1));
// Compact print: each distinct issue once, with the stops/sizes it shows on.
const by = new Map();
for (const [k, list] of Object.entries(report)) {
  for (const i of list) {
    if (i.startsWith("INFO page-scroll 0")) continue;
    if (!by.has(i)) by.set(i, []);
    by.get(i).push(k);
  }
}
for (const [i, ks] of by) console.log(`${i}\n    @ ${ks.slice(0, 6).join(" | ")}${ks.length > 6 ? ` (+${ks.length - 6})` : ""}`);
process.exit(failed);
