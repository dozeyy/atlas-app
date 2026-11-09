import { useId } from "react";
import type { CSSProperties, ReactNode } from "react";
import { compact, formatDuration } from "../../lib/usage";
import { hourLabel, peakHour, shortDay, WEEKDAYS, WEEKDAYS_SHORT } from "../../lib/wrappedModel";
import type { Row, SlideChart } from "../../lib/wrappedModel";

// The hero graphics: one hand-written SVG (or a little CSS-drawn HTML where there is text to set)
// per kind of slide. They take the model's real numbers and nothing else. Every piece that moves
// carries `data-a` (reduced motion turns each into a fade) and its order in `--i`; the timing
// itself lives in screens.css, driven by --t0 (curtain lead) and --fd (when the figure lands).

type Of<K extends SlideChart["kind"]> = Extract<SlideChart, { kind: K }>;

const vars = (o: Record<string, string | number>) => o as CSSProperties;
const FILL = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--slate)"];

/** The four-point spark, the mark for a peak. */
export function Spark({ size = 22, className }: { size?: number; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 10 10" width={size} height={size} aria-hidden="true">
      <path d="M5 0 6.1 3.9 10 5 6.1 6.1 5 10 3.9 6.1 0 5 3.9 3.9Z" fill="var(--accent)" />
    </svg>
  );
}

/** A smooth line through points with level tangents at each one: it never leaves the range of its points. */
export function wavePath(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const mx = (x0 + x1) / 2;
    d += `C${mx.toFixed(1)} ${y0.toFixed(1)} ${mx.toFixed(1)} ${y1.toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return d;
}

/** The values averaged over a window of `r` days each side. */
export function smooth(values: number[], r: number): number[] {
  return values.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let k = Math.max(0, i - r); k <= Math.min(values.length - 1, i + r); k++) {
      s += values[k];
      n++;
    }
    return n > 0 ? s / n : 0;
  });
}

const ptsOf = (values: number[], W: number, H: number, top: number, max: number): [number, number][] =>
  values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * W : W / 2, H - (Math.max(0, v) / max) * (H - top)]);

// ---- tokens: the ridge ---------------------------------------------------------------------

/** The whole history as a ridge, with two fainter ridges behind it, and the spark on the peak day. */
export function Ridge({ values }: { values: number[] }) {
  const id = useId();
  const W = 1000;
  const H = 300;
  const max = Math.max(1, ...values);
  const peak = values.indexOf(Math.max(...values));
  const front = ptsOf(values, W, H, 70, max);
  const mid = ptsOf(smooth(values, 5), W, H, 70, max).map(([x, y]): [number, number] => [x, H - (H - y) * 0.78]);
  const back = ptsOf(smooth(values, 14), W, H, 70, max).map(([x, y]): [number, number] => [x, H - (H - y) * 0.55]);
  const fill = (p: [number, number][]) => `${wavePath(p)}L${W} ${H}L0 ${H}Z`;
  const [px, py] = front[peak] ?? [W / 2, H];
  return (
    <div className="g-ridge" role="img" aria-label={`Tokens per day across your whole history, peaking on the busiest day`}>
      <svg viewBox={`0 0 ${W} ${H}`}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.34" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={fill(back)} className="g-ridge-back" data-a style={vars({ "--i": 0 })} />
        <path d={fill(mid)} className="g-ridge-mid" data-a style={vars({ "--i": 1 })} />
        <path d={fill(front)} fill={`url(#${id})`} className="g-ridge-area" data-a />
        <path d={wavePath(front)} pathLength={1} className="g-ridge-line g-draw" data-a />
      </svg>
      <span className="g-summit" data-a style={{ left: `${(px / W) * 100}%`, top: `${(py / H) * 100}%` }}>
        <Spark size={24} />
      </span>
    </div>
  );
}

// ---- novels: a shelf of spines -------------------------------------------------------------

const SPINE_TONES = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)"];

/** Books lying in a stack, dropped in one by one; more than a dozen are said, not drawn. */
export function Spines({ count }: { count: number }) {
  const shown = Math.max(1, Math.min(12, count));
  const more = count - shown;
  const H = 26;
  const base = 330;
  return (
    <svg className="g-svg" viewBox="0 0 400 360" role="img" aria-label={`A stack of ${count} novels`}>
      <line x1="40" x2="360" y1={base + 2} y2={base + 2} stroke="var(--line-strong)" strokeWidth="3" strokeLinecap="round" />
      {Array.from({ length: shown }, (_, i) => {
        const w = 230 + ((i * 53) % 90);
        const x = 200 - w / 2 + (((i * 37) % 31) - 15);
        const y = base - (i + 1) * (H + 2);
        const top = i === shown - 1;
        return (
          <g key={i} className="g-book" data-a style={vars({ "--i": i, "--tilt": `${((i * 7) % 5) - 2}deg` })}>
            <rect x={x} y={y} width={w} height={H} rx="4" fill={top ? "var(--accent)" : SPINE_TONES[i % SPINE_TONES.length]} />
            <rect x={x + 12} y={y + 7} width="26" height="3" rx="1.5" fill="var(--surface)" opacity="0.7" />
            <rect x={x + 12} y={y + 14} width="16" height="3" rx="1.5" fill="var(--surface)" opacity="0.5" />
            <rect x={x + w - 22} y={y} width="3" height={H} fill="var(--surface)" opacity="0.45" />
          </g>
        );
      })}
      {more > 0 && (
        <text x="200" y={base - shown * (H + 2) - 14} textAnchor="middle" className="g-text g-text-2" data-a style={vars({ "--i": shown })}>
          and {compact(more)} more
        </text>
      )}
    </svg>
  );
}

// ---- oldest chat: a trail ------------------------------------------------------------------

function monthMarks(from: string, days: number): { at: number; label: string }[] {
  const [y, m, d] = from.split("-").map(Number);
  const out: { at: number; label: string }[] = [];
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const start = new Date(y, m - 1, d, 12).getTime();
  for (let k = 1; k <= 60; k++) {
    const t = new Date(y, m - 1 + k, 1, 12);
    const at = Math.round((t.getTime() - start) / 86_400_000);
    if (at >= days) break;
    out.push({ at, label: names[t.getMonth()] });
  }
  return out;
}

/** A winding trail from the oldest chat to today, with a mark at each month you walked past. */
export function Trail({ from, to, days }: Of<"trail">) {
  const W = 1000;
  const pad = 56;
  const xAt = (k: number) => pad + (k / Math.max(1, days)) * (W - pad * 2);
  const yAt = (x: number) => 74 + Math.sin((x / W) * Math.PI * 3.2) * 24 - (x / W) * 18;
  const pts: [number, number][] = [];
  for (let x = pad; x <= W - pad; x += 20) pts.push([x, yAt(x)]);
  const d = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x} ${y.toFixed(1)}`).join("");
  const marks = monthMarks(from, days);
  const end = pts[pts.length - 1];
  return (
    <svg className="g-svg" viewBox="0 0 1000 150" role="img" aria-label={`A trail of ${days} days from ${shortDay(from)} to ${shortDay(to)}`}>
      <path d={d} fill="none" stroke="var(--line-strong)" strokeWidth="6" strokeLinecap="round" strokeDasharray="1 14" />
      <path d={d} pathLength={1} fill="none" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" className="g-draw g-draw-slow" data-a />
      {marks.map((m, i) => (
        <g key={m.at} className="g-pop" data-a style={vars({ "--i": 3 + i * 2 })}>
          <circle cx={xAt(m.at)} cy={yAt(xAt(m.at))} r="6" fill="var(--surface)" stroke="var(--accent)" strokeWidth="3" />
          <text x={xAt(m.at)} y={yAt(xAt(m.at)) + 30} textAnchor="middle" className="g-text g-text-2">
            {m.label}
          </text>
        </g>
      ))}
      <g className="g-pop" data-a style={vars({ "--i": 0 })}>
        <line x1={pad} x2={pad} y1={yAt(pad) + 8} y2={yAt(pad) - 40} stroke="var(--ink)" strokeWidth="3" strokeLinecap="round" />
        <path d={`M${pad} ${yAt(pad) - 40}L${pad + 30} ${yAt(pad) - 31}L${pad} ${yAt(pad) - 22}Z`} fill="var(--accent)" />
        <text x={pad} y={yAt(pad) + 36} textAnchor="middle" className="g-text">
          {shortDay(from)}
        </text>
      </g>
      <g className="g-pop g-pop-end" data-a>
        <circle cx={end[0]} cy={end[1]} r="9" fill="var(--accent)" />
        <text x={end[0]} y={end[1] + 36} textAnchor="middle" className="g-text">
          Today
        </text>
      </g>
    </svg>
  );
}

// ---- days: the calendar --------------------------------------------------------------------

/** Heat band 0..5 for a day, by its place among the active days (cuts at 20, 45, 70 and 90 percent). */
export function heatBand(v: number, sortedActive: number[]): number {
  if (v <= 0 || sortedActive.length === 0) return 0;
  let below = 0;
  for (const a of sortedActive) if (a < v) below++;
  const q = below / sortedActive.length;
  return q < 0.2 ? 1 : q < 0.45 ? 2 : q < 0.7 ? 3 : q < 0.9 ? 4 : 5;
}

/** The last weeks as a calendar, the best streak ringed in clay, today in the corner. */
export function HeatGrid({ values, start, run, weeks }: Of<"heat">) {
  const cell = 18;
  const gap = 5;
  const step = cell + gap;
  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  const W = weeks * step - gap;
  const H = 7 * step - gap;
  const at = (i: number) => ({ col: Math.floor((start + i) / 7), row: (start + i) % 7 });
  return (
    <svg className="g-svg" viewBox={`-3 -3 ${W + 6} ${H + 6}`} role="img" aria-label={`${sorted.length} active days in the last ${values.length} days${run ? `, with a run of ${run[1] - run[0] + 1} days in a row ringed` : ""}`}>
      {values.map((v, i) => {
        const { col, row } = at(i);
        return (
          <rect key={i} x={col * step} y={row * step} width={cell} height={cell} rx="5" fill={`var(--heat-${heatBand(v, sorted)})`} className="g-cell" data-a style={vars({ "--i": col })} />
        );
      })}
      {run &&
        Array.from({ length: run[1] - run[0] + 1 }, (_, k) => {
          const { col, row } = at(run[0] + k);
          return (
            <rect
              key={k}
              x={col * step - 2}
              y={row * step - 2}
              width={cell + 4}
              height={cell + 4}
              rx="7"
              fill="none"
              stroke="var(--accent-text)"
              strokeWidth="2.2"
              className="g-ring"
              data-a
              style={vars({ "--i": at(run[1]).col })}
            />
          );
        })}
      {(() => {
        const { col, row } = at(values.length - 1);
        return <rect x={col * step - 3} y={row * step - 3} width={cell + 6} height={cell + 6} rx="8" fill="none" stroke="var(--ink)" strokeWidth="2" className="g-ring" data-a style={vars({ "--i": weeks })} />;
      })()}
    </svg>
  );
}

// ---- biggest chat: a tower -----------------------------------------------------------------

/** One tower, with the average chat standing beside it. */
export function Tower({ value, avg }: Of<"tower">) {
  const base = 292;
  const full = 230;
  const short = Math.max(10, Math.min(full, (avg / Math.max(1, value)) * full));
  const rows = Math.floor(full / 28);
  return (
    <svg className="g-svg" viewBox="0 0 380 340" role="img" aria-label={`This chat used ${compact(value)} tokens; the average chat used ${compact(avg)}`}>
      <line x1="20" x2="360" y1={base + 2} y2={base + 2} stroke="var(--line-strong)" strokeWidth="3" strokeLinecap="round" />
      <g className="g-rise" data-a style={vars({ "--i": 0 })}>
        <rect x="60" y={base - full} width="120" height={full} rx="10" fill="var(--accent)" />
        {Array.from({ length: rows }, (_, r) =>
          [0, 1, 2].map((c) => <rect key={`${r}-${c}`} x={78 + c * 34} y={base - full + 16 + r * 28} width="20" height="14" rx="3" fill="var(--on-accent)" opacity="0.4" />),
        )}
        <line x1="120" x2="120" y1={base - full} y2={base - full - 30} stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
      </g>
      <g className="g-pop" data-a style={vars({ "--i": 14 })}>
        <circle cx="120" cy={base - full - 34} r="7" fill="var(--accent)" />
      </g>
      <g className="g-fade" data-a style={vars({ "--i": 8 })}>
        <line x1="180" x2="244" y1={base - short} y2={base - short} stroke="var(--ink-2)" strokeWidth="2" strokeDasharray="2 6" strokeLinecap="round" />
      </g>
      <g className="g-rise" data-a style={vars({ "--i": 6 })}>
        <rect x="244" y={base - short} width="76" height={short} rx="8" fill="var(--chart-2)" />
      </g>
      <text x="120" y={base + 30} textAnchor="middle" className="g-text">
        This chat {compact(value)}
      </text>
      <text x="282" y={base - short - 12} textAnchor="middle" className="g-text g-text-2">
        Average {compact(avg)}
      </text>
    </svg>
  );
}

// ---- longest sitting: a dial ---------------------------------------------------------------

/** A twelve-hour dial; each full lap is a ring, the last ring stops where the sitting did. */
export function Dial({ hours }: Of<"dial">) {
  const laps = Math.floor(hours / 12);
  const rest = (hours % 12) / 12;
  const rings = Math.min(4, laps + (rest > 0 ? 1 : 0));
  const angle = rest > 0 ? rest * 360 : 0;
  const gap = 15;
  return (
    <svg className="g-svg" viewBox="0 0 300 300" role="img" aria-label={`A sitting of ${formatDuration(hours * 3_600_000)}`}>
      <circle cx="150" cy="150" r="136" fill="var(--surface)" stroke="var(--line-strong)" strokeWidth="2" />
      {Array.from({ length: 12 }, (_, k) => {
        const a = (k / 12) * Math.PI * 2;
        const r1 = k % 3 === 0 ? 112 : 120;
        return <line key={k} x1={150 + Math.sin(a) * r1} y1={150 - Math.cos(a) * r1} x2={150 + Math.sin(a) * 128} y2={150 - Math.cos(a) * 128} stroke="var(--ink-2)" strokeWidth={k % 3 === 0 ? 4 : 2} strokeLinecap="round" />;
      })}
      {Array.from({ length: rings }, (_, k) => {
        const full = k < laps;
        const r = 100 - k * gap;
        return (
          <circle
            key={k}
            cx="150"
            cy="150"
            r={r}
            fill="none"
            pathLength={1}
            stroke={full ? "var(--accent)" : "var(--chart-1)"}
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={full ? "1 1" : `${rest} 1`}
            transform="rotate(-90)" /* about the ring's own centre: .wr-gfx svg [data-a] sets the box and origin, so no centre here */
            className="g-draw g-draw-dial"
            data-a
            style={vars({ "--i": k, "--dash": full ? 1 : rest, opacity: full ? 0.55 : 1 })}
          />
        );
      })}
      <g className="g-hand" data-a style={vars({ "--turn": `${angle}deg`, "--i": Math.max(0, rings - 1) })}>
        <line x1="150" y1="150" x2="150" y2="46" stroke="var(--ink)" strokeWidth="5" strokeLinecap="round" />
      </g>
      <circle cx="150" cy="150" r="9" fill="var(--ink)" />
    </svg>
  );
}

// ---- project: tiles ------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Slice a box into tiles sized by value: split the list where the halves weigh most alike, across the longer side. */
export function tileBoxes(values: number[], box: Box = { x: 0, y: 0, w: 100, h: 100 }): Box[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [box];
  const total = values.reduce((a, b) => a + b, 0) || 1;
  let k = 1;
  let best = Infinity;
  let left = 0;
  for (let i = 0; i < values.length - 1; i++) {
    left += values[i];
    const gap = Math.abs(left - total / 2);
    if (gap < best) {
      best = gap;
      k = i + 1;
    }
  }
  const a = values.slice(0, k);
  const b = values.slice(k);
  const share = a.reduce((x, y) => x + y, 0) / total;
  return box.w >= box.h
    ? [...tileBoxes(a, { ...box, w: box.w * share }), ...tileBoxes(b, { x: box.x + box.w * share, y: box.y, w: box.w * (1 - share), h: box.h })]
    : [...tileBoxes(a, { ...box, h: box.h * share }), ...tileBoxes(b, { x: box.x, y: box.y + box.h * share, w: box.w, h: box.h * (1 - share) })];
}

/** Projects as tiles: the area of each is its share of the tokens. */
export function Tiles({ rows }: { rows: Row[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  const boxes = tileBoxes(rows.map((r) => r.value));
  return (
    <div className="g-tiles" role="img" aria-label={rows.map((r) => `${r.label} ${Math.round((r.value / total) * 100)}%`).join(", ")}>
      {rows.map((r, i) => (
        <div key={r.label} className="g-tile" data-first={i === 0 ? "" : undefined} data-a style={vars({ left: `${boxes[i].x}%`, top: `${boxes[i].y}%`, width: `${boxes[i].w}%`, height: `${boxes[i].h}%`, "--c": FILL[i % FILL.length], "--i": i })}>
          <div className="g-tile-in">
            <span className="g-tile-name">{r.label}</span>
            <span className="g-tile-pct">{Math.round((r.value / total) * 100)}%</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- skills: a podium ----------------------------------------------------------------------

/** The top three on a podium (second, first, third), the rest as small tags. Arrives from the bottom up. */
export function Podium({ rows }: { rows: Row[] }) {
  const max = Math.max(1, rows[0]?.value ?? 1);
  const order = [1, 0, 2].filter((k) => rows[k]);
  const rest = rows.slice(3);
  const n = rows.length;
  return (
    <div className="g-podium" role="list" aria-label={`Top ${rows.length}, ranked`}>
      <div className="g-podium-row">
        {order.map((k) => {
          const r = rows[k];
          const h = k === 0 ? 100 : Math.max(34, Math.min(88, (r.value / max) * 100));
          return (
            <div key={r.label} role="listitem" className="g-pod" data-rank={k + 1} data-first={k === 0 ? "" : undefined} style={vars({ "--r": n - 1 - k })}>
              <div className="g-pod-name" data-a>
                <span className="g-pod-label">{r.label}</span>
                <span className="g-pod-note">{r.note ?? compact(r.value)}</span>
              </div>
              <div className="g-pod-block" data-a style={{ height: `${h}%` }}>
                <span className="g-pod-num">{k + 1}</span>
              </div>
            </div>
          );
        })}
      </div>
      {rest.length > 0 && (
        <ul className="g-podium-rest">
          {rest.map((r, i) => (
            <li key={r.label} role="listitem" data-a style={vars({ "--r": n - 4 - i })}>
              <b>{i + 4}</b>
              <span>{r.label}</span>
              <i>{r.note ?? compact(r.value)}</i>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- helper: lollipops ---------------------------------------------------------------------

/** Each helper a stem that grows to a dot; the longest stem is the most called. */
export function Lollipops({ rows }: { rows: Row[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const step = 62;
  const len = 250;
  return (
    <svg className="g-svg" viewBox={`0 0 420 ${rows.length * step + 6}`} role="img" aria-label={rows.map((r) => `${r.label} ${r.note ?? compact(r.value)}`).join(", ")}>
      {rows.map((r, i) => {
        const y = i * step + 44;
        const w = Math.max(14, (r.value / max) * len);
        const first = i === 0;
        return (
          <g key={r.label}>
            <text x="0" y={y - 20} className="g-text" fontWeight={first ? 700 : 500}>
              {r.label.length > 30 ? `${r.label.slice(0, 29)}...` : r.label}
            </text>
            <line x1="0" x2="410" y1={y} y2={y} stroke="var(--line)" strokeWidth="2" />
            <line x1="0" x2={w} y1={y} y2={y} stroke={first ? "var(--accent)" : "var(--ink-2)"} strokeWidth={first ? 6 : 4} strokeLinecap="round" className="g-stem" data-a style={vars({ "--i": i })} />
            <circle cx={w} cy={y} r={first ? 13 : 9} fill={first ? "var(--accent)" : "var(--ink-2)"} className="g-dot" data-a style={vars({ "--i": i, "--w": `${w}px` })} />
            <text x={w + 22} y={y + 5} className="g-text g-text-2 g-dot-note" data-a style={vars({ "--i": i })}>
              {r.note ?? compact(r.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- crowd: a burst ------------------------------------------------------------------------

/** The helpers around their chat: a sunflower of dots, one per helper (the first 90). */
export function Burst({ count }: Of<"burst">) {
  const n = Math.max(1, Math.min(90, count));
  const c = 128 / Math.sqrt(n + 3);
  const dots = Array.from({ length: n }, (_, i) => {
    const r = 26 + c * Math.sqrt(i + 1);
    const a = i * 2.399963;
    return { x: Math.cos(a) * r, y: Math.sin(a) * r, i };
  });
  const rad = Math.max(4, Math.min(12, c * 0.42));
  return (
    <svg className="g-svg" viewBox="-150 -150 300 300" role="img" aria-label={`A chat with ${count} helpers around it`}>
      {dots.map((p) => (
        <line key={`l${p.i}`} x1="0" y1="0" x2={p.x} y2={p.y} stroke="var(--line-strong)" strokeWidth="1.2" className="g-fade" data-a style={vars({ "--i": Math.min(p.i, 40) })} />
      ))}
      {dots.map((p) => (
        <circle key={p.i} cx={p.x} cy={p.y} r={rad} fill={FILL[p.i % 3]} className="g-burst" data-a style={vars({ "--i": Math.min(p.i, 60), "--dx": `${p.x}px`, "--dy": `${p.y}px` })} />
      ))}
      <circle cx="0" cy="0" r="22" fill="var(--accent)" className="g-pop" data-a style={vars({ "--i": 0 })} />
      <circle cx="0" cy="0" r="9" fill="var(--on-accent)" opacity="0.85" className="g-pop" data-a style={vars({ "--i": 0 })} />
    </svg>
  );
}

// ---- tool: bubbles -------------------------------------------------------------------------

/** Tools as bubbles on a baseline; the area of each follows how often it ran. */
export function Bubbles({ rows }: { rows: Row[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const rs = rows.map((r) => 22 + Math.sqrt(r.value / max) * 66);
  const gap = 34;
  const W = rs.reduce((s, r) => s + r * 2, 0) + gap * (rs.length - 1);
  let x = (900 - W) / 2;
  const base = 184;
  return (
    <svg className="g-svg" viewBox="0 0 900 244" role="img" aria-label={rows.map((r) => `${r.label} ${r.note ?? compact(r.value)}`).join(", ")}>
      <line x1="40" x2="860" y1={base + 1} y2={base + 1} stroke="var(--line-strong)" strokeWidth="2" strokeLinecap="round" />
      {rows.map((row, i) => {
        const r = rs[i];
        const cx = x + r;
        x += r * 2 + gap;
        const first = i === 0;
        return (
          <g key={row.label} className="g-bubble" data-a style={vars({ "--i": i })}>
            <circle cx={cx} cy={base - r} r={r} fill={first ? "var(--accent)" : i % 2 ? "var(--chart-2)" : "var(--chart-3)"} />
            <text x={cx} y={base + 26} textAnchor="middle" className="g-text" fontWeight={first ? 700 : 500}>
              {row.label.length > 16 ? `${row.label.slice(0, 15)}...` : row.label}
            </text>
            <text x={cx} y={base + 46} textAnchor="middle" className="g-text g-text-2">
              {row.note ?? compact(row.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ---- busiest day: a spike ------------------------------------------------------------------

/** The days around the busiest one as bars, rising outward from it; the spark sits on the peak. */
export function Spike({ values, peak, first, last }: Of<"spike">) {
  const W = 1000;
  const H = 260;
  const LH = 30; // the row of day labels under the baseline
  const n = values.length;
  const max = Math.max(1, ...values);
  const slot = W / n;
  const bw = slot * 0.66;
  const hAt = (v: number) => (v <= 0 ? 6 : Math.max(10, (v / max) * (H - 56)));
  return (
    <div className="g-spike" role="img" aria-label={`Tokens per day around your busiest day, ${first} to ${last}`}>
      <svg viewBox={`0 0 ${W} ${H + LH}`}>
        {values.map((v, i) => (
          <rect
            key={i}
            x={i * slot + (slot - bw) / 2}
            y={H - hAt(v)}
            width={bw}
            height={hAt(v)}
            rx="9"
            className="g-spike-bar"
            data-peak={i === peak ? "" : undefined}
            data-zero={v <= 0 ? "" : undefined}
            data-a
            style={vars({ "--i": Math.abs(i - peak) })}
          />
        ))}
        <text x="4" y={H + 22} className="g-text g-text-2" fontSize="19">
          {first}
        </text>
        <text x={W - 4} y={H + 22} textAnchor="end" className="g-text g-text-2" fontSize="19">
          {last}
        </text>
      </svg>
      <span className="g-summit" data-a style={{ left: `${((peak + 0.5) / n) * 100}%`, top: `${((H - hAt(values[peak] ?? 0)) / (H + LH)) * 100}%` }}>
        <Spark size={26} />
      </span>
    </div>
  );
}

// ---- weekday: seven spokes -----------------------------------------------------------------

/** Seven spokes round a hub, Monday at the top, each as long as that weekday is busy; they sweep out clockwise. */
export function Spokes({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const top = values.indexOf(Math.max(...values));
  return (
    <svg className="g-svg" viewBox="-150 -150 300 300" role="img" aria-label={`Tokens by weekday, busiest on ${WEEKDAYS[top] ?? "none"}`}>
      <circle cx="0" cy="0" r="30" fill="none" stroke="var(--line-strong)" strokeWidth="2" />
      <circle cx="0" cy="0" r="124" fill="none" stroke="var(--line)" strokeWidth="1.5" strokeDasharray="2 7" strokeLinecap="round" />
      {values.map((v, i) => {
        const a = (i / 7) * 360;
        const len = 14 + (Math.max(0, v) / max) * 78;
        const rad = ((a - 90) * Math.PI) / 180;
        return (
          <g key={i}>
            <g transform={`rotate(${a})`}>
              <rect x="-11" y={-(36 + len)} width="22" height={len} rx="11" fill={i === top ? "var(--accent)" : "var(--bar-rest)"} className="g-spoke" data-a style={vars({ "--i": i })} />
            </g>
            <text x={Math.cos(rad) * 136} y={Math.sin(rad) * 136 + 5} textAnchor="middle" className="g-text" fontWeight={i === top ? 700 : 500}>
              {WEEKDAYS_SHORT[i]}
            </text>
          </g>
        );
      })}
      <circle cx="0" cy="0" r="5" fill="var(--ink-2)" />
    </svg>
  );
}

// ---- prime time: the day as a strip --------------------------------------------------------

/** The 24 hours as a strip of cells, a sun arc over it and the spark at your hour. */
export function DayStrip({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const peak = peakHour(values);
  const cell = 36;
  const step = 40;
  const arcY = (x: number) => {
    const t = (x - 20) / 920;
    return 112 - Math.sin(Math.PI * Math.min(1, Math.max(0, t))) * 92;
  };
  const arc = Array.from({ length: 47 }, (_, k) => {
    const x = 20 + (k / 46) * 920;
    return `${k === 0 ? "M" : "L"}${x.toFixed(1)} ${arcY(x).toFixed(1)}`;
  }).join("");
  const sx = peak === null ? 0 : peak * step + cell / 2;
  const night = (h: number) => h >= 21 || h < 5;
  return (
    <svg className="g-svg" viewBox="0 0 960 190" role="img" aria-label={peak === null ? "Tokens by hour of day" : `Tokens by hour of day, busiest around ${hourLabel(peak)}`}>
      <path d={arc} pathLength={1} fill="none" stroke="var(--ink-2)" strokeWidth="2.5" strokeDasharray="2 9" strokeLinecap="round" opacity="0.7" className="g-fade" data-a style={vars({ "--i": 0 })} />
      {values.map((v, h) => {
        const band = v <= 0 ? 0 : Math.max(1, Math.ceil((v / max) * 5));
        return <rect key={h} x={h * step} y="124" width={cell} height="40" rx="8" fill={`var(--heat-${band})`} className="g-cell g-cell-up" data-a style={vars({ "--i": h })} />;
      })}
      {values.map((_, h) => (
        <rect key={`n${h}`} x={h * step} y="170" width={cell} height="5" rx="2.5" fill={night(h) ? "var(--chart-2)" : "var(--chart-3)"} opacity={night(h) ? 0.9 : 0.55} />
      ))}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={h * step + cell / 2} y="190" textAnchor="middle" className="g-text g-text-2" fontSize="13">
          {hourLabel(h)}
        </text>
      ))}
      {peak !== null && (
        <g className="g-pop g-pop-end" data-a>
          <line x1={sx} x2={sx} y1={arcY(sx) + 14} y2="120" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray="3 5" strokeLinecap="round" />
          <circle cx={sx} cy={arcY(sx)} r="15" fill="var(--accent)" />
          <circle cx={sx} cy={arcY(sx)} r="6" fill="var(--on-accent)" opacity="0.85" />
        </g>
      )}
    </svg>
  );
}

// ---- models: a ring ------------------------------------------------------------------------

/** Models as a ring of arcs that draw one after another, the legend beside it. */
export function Donut({ rows }: { rows: Row[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  let acc = 0;
  return (
    <div className="g-donut" role="img" aria-label={rows.map((r) => `${r.label} ${Math.round((r.value / total) * 100)}%`).join(", ")}>
      <svg viewBox="-110 -110 220 220">
        <circle cx="0" cy="0" r="80" fill="none" stroke="var(--raised)" strokeWidth="26" />
        {rows.map((r, i) => {
          const share = r.value / total;
          const from = acc;
          acc += share;
          const len = Math.max(0.004, share - 0.012);
          return (
            <circle
              key={r.label}
              cx="0"
              cy="0"
              r="80"
              fill="none"
              pathLength={1}
              stroke={FILL[i % FILL.length]}
              strokeWidth="26"
              strokeDasharray={`${len} 1`}
              transform={`rotate(${from * 360 - 90})`}
              className="g-arc"
              data-a
              style={vars({ "--i": i, "--dash": len })}
            />
          );
        })}
        <text x="0" y="12" textAnchor="middle" className="g-donut-pct">
          {Math.round((rows[0].value / total) * 100)}%
        </text>
      </svg>
      <ul className="g-donut-key">
        {rows.map((r, i) => (
          <li key={r.label} data-a style={vars({ "--i": i })}>
            <i style={{ background: FILL[i % FILL.length] }} aria-hidden="true" />
            <span>{r.label}</span>
            <b>{Math.round((r.value / total) * 100)}%</b>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- coder type: a badge and its gauge -----------------------------------------------------

const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/** The type as an emblem inside a half-dial gauge; the tick is the mark a habit has to reach. */
export function Badge({ name, score, traits }: Of<"badge">) {
  const fill = Math.min(1, Math.max(0, score) / 2);
  const hex = Array.from({ length: 6 }, (_, k) => {
    const a = (k / 6) * Math.PI * 2 - Math.PI / 2;
    return `${(130 + Math.cos(a) * 46).toFixed(1)},${(98 + Math.sin(a) * 46).toFixed(1)}`;
  }).join(" ");
  const rest = traits.slice(1);
  return (
    <div className="g-badge">
      <svg viewBox="0 0 260 150" role="img" aria-label={`${name}, ${Math.round(score * 100)}% of the mark`}>
        <path d="M20 130A110 110 0 0 1 240 130" fill="none" stroke="var(--line-strong)" strokeWidth="14" strokeLinecap="round" />
        <path d="M20 130A110 110 0 0 1 240 130" pathLength={1} fill="none" stroke="var(--accent)" strokeWidth="14" strokeLinecap="round" strokeDasharray={`${fill} 1`} className="g-draw g-draw-slow" data-a style={vars({ "--dash": fill })} />
        <line x1="130" x2="130" y1="9" y2="31" stroke="var(--ink)" strokeWidth="4" strokeLinecap="round" />
        <g className="g-pop" data-a style={vars({ "--i": 2 })}>
          <polygon points={hex} fill="var(--accent)" stroke="var(--surface)" strokeWidth="5" strokeLinejoin="round" />
          <text x="130" y="110" textAnchor="middle" className="g-badge-ini">
            {initials(name)}
          </text>
        </g>
      </svg>
      {rest.length > 0 && (
        <ul className="g-badge-list">
          {rest.map((t, i) => (
            <li key={t.name} data-a style={vars({ "--i": i + 3 })}>
              <span>{t.name}</span>
              <i>{t.note}</i>
              <em aria-hidden="true">
                <u style={{ width: `${Math.min(1, t.score / 2) * 100}%` }} />
              </em>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- the switch ----------------------------------------------------------------------------

export function Graphic({ chart }: { chart: SlideChart }): ReactNode {
  switch (chart.kind) {
    case "ridge":
      return <Ridge values={chart.values} />;
    case "spines":
      return <Spines count={chart.count} />;
    case "trail":
      return <Trail {...chart} />;
    case "heat":
      return <HeatGrid {...chart} />;
    case "tower":
      return <Tower {...chart} />;
    case "dial":
      return <Dial {...chart} />;
    case "tiles":
      return <Tiles rows={chart.rows} />;
    case "podium":
      return <Podium rows={chart.rows} />;
    case "lollipop":
      return <Lollipops rows={chart.rows} />;
    case "burst":
      return <Burst {...chart} />;
    case "bubbles":
      return <Bubbles rows={chart.rows} />;
    case "spike":
      return <Spike {...chart} />;
    case "spokes":
      return <Spokes values={chart.values} />;
    case "strip":
      return <DayStrip values={chart.values} />;
    case "donut":
      return <Donut rows={chart.rows} />;
    case "badge":
      return <Badge {...chart} />;
  }
}
