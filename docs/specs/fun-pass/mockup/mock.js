/* Atlas fun-pass mockup helpers. Static data, hand SVG, no libraries.
   URL params: ?theme=dark  ?still=1 (skip first-paint motion)  ?pin=a,b (force hover on [data-pin] ids) */
(function () {
  const q = new URLSearchParams(location.search);
  const root = document.documentElement;
  root.dataset.theme = q.get("theme") === "dark" ? "dark" : "light";
  if (!q.get("still")) root.classList.add("intro");
  window.PINS = (q.get("pin") || "").split(",").filter(Boolean);
})();

const NS = "http://www.w3.org/2000/svg";

function icon(name, cls = "") {
  const d = window.ICONS[name];
  if (!d) return "";
  const s = (w, c) => `<svg class="${c}" viewBox="0 0 256 256" aria-hidden="true">${d[w]}</svg>`;
  return `<span class="ico ${cls}">${s("regular", "w-reg")}${s("duotone", "w-duo")}${s("fill", "w-fill")}</span>`;
}

function fmt(n) { return n.toLocaleString("en-US"); }
function short(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(2).replace(/0$/, "") + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(n);
}

function sidebar(active) {
  const items = [
    ["dashboard", "Dashboard", "SquaresFour", "pop"],
    ["sessions", "Sessions", "ChatsCircle", "bob"],
    ["setup", "Setup", "Wrench", "wiggle"],
    ["history", "History", "ClockCounterClockwise", "spin"],
    ["wrapped", "Wrapped", "Sparkle", "wiggle"],
    ["settings", "Settings", "GearSix", "spin"],
  ];
  const idx = items.findIndex((i) => i[0] === active);
  return `<aside class="sidebar">
    <nav class="nav" aria-label="Main">
      <div class="nav-pill" style="transform:translateY(${idx * 38}px)"></div>
      ${items.map(([id, label, ic, m]) => `<a class="nav-item ${id === active ? "on" : ""}" data-m="${m}" data-pin="nav-${id}">${icon(ic)}${label}</a>`).join("")}
    </nav>
    <div class="side-foot">
      <div class="side-streak"><span class="spark" style="width:14px;height:14px"></span><span style="font-size:12px;font-weight:600">9-day streak</span></div>
      <span class="caption">Version 0.1.0</span>
    </div>
  </aside>`;
}

/* Count-up: from 0 on first paint, easeOutExpo, 700 ms. Tabular figures, so no jitter. */
function countUp(el) {
  const to = Number(el.dataset.to), dec = Number(el.dataset.dec || 0), pre = el.dataset.pre || "";
  const render = (v) => (el.textContent = pre + (dec ? v.toFixed(dec) : fmt(Math.round(v))));
  if (!root().classList.contains("intro")) return render(to);
  const t0 = performance.now(), dur = 700;
  const ease = (t) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t));
  (function tick(now) {
    const t = Math.min(1, (now - t0) / dur);
    render(to * ease(t));
    if (t < 1) requestAnimationFrame(tick);
  })(t0);
}
function root() { return document.documentElement; }

/* Monotone cubic path through points (no overshoot below the baseline). */
function smooth(pts) {
  const n = pts.length, dx = [], m = [], t = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${pts[i][0] + h},${pts[i][1] + t[i] * h} ${pts[i + 1][0] - h},${pts[i + 1][1] - t[i + 1] * h} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

/* Ridge sparkline with the summit spark on the peak. */
function ridge(el, values, labels, w, h) {
  const pad = 10, top = 34, bot = 22, max = Math.max(...values);
  const x = (i) => pad + (i * (w - pad * 2)) / (values.length - 1);
  const y = (v) => top + (1 - v / max) * (h - top - bot);
  const pts = values.map((v, i) => [x(i), y(v)]);
  const d = smooth(pts);
  const pk = values.indexOf(max);
  const gid = "rg" + Math.random().toString(36).slice(2, 7);
  el.innerHTML = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="var(--accent)" stop-opacity=".30"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    <path class="ridge-area" d="${d}L${x(values.length - 1)},${h - bot}L${x(0)},${h - bot}Z" fill="url(#${gid})"/>
    <path class="ridge-stroke" d="${d}"/>
    ${values.map((v, i) => `<text class="ridge-day ${i === pk ? "peak" : ""}" x="${x(i)}" y="${h - 4}">${labels[i]}</text>`).join("")}
    <g class="summit" style="transform-box:fill-box;transform-origin:50% 100%">
      <line class="pole" x1="${x(pk)}" x2="${x(pk)}" y1="${y(max) - 6}" y2="${y(max) - 22}"/>
      <foreignObject x="${x(pk) - 11}" y="${y(max) - 40}" width="22" height="22"><span class="spark" style="width:22px;height:22px"></span></foreignObject>
      <circle class="ridge-dot" cx="${x(pk)}" cy="${y(max)}" r="4.5"/>
    </g>
    <circle class="ridge-dot" cx="${x(values.length - 1)}" cy="${y(values[values.length - 1])}" r="3.5"/>
  </svg>`;
  const p = el.querySelector(".ridge-stroke");
  p.style.setProperty("--len", Math.ceil(p.getTotalLength()));
}

/* Rounded-top bars with hover lift + tooltip. */
function bars(el, data, w, h, opts = {}) {
  const left = 4, right = 40, top = 30, bot = 22, n = data.length, max = Math.max(...data.map((d) => d.v));
  const nice = Math.ceil(max / 100000) * 100000;
  const step = (w - left - right) / n, bw = Math.max(4, step * 0.62), r = Math.min(6, bw / 2);
  const y = (v) => top + (1 - v / nice) * (h - top - bot);
  const base = h - bot;
  const path = (x, yt) => {
    const hh = base - yt;
    if (hh < r) return `M${x},${base}h${bw}v${-Math.max(hh, 2)}h${-bw}Z`;
    return `M${x},${base}V${yt + r}Q${x},${yt} ${x + r},${yt}H${x + bw - r}Q${x + bw},${yt} ${x + bw},${yt + r}V${base}Z`;
  };
  const pk = data.reduce((a, d, i) => (d.v > data[a].v ? i : a), 0);
  let g = "";
  data.forEach((d, i) => {
    const x = left + i * step + (step - bw) / 2;
    const zero = d.v === 0;
    const yt = zero ? base - 3 : y(d.v);
    const hh = Math.max(base - yt, 2);
    g += `<g class="bar-g" data-i="${i}" data-pin="bar-${i}">
      <path class="bar ${zero ? "zero" : ""} ${i === n - 1 ? "today" : ""}" style="--i:${i};--hs:${((hh + 4) / hh).toFixed(4)}" d="${path(x, yt)}"/>
      <rect class="bar-hit" x="${left + i * step}" y="${top - 10}" width="${step}" height="${base - top + 10}"/>
    </g>`;
  });
  const px = left + pk * step + step / 2;
  const grid = [0.5, 1].map((f) => `<line class="grid-line" x1="${left}" x2="${w - right + 6}" y1="${y(nice * f)}" y2="${y(nice * f)}"/>
     <text class="axis-label" x="${w}" y="${y(nice * f) + 4}" text-anchor="end">${short(nice * f)}</text>`).join("");
  const ticks = (opts.ticks || []).map(([i, t]) => `<text class="axis-label" x="${left + i * step + step / 2}" y="${h - 4}" text-anchor="middle">${t}</text>`).join("");
  el.innerHTML = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${grid}<line class="base-line" x1="${left}" x2="${w - right + 6}" y1="${base + 0.5}" y2="${base + 0.5}"/>
    ${g}${ticks}
    <g class="summit"><foreignObject x="${px - 9}" y="${y(data[pk].v) - 30}" width="18" height="18"><span class="spark"></span></foreignObject></g>
  </svg><div class="tip"><div class="t1"></div><div class="t2"></div><div class="t3"></div></div>`;
  el.style.position = "relative";
  const tip = el.querySelector(".tip");
  const show = (gEl) => {
    const i = +gEl.dataset.i, d = data[i];
    tip.querySelector(".t1").textContent = d.label + (i === pk ? "  ·  busiest day" : "");
    tip.querySelector(".t2").textContent = fmt(d.v) + " tokens";
    tip.querySelector(".t3").textContent = d.v ? `$${d.cost.toFixed(2)} est.  ·  ${d.s} session${d.s === 1 ? "" : "s"}` : "A day off";
    const x = left + i * step + step / 2, yt = d.v ? y(d.v) : base - 3;
    tip.style.left = x + "px";
    tip.style.top = yt - 6 + "px";
    tip.classList.add("show");
  };
  el.querySelectorAll(".bar-g").forEach((gEl) => {
    gEl.addEventListener("mouseenter", () => show(gEl));
    gEl.addEventListener("mouseleave", () => tip.classList.remove("show"));
  });
  return { show: (i) => { const gEl = el.querySelector(`.bar-g[data-i="${i}"]`); gEl.classList.add("hover"); show(gEl); } };
}

/* Ring meter: track + round-cap arc from 12 o'clock. */
function ring(el, frac, size, stroke, inner) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r, off = c * (1 - Math.min(frac, 1));
  el.innerHTML = `<div style="position:relative;width:${size}px;height:${size}px">
    <svg class="chart" width="${size}" height="${size}" style="rotate:-90deg">
      <circle class="ring-track" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
      <circle class="ring-arc" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
        stroke-dasharray="${c}" stroke-dashoffset="${off}" style="--circ:${c}"/>
    </svg>
    <div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center">${inner}</div></div>`;
}

/* Heat grid: rolling weeks ending today. Each column is 7 consecutive days, oldest top-left,
   today always the bottom-right cell with a "Today" label beside it. Streak days get a clay
   ring around the cell; no connecting line. Streak length is counted from the data. */
function heat(el, days, cell = 13, gap = 4) {
  const n = days.length, pad = (7 - (n % 7)) % 7, weeks = (n + pad) / 7, step = cell + gap;
  const labelW = 34, w = weeks * step - gap + 6 + labelW, h = 7 * step - gap;
  const vals = days.filter((d) => d.v > 0).map((d) => d.v).sort((a, b) => a - b);
  const q = (p) => vals[Math.floor(p * (vals.length - 1))];
  const cuts = [q(0.2), q(0.45), q(0.7), q(0.9)];
  const band = (v) => (v === 0 ? 0 : 1 + cuts.filter((c) => v > c).length);
  const pos = (i) => [Math.floor((i + pad) / 7) * step, ((i + pad) % 7) * step];
  let streak = 0;
  for (let i = n - 1; i >= 0 && days[i].v > 0; i--) streak++;
  let cells = "", rings = "";
  days.forEach((d, i) => {
    const [x, y] = pos(i), today = i === n - 1;
    cells += `<rect class="cell" data-pin="cell-${i}" style="--c:${Math.floor((i + pad) / 7)}" x="${x}" y="${y}" width="${cell}" height="${cell}" rx="3.5" fill="var(--heat-${band(d.v)})"><title>${today ? "Today, " : ""}${d.label}: ${fmt(d.v)} tokens</title></rect>`;
    if (i >= n - streak) rings += `<rect class="streak-ring ${today ? "today" : ""}" x="${x - 1}" y="${y - 1}" width="${cell + 2}" height="${cell + 2}" rx="4.5"/>`;
  });
  const [lx, ly] = pos(n - 1);
  el.innerHTML = `<svg class="chart" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    ${cells}${rings}<text class="today-label" x="${lx + cell + 6}" y="${ly + cell / 2 + 4}">Today</text>
  </svg>`;
  return { band, streak };
}

function pinHovers() {
  for (const id of window.PINS) {
    const el = document.querySelector(`[data-pin="${id}"]`);
    if (el) el.classList.add("hover");
  }
}

function startCounts() { document.querySelectorAll("[data-to]").forEach(countUp); }
