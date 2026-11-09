// Sample data for the mockups. The headline numbers are Will's own Wrapped walk
// (docs/shots/wrapped-fun/round3): 873M tokens, 374 sessions, 74 active days of 124, best run 15,
// current run 3, busiest day Mon Oct 19, biggest chat 110M (47x a usual chat), prime time 5 PM over
// 120 days, go-to helper general-purpose (474 calls, 25 sessions). The per-day and per-hour SHAPES
// below are illustrative (seeded), not read from the cache; the built slides draw dayTokens / hours.
window.SAMPLE = (function () {
  let seed = 7;
  const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const start = new Date(2026, 6, 9); // Jul 9 2026, a Thursday
  const N = 124;
  const days = [];
  for (let i = 0; i < N; i++) { const d = new Date(start); d.setDate(start.getDate() + i); days.push({ date: d, active: false, tokens: 0 }); }
  const idx = (m, dd) => days.findIndex((x) => x.date.getMonth() === m && x.date.getDate() === dd);
  const fixedOff = new Set([idx(6, 19), idx(7, 4), idx(10, 6)]);
  const run = []; for (let i = idx(6, 20); i <= idx(7, 3); i++) run.push(i);
  const now = [idx(10, 7), idx(10, 8), idx(10, 9)];
  [...run, ...now].forEach((i) => (days[i].active = true));
  const busy = idx(9, 19);
  days[busy].active = true;
  const pool = days.map((_, i) => i).filter((i) => !days[i].active && !fixedOff.has(i));
  while (days.filter((d) => d.active).length < 74) { const k = Math.floor(rnd() * pool.length); days[pool.splice(k, 1)[0]].active = true; }
  // no accidental run of 15+ outside the fixed one
  days.forEach((d) => { if (d.active) d.tokens = Math.round(2 + Math.pow(rnd(), 2.2) * 30) * 1e6; });
  days[busy].tokens = 144e6;
  const hours = [0.6, 0.3, 0.2, 0.1, 0.1, 0.1, 0.3, 0.9, 1.6, 2.4, 2.9, 3.1, 2.6, 2.9, 3.4, 3.9, 4.4, 5.6, 4.6, 3.6, 3.1, 2.6, 1.9, 1.1];
  return { days, busy, run, now, hours };
})();
