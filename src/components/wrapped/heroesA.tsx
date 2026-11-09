import { useMemo } from "react";
import { compact, exact } from "../../lib/usage";
import {
  chamfer,
  dialFrame,
  dialModel,
  heatLayout,
  OUT,
  polar,
  skyline,
  SWATCH,
  projectTiles,
  towerBlocks,
  trailLayout,
} from "../../lib/posterMath";
import type { HeroBox } from "../../lib/posterMath";
import type { Row, SlideChart } from "../../lib/wrappedModel";
import { clamp01 } from "../../lib/wrappedClock";
import { useClockCtx, useTick } from "./clock";
import {
  after,
  beatValue,
  enter,
  fade,
  HeroSvg,
  pieces,
  pop,
  put,
  ripple,
  spin,
  star,
  useEl,
  useEls,
} from "./heroKit";

// The first seven hero graphics: tokens, novels, first chat, days, biggest chat, longest sitting,
// project. Each is a pure function of the data and its box, drawn once, then moved by a tick that
// writes poses straight to the DOM (see heroKit). Flat fills, 8 px slate outlines, no gradients.

type Kind<K extends SlideChart["kind"]> = Extract<SlideChart, { kind: K }>;
interface P<K extends SlideChart["kind"]> {
  chart: Kind<K>;
  box: HeroBox;
}

const PEAK_NOTE = "Your busiest stretch";

// ---- tokens: a skyline and a sun ------------------------------------------------------------------

export function TokensHero({ chart, box }: P<"ridge">) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const bars = useMemo(() => skyline(chart.values, box), [chart.values, box]);
  const { els, ref } = useEls();
  const sun = useEl();
  const sunX = box.side === "r" ? box.w - 150 : 150;
  useTick((t) => {
    bars.forEach((_, i) => {
      const { p, landed } = at(t, i, bars.length);
      put(els.current[i], enter(ctx.mood, p, landed));
    });
    const s = at(t, 0, 1);
    put(sun.el.current, pop(ctx.mood, s.p, s.landed));
  });
  return (
    <HeroSvg box={box}>
      <circle
        ref={sun.ref}
        className="f-acc ln o-c"
        cx={sunX}
        cy={box.ceil + 96}
        r={92}
      />
      {bars.map((b, i) => (
        <path
          key={i}
          ref={ref(i)}
          className={`${b.peak ? "f-fg" : "f-alt"} ln o-b`}
          d={chamfer(b.x, b.y, b.w, b.h, 8)}
        >
          {b.peak ? <title>{PEAK_NOTE}</title> : null}
        </path>
      ))}
    </HeroSvg>
  );
}

// ---- novels: a pile of books lying down ----------------------------------------------------------------

export const SHELF_MAX = 8;

/** The books drawn for a count, and the true number left over (0 when all are drawn). */
export function shelf(count: number): { shown: number; more: number } {
  const shown = Math.max(1, Math.min(SHELF_MAX, count));
  return { shown, more: Math.max(0, count - shown) };
}

export function NovelsHero({ chart, box }: P<"spines">) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const { shown, more } = shelf(chart.count);
  const { els, ref } = useEls();
  const chip = useEl();
  // Stacked from the floor up so the pile builds from the bottom; the odd ones sit a little off true.
  const room = box.floor - box.ceil - (more > 0 ? 54 : 0);
  const h = Math.min(66, room / shown);
  const base = box.floor;
  const spine = box.w - 40;
  useTick((t) => {
    for (let i = 0; i < shown; i++) {
      const { p, landed } = at(t, i, shown);
      put(els.current[i], enter(ctx.mood, p, landed, 360));
    }
    const last = at(t, shown - 1, shown);
    put(chip.el.current, { o: last.p > 0.9 ? 1 : 0 });
  });
  return (
    <HeroSvg box={box}>
      {Array.from({ length: shown }, (_, i) => {
        const off = ((i * 37) % 5) * 9 - 18;
        const y = base - (i + 1) * h;
        const sw = SWATCH[i % SWATCH.length];
        return (
          <g key={i} ref={ref(i)} className="o-b">
            <path
              className={`f-${sw.fill} ln`}
              d={chamfer(20 + off, y + 3, spine, h - 6, 10)}
            />
            <rect
              className="f-dark"
              x={20 + off + 34}
              y={y + 3}
              width={16}
              height={h - 6}
            />
            <rect
              className="f-dark"
              x={20 + off + spine - 60}
              y={y + 3}
              width={16}
              height={h - 6}
            />
          </g>
        );
      })}
      {more > 0 ? (
        <g ref={chip.ref}>
          <path className="f-sbg ln" d={chamfer(20, box.ceil, 190, 40, 8)} />
          <text className="pr-lab f-sfg" x={36} y={box.ceil + 27}>
            {`+${exact(more)} more`}
          </text>
        </g>
      ) : null}
    </HeroSvg>
  );
}

// ---- first chat: a trail of stones ------------------------------------------------------------------

export function FirstHero({ chart, box }: P<"trail">) {
  const ctx = useClockCtx();
  const trail = useMemo(
    () => trailLayout(chart.from, chart.days, box),
    [chart, box],
  );
  const { els, ref } = useEls();
  const walker = useEl();
  const flag = useEl();
  const path = trail.stones
    .map((s, i) => `${i ? "L" : "M"}${s.x.toFixed(1)} ${s.y.toFixed(1)}`)
    .join("");
  const n = trail.stones.length;
  useTick((t) => {
    const p = beatValue(ctx, "hand", t);
    const at = p * (n - 1);
    trail.stones.forEach((_, i) => {
      const k = clamp01(at - i + 1);
      put(els.current[i], { sx: k, sy: k, o: k > 0.003 ? 1 : 0 });
    });
    const i0 = Math.min(n - 2, Math.floor(at));
    const f = at - i0;
    const a = trail.stones[i0];
    const b = trail.stones[i0 + 1];
    put(walker.el.current, {
      x: a.x + (b.x - a.x) * f,
      y: a.y + (b.y - a.y) * f - 2,
      o: 1,
    });
    fade(flag.el.current, after(p, 0.92));
  });
  return (
    <HeroSvg box={box}>
      <path
        className="s-soft"
        d={path}
        fill="none"
        strokeWidth={14}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {trail.stones.map((s, i) => (
        <circle
          key={i}
          ref={ref(i)}
          className="f-acc ln o-c"
          cx={s.x}
          cy={s.y}
          r={13}
        />
      ))}
      {trail.marks.map((m) => (
        <text
          key={m.label + m.x}
          className="pr-lab c-fg"
          x={m.x}
          y={m.ly}
          textAnchor="middle"
        >
          {m.label}
        </text>
      ))}
      <circle
        className="f-fg ln"
        cx={trail.start[0]}
        cy={trail.start[1]}
        r={26}
      />
      <text
        className="pr-lab c-fg"
        x={trail.start[0]}
        y={trail.start[1] - 42}
        textAnchor="middle"
      >
        FIRST
      </text>
      <g ref={flag.ref}>
        <path className="f-acc ln" d={star(trail.end[0], trail.end[1], 40)} />
        <text
          className="pr-lab c-fg"
          x={trail.end[0]}
          y={trail.end[1] - 52}
          textAnchor="middle"
        >
          TODAY
        </text>
      </g>
      <circle ref={walker.ref} className="f-fg ln" cx={0} cy={0} r={20} />
    </HeroSvg>
  );
}

// ---- days: the calendar ---------------------------------------------------------------------------------

export function DaysHero({ chart, box }: P<"heat">) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const lay = useMemo(
    () => heatLayout(chart.values, chart.start, chart.weeks, chart.run, box),
    [chart, box],
  );
  const cols = useMemo(() => {
    const byCol = new Map<number, typeof lay.cells>();
    for (const c of lay.cells)
      byCol.set(c.col, [...(byCol.get(c.col) ?? []), c]);
    return [...byCol.entries()].sort((a, b) => a[0] - b[0]);
  }, [lay]);
  const { els, ref } = useEls();
  const ring = useEl();
  const runCells = lay.cells.filter((c) => c.run);
  const mid = runCells.length
    ? runCells[Math.floor(runCells.length / 2)]
    : null;
  useTick((t) => {
    cols.forEach((_, i) => {
      const { p, landed } = at(t, i, cols.length);
      put(els.current[i], enter(ctx.mood, p, landed, 200));
    });
    ripple(ring.el.current, ctx, t);
  });
  return (
    <HeroSvg box={box}>
      {cols.map(([col, cells], i) => (
        <g key={col} ref={ref(i)} className="o-b">
          {cells.map((c) => (
            <rect
              key={c.i}
              className={c.run ? `hb${c.band} hb-run` : `hb${c.band}`}
              x={c.x}
              y={c.y}
              width={lay.size}
              height={lay.size}
              rx={c.run ? 0 : 3}
            />
          ))}
        </g>
      ))}
      {mid ? (
        <circle
          ref={ring.ref}
          className="s-fg f-none o-c"
          cx={mid.x + lay.size / 2}
          cy={mid.y + lay.size / 2}
          r={lay.size * 0.9}
          strokeWidth={OUT}
        />
      ) : null}
    </HeroSvg>
  );
}

// ---- biggest chat: a tower of average chats ----------------------------------------------------------------------

export function BiggestHero({ chart, box }: P<"tower">) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const tw = useMemo(() => towerBlocks(chart.value, chart.avg), [chart]);
  const { els, ref } = useEls();
  const label = useEl();
  const bw = Math.min(250, box.w * 0.46);
  // The stack is as tall as the ratio: whole blocks plus the share of one more, and a gap's worth of room when it is capped.
  const units = tw.whole + tw.part + (tw.capped ? 0.5 : 0);
  const bh = Math.min(84, (box.floor - box.ceil - 150) / units);
  const tx = box.w * 0.64 - bw / 2;
  const top = box.floor - (tw.whole + tw.part) * bh;
  const cutY = top + bh * 0.45;
  const cut = useEl();
  useTick((t) => {
    for (let i = 0; i < tw.blocks + 1; i++) {
      const { p, landed } = at(t, i, tw.blocks + 1);
      put(els.current[i], enter(ctx.mood, p, landed, 760));
    }
    const last = at(t, tw.blocks, tw.blocks + 1);
    fade(label.el.current, after(last.p, 0.8));
    fade(cut.el.current, after(last.p, 0.8));
  });
  return (
    <HeroSvg box={box}>
      <g ref={ref(0)} className="o-b">
        <path
          className="f-soft ln"
          d={chamfer(34, box.floor - bh, 120, bh, 8)}
        />
        <text
          className="pr-lab f-bg"
          x={94}
          y={box.floor - bh / 2 + 8}
          textAnchor="middle"
        >
          1x
        </text>
        <text
          className="pr-lab c-fg"
          x={94}
          y={box.floor - bh - 14}
          textAnchor="middle"
        >
          AVERAGE
        </text>
      </g>
      {Array.from({ length: tw.blocks }, (_, i) => {
        // The last block of a tower with a remainder is only as tall as the remainder.
        const h = i < tw.whole ? bh : bh * tw.part;
        return (
          <path
            key={i}
            ref={ref(i + 1)}
            className={`${i % 2 ? "f-alt" : "f-acc"} ln o-b`}
            d={chamfer(tx, box.floor - i * bh - h, bw, h, 8)}
          />
        );
      })}
      {tw.capped ? (
        <g ref={cut.ref} aria-hidden="true">
          <title>{`The tower is cut short: it is ${tw.label} the average chat.`}</title>
          <path
            className="f-bg ln"
            strokeLinejoin="miter"
            d={`M${tx - 16} ${cutY + 6}L${tx + bw + 16} ${cutY - 22}L${tx + bw + 16} ${cutY - 2}L${tx - 16} ${cutY + 26}Z`}
          />
        </g>
      ) : null}
      <text
        ref={label.ref}
        className="pr-num c-fg"
        x={tx + bw / 2}
        y={top - 18}
        textAnchor="middle"
        style={{ fontSize: 78 }}
      >
        {tw.label}
      </text>
    </HeroSvg>
  );
}

// ---- longest sitting: a dial -----------------------------------------------------------------------------------------

export function LongHero({ chart, box }: P<"dial">) {
  const ctx = useClockCtx();
  const m = useMemo(() => dialModel(chart.hours), [chart.hours]);
  const R = Math.min(box.w / 2 - 20, (box.floor - box.ceil) / 2 - 10, 290);
  const cx = box.w / 2;
  const cy = (box.ceil + box.floor) / 2;
  const hand = useEl();
  const rings = useEls();
  const stroke = 46;
  const radius = (k: number) => R - 44 - k * (stroke + 14);
  useTick((t) => {
    const f = dialFrame(m, beatValue(ctx, "hand", t));
    spin(hand.el.current, f.hand, cx, cy);
    f.offsets.forEach((o, k) =>
      rings.els.current[k]?.setAttribute("stroke-dashoffset", o.toFixed(4)),
    );
  });
  const ticks = Array.from({ length: 12 }, (_, i) => {
    const a = polar(cx, cy, R - 14, 90 - i * 30);
    const b = polar(cx, cy, R - 34, 90 - i * 30);
    return { a, b, big: i % 3 === 0 };
  });
  return (
    <HeroSvg box={box}>
      <circle className="f-tint ln" cx={cx} cy={cy} r={R} />
      {ticks.map((k, i) => (
        <line
          key={i}
          className="s-fg"
          x1={k.a[0]}
          y1={k.a[1]}
          x2={k.b[0]}
          y2={k.b[1]}
          strokeWidth={k.big ? 10 : 5}
        />
      ))}
      {m.fills.map((f, k) => (
        <g key={k} transform={`rotate(-90 ${cx} ${cy})`}>
          <circle
            className="s-dark"
            cx={cx}
            cy={cy}
            r={radius(k)}
            fill="none"
            strokeWidth={stroke}
            opacity={0.14}
          />
          <circle
            ref={rings.ref(k)}
            className="s-acc"
            cx={cx}
            cy={cy}
            r={radius(k)}
            fill="none"
            strokeWidth={stroke}
            pathLength={1}
            strokeDasharray={`${f} 2`}
            strokeDashoffset={f}
          />
        </g>
      ))}
      <g ref={hand.ref}>
        <line
          className="s-dark"
          x1={cx}
          y1={cy}
          x2={cx}
          y2={cy - (R - 30)}
          strokeWidth={12}
        />
        <circle className="f-acc ln" cx={cx} cy={cy} r={26} />
      </g>
    </HeroSvg>
  );
}

// ---- project: tiles sized by tokens ----------------------------------------------------------------------------------------

export function ProjectHero({ rows, box }: { rows: Row[]; box: HeroBox }) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  // Every tile carries its whole label (across it or turned along it); a project too small for that
  // leaves the picture rather than being cut or left bare.
  const tiles = useMemo(
    () =>
      projectTiles(
        rows.map((r) => ({ value: r.value, name: r.name ?? r.label })),
        { x: 0, y: box.ceil, w: box.w, h: box.floor - box.ceil },
      ),
    [rows, box],
  );
  const { els, ref } = useEls();
  useTick((t) => {
    tiles.forEach((_, i) => {
      const { p, landed } = at(t, i, tiles.length);
      put(els.current[i], enter(ctx.mood, p, landed, 420));
    });
  });
  return (
    <HeroSvg box={box}>
      {tiles.map((tile, i) => {
        const b = tile.box;
        const r = rows[i];
        const sw = SWATCH[i % SWATCH.length];
        const big = i === 0;
        // The biggest tile is the project the slide's title already names: it says what the tile weighs
        // instead, so the name is on the poster once.
        const px = tile.px;
        return (
          <g key={r.label} ref={ref(i)} className="o-b">
            <title>{`${r.label}: ${compact(r.value)} tokens`}</title>
            <path
              className={`f-${sw.fill} ln`}
              d={chamfer(b.x + 4, b.y + 4, b.w - 8, b.h - 8, 12)}
            />
            {px > 0 ? (
              <text
                className={big ? `pr-num f-${sw.ink}` : `pr-lab f-${sw.ink}`}
                x={tile.turn ? 0 : b.x + 22}
                y={tile.turn ? 0 : b.y + (big ? 66 : 22 + px)}
                transform={
                  tile.turn
                    ? `translate(${b.x + 20 + px * 0.8} ${b.y + b.h - 22}) rotate(-90)`
                    : undefined
                }
                style={{ fontSize: big ? px * 1.4 : px }}
              >
                {tile.text}
              </text>
            ) : null}
            {px > 0 && big ? (
              <text
                className={`pr-lab f-${sw.ink}`}
                x={b.x + 22}
                y={b.y + 66 + 34}
              >
                TOKENS
              </text>
            ) : null}
          </g>
        );
      })}
    </HeroSvg>
  );
}
