// Mockup shell: draws the Atlas window around the stage and shows one slide.
// URL: <direction>.html?s=<story index>&t=light|dark
(function () {
  const q = new URLSearchParams(location.search);
  const theme = q.get("t") === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  const total = window.TOTAL || 15;
  const slides = [...document.querySelectorAll(".slide")];
  const want = Number(q.get("s") || slides[0].dataset.s);
  const on = slides.find((el) => Number(el.dataset.s) === want) || slides[0];
  on.classList.add("on");
  const n = Number(on.dataset.s);
  document.documentElement.dataset.slide = on.dataset.id || "";

  const ic = {
    grid: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    now: '<circle cx="5" cy="9" r="3"/><circle cx="11" cy="9" r="3"/><path d="M5 6 7 3h2l2 3"/>',
    chat: '<path d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H7l-3 3v-3a2 2 0 0 1-2-2z"/>',
    tool: '<path d="M10 2a4 4 0 0 0-3.6 5.6L2 12l2 2 4.4-4.4A4 4 0 0 0 14 6l-2 2-2-2 2-2a4 4 0 0 0-2-2z"/>',
    hist: '<path d="M2 8a6 6 0 1 0 2-4.5M2 2v3h3M8 5v3l2 2"/>',
  };
  const svg = (p) => `<svg viewBox="0 0 16 16">${p}</svg>`;
  const side = document.createElement("aside");
  side.className = "side";
  side.innerHTML = `
    <div class="row">${svg('<path d="M2 4h12M2 8h12M2 12h12"/>')}${svg('<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M6 3v10"/>')}</div>
    <div class="gift"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="var(--accent)" stroke-width="1.6"><rect x="2" y="6" width="12" height="8" rx="1"/><path d="M1.5 6h13M8 6v8M8 6C6 2 3 3.5 5 6M8 6c2-4 5-2.5 3 0"/></svg></div>
    <nav>
      <a>${svg(ic.grid)}Dashboard</a><a>${svg(ic.now)}Now</a><a>${svg(ic.chat)}Sessions</a><a>${svg(ic.tool)}Toolkit</a><a>${svg(ic.hist)}History</a>
    </nav>
    <div class="foot"><div><small>Today</small><b>9.7M</b></div>
      <svg width="44" height="18" viewBox="0 0 44 18" fill="none" stroke="var(--accent)" stroke-width="1.5"><path d="M1 15 6 12l4 3 4-9 4 7 4-10 4 8 4-4 4 6 4-5 4 4"/></svg>
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--text-2)" stroke-width="1.5"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/></svg></div>`;
  document.body.prepend(side);
  const top = document.createElement("div");
  top.className = "top";
  top.innerHTML = `<div class="wc"><i><svg viewBox="0 0 10 10"><path d="M0 5h10"/></svg></i><i><svg viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9"/></svg></i><i><svg viewBox="0 0 10 10"><path d="M0 0l10 10M10 0 0 10"/></svg></i></div>`;
  document.body.prepend(top);

  if (!document.querySelector(".foot-nav")) {
    const foot = document.createElement("div");
    foot.className = "foot-nav";
    const last = n === total;
    foot.innerHTML =
      n === 1
        ? `<span></span><span class="count"></span><span class="btn primary">Start</span>`
        : `<span class="btn">Back</span><span class="count">${n} of ${total}</span><span class="btn ${last ? "" : "primary"}">${last ? "Replay" : "Next"}</span>`;
    document.body.append(foot);
  }
  if (window.drawProgress) window.drawProgress(n, total);
  if (window.afterShell) window.afterShell(on, theme);
})();
