// Edge-click audit for the real app. Usage (app started with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=PORT):
//   node tools/edge-click-audit.mjs PORT [label]
// Optional env: EDGE_VIEW=900x600 (default 1280x800); EDGE_SCOPE=shell audits the sidebar and title bar instead of <main>; EDGE_SCOPE=menu audits the open app menu.
// For every pressable on the current page (or the open dialog) it presses the mouse 2 px inside each edge, waits for the
// press transition, releases in place and reports any press where no click reached the element. Clicks are swallowed at
// the document, so nothing actually runs. Exit code 1 when any press is missed. vitest cannot do this: jsdom has no layout.
import fs from "node:fs";

async function connect(port, tries = 120) {
  let list = [];
  for (let i = 0; i < tries; i++) {
    try {
      list = await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json();
      if (list.some((t) => t.type === "page")) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("no page on port " + port);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d);
      pending.delete(d.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const i = ++id;
      pending.set(i, (d) => (d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result)));
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
    return r.result.value;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (path) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path, Buffer.from(r.data, "base64"));
  };
  const view = (w, h, dpr = 1) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dpr, mobile: false });
  const click = async (x, y) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
      await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
  };
  const clickSel = async (sel, nth = 0) => {
    const p = await ev(
      `(()=>{const e=document.querySelectorAll(${JSON.stringify(sel)})[${nth}]; if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()`,
    );
    if (!p) throw new Error("no " + sel);
    await sleep(80);
    await click(p[0], p[1]);
  };
  const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38 };
  const key = async (k) => {
    for (const type of ["rawKeyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: k, code: k, windowsVirtualKeyCode: codes[k] ?? 0 });
  };
  const text = (t) => send("Input.insertText", { text: t });
  return { send, ev, sleep, shot, view, click, clickSel, key, text, close: () => ws.close() };
}

// Edge-click audit. For every visible pressable in <main> (or the open dialog), press the mouse 2 px inside each
// edge, wait for the press transition to finish, release in place, and record whether a click reached the element.
// Clicks are swallowed at the document (capture) so nothing actually runs: delete never opens, tiles never navigate.

const port = Number(process.argv[2]);
const label = process.argv[3] ?? "page";
const c = await connect(port);
const [vw, vh] = (process.env.EDGE_VIEW ?? "1280x800").split("x").map(Number);
await c.view(vw, vh);
await c.sleep(600);

await c.ev(`(()=>{
  window.__clicks = [];
  if (window.__edgeInstalled) return;
  window.__edgeInstalled = true;
  window.__edgeFn = (e) => { window.__clicks.push(e.target); e.stopPropagation(); e.preventDefault(); };
  document.addEventListener('click', window.__edgeFn, true);
})()`);

const count = await c.ev(`(()=>{
  const scope = ${JSON.stringify(process.env.EDGE_SCOPE ?? "")};
  const shell = scope === "shell";
  const sel = 'button, [role=button], [role=switch], [role=tab], a[href]';
  const found = scope === "menu"
    ? [...document.querySelectorAll('[role=menu] [role=menuitem]')]
    : shell
    ? [...document.querySelectorAll('aside, header.titlebar')].flatMap(r => [...r.querySelectorAll(sel)])
    : [...(document.querySelector('[role=alertdialog],[role=dialog]') || document.querySelector('main')).querySelectorAll(sel)];
  const els = found.filter(e => {
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && !e.disabled;
  });
  window.__els = els;
  return els.length;
})()`);

const failures = [];
let checked = 0;
for (let i = 0; i < count; i++) {
  const info = await c.ev(`(()=>{
    const e = window.__els[i];
    e.scrollIntoView({block:'center'});
    const r = e.getBoundingClientRect();
    return { name: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 40), cls: (e.className||'').toString().includes('press'), x:r.x, y:r.y, w:r.width, h:r.height };
  })()`.replace("[i]", `[${i}]`));
  await c.sleep(60);
  const r = await c.ev(`(()=>{const e = window.__els[${i}]; const b = e.getBoundingClientRect(); return {x:b.x,y:b.y,w:b.width,h:b.height};})()`);
  const pts = {
    left: [r.x + 2, r.y + r.h / 2],
    right: [r.x + r.w - 2, r.y + r.h / 2],
    top: [r.x + r.w / 2, r.y + 2],
    bottom: [r.x + r.w / 2, r.y + r.h - 2],
  };
  for (const [edge, [x, y]] of Object.entries(pts)) {
    // is this point actually this element (or inside it)? skip when something else legitimately sits on top (the X on a card)
    const owner = await c.ev(`(()=>{const e = window.__els[${i}]; const t = document.elementFromPoint(${x}, ${y}); return !!t && (t === e || e.contains(t));})()`);
    if (!owner) continue;
    await c.ev(`window.__clicks.length = 0`);
    await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await c.sleep(320);
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await c.sleep(40);
    const hit = await c.ev(`(()=>{const e = window.__els[${i}]; return window.__clicks.some(t => t === e || e.contains(t));})()`);
    checked++;
    if (!hit) failures.push(`${info.name || "(unnamed)"} [${Math.round(r.w)}x${Math.round(r.h)}${info.cls ? ", press" : ""}] edge=${edge}`);
  }

  // Drift pass, on the list primitives only (.row-btn, .card-hit): press 1 px inside an edge, let the pointer slip
  // `slip` px past it while still down, release. A click fires on the nearest common ancestor of the down and up
  // targets, so without hit slop the click never reaches the button (the root cause of the "dead edge" reports).
  // Rows drift sideways only (above/below is the neighbouring row, which legitimately takes the release).
  const kind = await c.ev(`(()=>{const e = window.__els[${i}]; return e.classList.contains('row-btn') ? 'row' : e.classList.contains('card-hit') ? 'card' : ''})()`);
  if (kind) {
    const slip = 2;
    const drifts =
      kind === "row"
        ? { left: [r.x + 1, r.y + r.h / 2, r.x - slip, r.y + r.h / 2], right: [r.x + r.w - 1, r.y + r.h / 2, r.x + r.w + slip, r.y + r.h / 2] }
        : {
            left: [r.x + 1, r.y + r.h / 2, r.x - slip, r.y + r.h / 2],
            right: [r.x + r.w - 1, r.y + r.h / 2, r.x + r.w + slip, r.y + r.h / 2],
            top: [r.x + r.w / 2, r.y + 1, r.x + r.w / 2, r.y - slip],
            bottom: [r.x + r.w / 2, r.y + r.h - 1, r.x + r.w / 2, r.y + r.h + slip],
          };
    for (const [edge, [x, y, ux, uy]] of Object.entries(drifts)) {
      const owner = await c.ev(`(()=>{const e = window.__els[${i}]; const t = document.elementFromPoint(${x}, ${y}); return !!t && (t === e || e.contains(t));})()`);
      if (!owner) continue;
      await c.ev(`window.__clicks.length = 0`);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
      await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await c.sleep(320);
      await c.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: ux, y: uy, button: "left", buttons: 1 });
      await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ux, y: uy, button: "left", buttons: 0, clickCount: 1 });
      await c.sleep(40);
      const hit = await c.ev(`(()=>{const e = window.__els[${i}]; return window.__clicks.some(t => t === e || e.contains(t));})()`);
      checked++;
      if (!hit) failures.push(`${info.name || "(unnamed)"} [${Math.round(r.w)}x${Math.round(r.h)}] drift ${slip}px past ${edge}`);
    }
  }
}
console.log(`${label}: ${count} pressables, ${checked} edge presses, ${failures.length} missed`);
for (const f of failures) console.log("  MISS " + f);
await c.ev(`(()=>{document.removeEventListener('click', window.__edgeFn, true); window.__edgeInstalled = false;})()`);
c.close();
process.exit(failures.length ? 1 : 0);
