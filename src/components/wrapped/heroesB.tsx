import { useId, useMemo } from "react";
import { compact, exact } from "../../lib/usage";
import {
  burstLayout,
  chamfer,
  clipText,
  commandBars,
  donutSectors,
  FAN,
  fanFrame,
  fanLayout,
  gaugeFill,
  hourCells,
  initials,
  lollipops,
  OUT,
  podiumLayout,
  sectorPath,
  spikeLayout,
  SWATCH,
} from "../../lib/posterMath";
import type { HeroBox } from "../../lib/posterMath";
import { clamp01 } from "../../lib/wrappedClock";
import { WEEKDAYS } from "../../lib/wrappedModel";
import type { Row, SlideChart } from "../../lib/wrappedModel";
import { fitFigure } from "../../lib/wrappedPoster";
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
  scaleAbout,
  spin,
  star,
  useEl,
  useEls,
} from "./heroKit";

// The other hero graphics: skill, helper, crowd, tool, busiest day, weekday, rhythm, models, type and
// the cover. Same rules as heroesA: drawn once, moved by a tick, flat fills and 8 px outlines.

type Kind<K extends SlideChart["kind"]> = Extract<SlideChart, { kind: K }>;

// ---- skill: a podium ----------------------------------------------------------------------------------

export function SkillHero({ rows, box }: { rows: Row[]; box: HeroBox }) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const shown = rows.slice(0, 5);
  const bars = useMemo(
    () =>
      podiumLayout(
        shown.map((r) => r.value),
        box,
      ),
    [rows, box],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const { els, ref } = useEls();
  useTick((t) => {
    bars.forEach((_, i) => {
      const { p, landed } = at(t, i, bars.length);
      put(els.current[i], enter(ctx.mood, p, landed, 520));
    });
  });
  return (
    <>
      <ol className="sr-only" aria-label={`Top ${shown.length}, ranked`}>
        {shown.map((r) => (
          <li key={r.label}>{`${r.label}: ${exact(r.value)} uses`}</li>
        ))}
      </ol>
      <HeroSvg box={box}>
        {bars.map((b, i) => {
          const r = shown[b.rank - 1];
          const sw = SWATCH[(b.rank - 1) % 3];
          return (
            <g key={b.rank} ref={ref(i)} className="o-b">
              <title>{`${r.label}: ${exact(r.value)} uses`}</title>
              <path
                className={`f-${sw.fill} ln`}
                d={chamfer(b.x, b.y, b.w, b.h, 12)}
              />
              <text
                className="pr-num c-fg"
                x={b.x + b.w / 2}
                y={b.y - 16}
                textAnchor="middle"
                style={{ fontSize: 68 }}
              >
                {b.rank}
              </text>
              <text
                className={`pr-lab f-${sw.ink}`}
                transform={`translate(${b.x + b.w / 2 + 8} ${b.y + b.h - 20}) rotate(-90)`}
              >
                {clipText(r.label, b.chars)}
              </text>
            </g>
          );
        })}
      </HeroSvg>
    </>
  );
}

// ---- helper: lollipops -----------------------------------------------------------------------------------

export function HelperHero({ rows, box }: { rows: Row[]; box: HeroBox }) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const shown = rows.slice(0, 6);
  const lay = useMemo(
    () =>
      lollipops(
        shown.map((r) => r.value),
        box,
      ),
    [rows, box],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const sticks = useEls();
  const heads = useEls();
  useTick((t) => {
    lay.rows.forEach((r, i) => {
      const { p } = at(t, i, lay.rows.length);
      put(sticks.els.current[i], {
        sx: Math.max(0, p),
        sy: 1,
        o: p > 0.003 ? 1 : 0,
      });
      put(heads.els.current[i], { x: r.len * (p - 1), o: p > 0.003 ? 1 : 0 });
    });
  });
  return (
    <HeroSvg box={box}>
      {lay.rows.map((r, i) => {
        const row = shown[i];
        const sw = SWATCH[i % 3];
        return (
          <g key={row.label}>
            <title>{`${row.label}: ${exact(row.value)} uses`}</title>
            <text className="pr-lab c-fg" x={0} y={r.y + 8}>
              {clipText(row.label, 17)}
            </text>
            <rect
              ref={sticks.ref(i)}
              className="f-fg o-l"
              x={lay.x0}
              y={r.y - 7}
              width={r.len}
              height={14}
            />
            <g ref={heads.ref(i)}>
              <circle
                className={`f-${sw.fill} ln`}
                cx={lay.x0 + r.len}
                cy={r.y}
                r={25}
              />
              <text className="pr-lab c-fg" x={lay.x0 + r.len + 42} y={r.y + 8}>
                {compact(row.value)}
              </text>
            </g>
          </g>
        );
      })}
    </HeroSvg>
  );
}

// ---- crowd: a burst ---------------------------------------------------------------------------------------------

export function CrowdHero({
  chart,
  box,
}: {
  chart: Kind<"burst">;
  box: HeroBox;
}) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const cx = box.w / 2;
  const cy = (box.ceil + box.floor) / 2 - 10;
  const r2 = Math.min(box.w / 2 - 26, (box.floor - box.ceil) / 2 - 40, 250);
  const { shown, sats } = useMemo(
    () => burstLayout(chart.count, cx, cy, r2 * 0.58, r2),
    [chart.count, cx, cy, r2],
  );
  const { els, ref } = useEls();
  const core = useEl();
  const ring = useEl();
  const chip = useEl();
  const more = chart.count - shown;
  useTick((t) => {
    const c = at(t, 0, 1);
    put(core.el.current, pop(ctx.mood, c.p, c.landed));
    sats.forEach((s, i) => {
      const { p } = at(t, i, sats.length);
      scaleAbout(els.current[i], p, cx, cy);
      fade(els.current[i], p > 0.003 ? 1 : 0);
      void s;
    });
    ripple(ring.el.current, ctx, t);
    fade(chip.el.current, after(at(t, sats.length - 1, sats.length).p, 0.9));
  });
  return (
    <HeroSvg box={box}>
      <circle
        ref={ring.ref}
        className="s-fg f-none o-c"
        cx={cx}
        cy={cy}
        r={84}
        strokeWidth={OUT}
      />
      {sats.map((s, i) => {
        const sw = SWATCH[(s.ring ? i : i + 1) % 4];
        return (
          <g key={i} ref={ref(i)}>
            <line
              className="s-fg"
              x1={cx}
              y1={cy}
              x2={s.x}
              y2={s.y}
              strokeWidth={6}
            />
            <circle className={`f-${sw.fill} ln`} cx={s.x} cy={s.y} r={s.r} />
          </g>
        );
      })}
      <g ref={core.ref} className="o-c">
        <circle className="f-acc ln" cx={cx} cy={cy} r={76} />
        <path className="f-on-acc" d={star(cx, cy, 44)} />
      </g>
      {more > 0 ? (
        <g ref={chip.ref}>
          <path
            className="f-sbg ln"
            d={chamfer(cx - 110, box.floor - 40, 220, 40, 8)}
          />
          <text
            className="pr-lab f-sfg"
            x={cx}
            y={box.floor - 12}
            textAnchor="middle"
          >
            {`+${exact(more)} more`}
          </text>
        </g>
      ) : null}
    </HeroSvg>
  );
}

// ---- tool: a terminal -----------------------------------------------------------------------------------------------

const GLYPH_INK = 0.18;

export function ToolHero({ rows, box }: { rows: Row[]; box: HeroBox }) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const shown = rows.slice(0, 5);
  const { bars } = useMemo(
    () =>
      commandBars(
        shown.map((r) => r.value),
        box,
      ),
    [rows, box],
  ); // eslint-disable-line react-hooks/exhaustive-deps
  const { els, ref } = useEls();
  const glyph = useEl();
  const gx = box.side === "l" ? -150 : box.w - 190;
  useTick((t) => {
    bars.forEach((_, i) => {
      const { p, landed } = at(t, i, bars.length);
      put(els.current[i], enter(ctx.mood, p, landed, 420));
    });
    // The prompt glyph is the card's own ink at 18%: it reads on a dark or a light card alike.
    fade(glyph.el.current, beatValue(ctx, "hero", t) * GLYPH_INK);
  });
  return (
    <HeroSvg box={box}>
      <text
        ref={glyph.ref}
        className="pr-num"
        data-deco=""
        aria-hidden="true"
        x={gx}
        y={box.floor + 90}
        style={{ fontSize: 720 }}
      >
        $
      </text>
      {bars.map((b, i) => {
        const r = shown[i];
        const sw = SWATCH[i % 4];
        return (
          <g key={r.label} ref={ref(i)} className="o-b">
            <title>{`${r.label}: ${exact(r.value)} runs`}</title>
            <path
              className={`f-${sw.fill} ln`}
              d={chamfer(0, b.y, b.len, b.h, 10)}
            />
            <text
              className={`pr-code f-${sw.ink}`}
              x={22}
              y={b.y + b.h / 2 + 9}
            >
              {`$ ${clipText(r.label, b.chars)}`}
            </text>
            <text
              className={`pr-code f-${sw.ink}`}
              x={b.len - 22}
              y={b.y + b.h / 2 + 9}
              textAnchor="end"
            >
              {exact(r.value)}
            </text>
          </g>
        );
      })}
    </HeroSvg>
  );
}

// ---- busiest day: spikes ----------------------------------------------------------------------------------------------

const GROUND = 40;

export function BusiestHero({
  chart,
  box,
}: {
  chart: Kind<"spike">;
  box: HeroBox;
}) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const top = useMemo(() => ({ ...box, floor: box.floor - GROUND }), [box]);
  const spikes = useMemo(
    () => spikeLayout(chart.values, chart.peak, top),
    [chart, top],
  );
  const { els, ref } = useEls();
  const ring = useEl();
  const peak = spikes[chart.peak] ?? spikes[0];
  useTick((t) => {
    spikes.forEach((_, i) => {
      const { p, landed } = at(t, i, spikes.length);
      put(els.current[i], enter(ctx.mood, p, landed));
    });
    ripple(ring.el.current, ctx, t);
  });
  return (
    <HeroSvg box={box}>
      {spikes.map((s, i) => {
        const x0 = s.x + 3;
        const x1 = s.x + s.w - 3;
        const y = top.floor;
        return (
          <path
            key={i}
            ref={ref(i)}
            className={`${s.peak ? "f-acc" : "f-fg"} ln o-b`}
            d={`M${x0} ${y}L${(x0 + x1) / 2} ${y - s.h}L${x1} ${y}Z`}
            strokeLinejoin="miter"
          />
        );
      })}
      <circle
        ref={ring.ref}
        className="s-fg f-none o-c"
        cx={peak.x + peak.w / 2}
        cy={top.floor - peak.h + 8}
        r={30}
        strokeWidth={OUT}
      />
      <rect
        className="f-sbg"
        x={0}
        y={top.floor}
        width={box.w}
        height={GROUND}
      />
      <text className="pr-lab f-sfg" x={20} y={top.floor + 27}>
        {chart.first}
      </text>
      <text
        className="pr-lab f-sfg"
        x={box.w - 20}
        y={top.floor + 27}
        textAnchor="end"
      >
        {chart.last}
      </text>
    </HeroSvg>
  );
}

// ---- weekday: the half dial ------------------------------------------------------------------------------------------------

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

export function WeekdayHero({
  chart,
  box,
}: {
  chart: Kind<"spokes">;
  box: HeroBox;
}) {
  const ctx = useClockCtx();
  const id = useId().replace(/:/g, "");
  const hx = box.side === "r" ? box.w - 300 : 300;
  const hy = box.floor - 6;
  const spokes = useMemo(
    () => fanLayout(chart.values, hx, hy),
    [chart.values, hx, hy],
  );
  const topDay = spokes.find((s) => s.top) ?? spokes[0];
  const name = WEEKDAYS[topDay.day] ?? "";
  const ghost = useMemo(() => fitFigure(name, box.w - 40, 190), [name, box.w]);
  const spokeEls = useEls();
  const hand = useEl();
  const labels = useEl();
  const ghostEl = useEl();
  useTick((t) => {
    // The hand and every spoke read the same eased p, so a spoke is as long as the hand has made it.
    const p = beatValue(ctx, "hand", t);
    const f = fanFrame(spokes, p);
    spin(hand.el.current, -f.hand, hx, hy);
    f.grow.forEach((g, i) => scaleAbout(spokeEls.els.current[i], g, hx, hy));
    fade(labels.el.current, clamp01((p - 0.1) / 0.4));
    fade(ghostEl.el.current, clamp01(p / 0.5));
  });
  const reach = FAN.R + FAN.over;
  return (
    <HeroSvg box={box}>
      <defs>
        <clipPath id={`${id}-clip`}>
          <rect x={-box.ox} y={0} width={box.fullW} height={box.h} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-clip)`}>
        <circle
          className="f-tint"
          cx={hx + (box.side === "r" ? 480 : -480)}
          cy={hy}
          r={763}
        />
      </g>
      <text
        ref={ghostEl.ref}
        className="pr-num f-ghost"
        x={box.side === "r" ? 12 : box.w - 12}
        y={box.floor - 12}
        textAnchor={box.side === "r" ? "start" : "end"}
        style={{ fontSize: ghost.size }}
      >
        {name.toUpperCase()}
      </text>
      <path
        className="f-bg ln"
        d={`M${hx - FAN.R} ${hy}A${FAN.R} ${FAN.R} 0 0 1 ${hx + FAN.R} ${hy}Z`}
      />
      {spokes.map((s, i) => (
        <path
          key={s.day}
          ref={spokeEls.ref(i)}
          className={`${s.top ? "f-acc" : "f-fg"} ln`}
          d={`M${s.poly.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("L")}Z`}
          strokeLinejoin="miter"
        >
          <title>{`${WEEKDAYS[s.day]}`}</title>
        </path>
      ))}
      <g ref={hand.ref}>
        <line
          className="s-dark"
          x1={hx}
          y1={hy}
          x2={hx + reach}
          y2={hy}
          strokeWidth={12}
        />
      </g>
      <path
        className="f-dark"
        d={`M${hx - FAN.hub} ${hy}A${FAN.hub} ${FAN.hub} 0 0 1 ${hx + FAN.hub} ${hy}Z`}
      />
      <rect
        className="f-dark"
        x={hx - reach - 10}
        y={hy}
        width={reach * 2 + 20}
        height={12}
      />
      <g ref={labels.ref}>
        {spokes.map((s) => (
          <text
            key={s.day}
            className="pr-lab c-fg"
            x={s.label.x}
            y={s.label.y + 9}
            textAnchor="middle"
            style={s.top ? { fontSize: 30 } : undefined}
          >
            {DAY_LETTERS[s.day]}
          </text>
        ))}
      </g>
    </HeroSvg>
  );
}

// ---- rhythm: the day's 24 hours ------------------------------------------------------------------------------------------------

const HOUR_MARKS: [number, string][] = [
  [0, "12A"],
  [6, "6A"],
  [12, "12P"],
  [18, "6P"],
];

export function RhythmHero({
  chart,
  box,
}: {
  chart: Kind<"strip">;
  box: HeroBox;
}) {
  const ctx = useClockCtx();
  const top = useMemo(() => ({ ...box, floor: box.floor - GROUND }), [box]);
  const { cells, cw } = useMemo(
    () => hourCells(chart.values, box.w),
    [chart.values, box.w],
  );
  const { els, ref } = useEls();
  const scan = useEl();
  const room = top.floor - top.ceil;
  useTick((t) => {
    const s = beatValue(ctx, "hand", t);
    cells.forEach((_, k) => {
      const g = clamp01(s * 24 - k);
      put(els.current[k], { sy: g, o: g > 0.003 ? 1 : 0 });
    });
    put(scan.el.current, { x: s * 24 * cw, o: s > 0 && s < 1 ? 1 : 0 });
  });
  return (
    <HeroSvg box={box}>
      {cells.map((c, k) => {
        const h = Math.min(room, 56 + c.band * 44 + (c.peak ? 30 : 0));
        return (
          <path
            key={c.hour}
            ref={ref(k)}
            className={`${c.peak ? "f-acc ln" : `hb${c.band}`} o-b`}
            d={chamfer(c.x + 3, top.floor - h, cw - 6, h, 6)}
          >
            <title>{`${c.hour}:00`}</title>
          </path>
        );
      })}
      <rect
        ref={scan.ref}
        className="f-fg"
        x={cells[0].x - 5}
        y={top.ceil}
        width={10}
        height={room}
      />
      <rect
        className="f-sbg"
        x={0}
        y={top.floor}
        width={box.w}
        height={GROUND}
      />
      {HOUR_MARKS.map(([h, label]) => (
        <text
          key={h}
          className="pr-lab f-sfg"
          x={cells[h].x + 3}
          y={top.floor + 27}
        >
          {label}
        </text>
      ))}
    </HeroSvg>
  );
}

// ---- models: a ring ------------------------------------------------------------------------------------------------------------------------

export function ModelsHero({ rows, box }: { rows: Row[]; box: HeroBox }) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const secs = useMemo(
    () =>
      donutSectors(
        rows.map((r) => r.value),
        4,
      ),
    [rows],
  );
  const R = Math.min(box.w / 2 - 26, 200);
  const cx = box.w / 2;
  const cy = box.ceil + R + 8;
  const { els, ref } = useEls();
  useTick((t) => {
    secs.forEach((_, i) => {
      const { p } = at(t, i, secs.length);
      scaleAbout(els.current[i], p, cx, cy);
      fade(els.current[i], p > 0.003 ? 1 : 0);
    });
  });
  const legendY = cy + R + 40;
  return (
    <HeroSvg box={box}>
      {secs.map((s, i) => {
        const row = rows[i];
        const rest = i >= 4;
        const sw = rest ? SWATCH[4] : SWATCH[i];
        return (
          <path
            key={i}
            ref={ref(i)}
            className={`f-${sw.fill} ln`}
            d={sectorPath(cx, cy, R * 0.48, R, s.from, s.to)}
            strokeLinejoin="miter"
          >
            <title>{`${rest ? "Other models" : row.label}: ${Math.round(s.share * 100)}%`}</title>
          </path>
        );
      })}
      {secs.map((s, i) => {
        const rest = i >= 4;
        const sw = rest ? SWATCH[4] : SWATCH[i];
        const y = legendY + i * 36;
        if (y > box.floor) return null;
        return (
          <g key={`l${i}`}>
            <rect
              className={`f-${sw.fill} ln`}
              x={24}
              y={y - 18}
              width={26}
              height={26}
            />
            <text className="pr-lab c-fg" x={66} y={y + 3}>
              {`${clipText(rest ? "Other" : rows[i].label, 20)}  ${Math.round(s.share * 100)}%`}
            </text>
          </g>
        );
      })}
    </HeroSvg>
  );
}

// ---- type: the badge ---------------------------------------------------------------------------------------------------------------------------

export function TypeHero({
  chart,
  box,
}: {
  chart: Kind<"badge">;
  box: HeroBox;
}) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const rows = chart.traits.slice(0, 3);
  const n = rows.length + 1;
  const { els, ref } = useEls();
  const cy = (box.ceil + box.floor) / 2;
  const trackX = 520;
  const trackW = Math.max(200, box.w - trackX - 80);
  const pitch = Math.min(50, (box.floor - box.ceil) / 3);
  useTick((t) => {
    const e = at(t, 0, n);
    put(els.current[0], pop(ctx.mood, e.p, e.landed));
    rows.forEach((r, i) => {
      const { p } = at(t, i + 1, n);
      put(els.current[i + 1], {
        sx: Math.max(0, p) * gaugeFill(r.score),
        sy: 1,
        o: p > 0.003 ? 1 : 0,
      });
    });
  });
  const hex = Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k - Math.PI / 6;
    return `${(150 + Math.cos(a) * 92).toFixed(1)} ${(cy + Math.sin(a) * 92).toFixed(1)}`;
  }).join("L");
  return (
    <HeroSvg box={box}>
      <g ref={ref(0)} className="o-c">
        <path className="f-acc ln" d={`M${hex}Z`} strokeLinejoin="miter" />
        <text
          className="pr-num f-on-acc"
          x={150}
          y={cy + 30}
          textAnchor="middle"
          style={{ fontSize: 88 }}
        >
          {initials(chart.name)}
        </text>
      </g>
      {rows.map((r, i) => {
        const y = cy + (i - 1) * pitch;
        return (
          <g key={r.name}>
            <title>{`${r.name}: ${r.note}`}</title>
            <text className="pr-lab c-fg" x={270} y={y + 8}>
              {clipText(r.name, 16)}
            </text>
            <rect
              className="f-tint ln"
              x={trackX}
              y={y - 15}
              width={trackW}
              height={30}
            />
            <rect
              ref={ref(i + 1)}
              className={`f-${SWATCH[i % 3].fill} o-l`}
              x={trackX}
              y={y - 15}
              width={trackW}
              height={30}
            />
          </g>
        );
      })}
    </HeroSvg>
  );
}

// ---- cover: a collage ---------------------------------------------------------------------------------------------------------------------------------

export function CoverHero({ box }: { box: HeroBox }) {
  const ctx = useClockCtx();
  const at = useMemo(() => pieces(ctx), [ctx]);
  const { els, ref } = useEls();
  const cy = (box.ceil + box.floor) / 2;
  const w = box.w;
  const n = 5;
  useTick((t) => {
    for (let i = 0; i < n; i++) {
      const { p, landed } = at(t, i, n);
      put(els.current[i], pop(ctx.mood, p, landed));
    }
  });
  const tall = box.floor - box.ceil;
  const u = Math.min(tall / 2, 96);
  return (
    <HeroSvg box={box}>
      <circle
        ref={ref(0)}
        className="f-acc ln o-c"
        cx={w * 0.14}
        cy={cy}
        r={u}
      />
      <g ref={ref(1)} className="o-b">
        {[0, 1, 2].map((k) => (
          <path
            key={k}
            className={`f-${SWATCH[(k + 1) % 4].fill} ln`}
            d={chamfer(
              w * 0.27,
              cy - u + k * (u * 0.7),
              u * 1.9 - k * 14,
              u * 0.62,
              8,
            )}
          />
        ))}
      </g>
      <path
        ref={ref(2)}
        className="f-fg ln o-c"
        d={star(w * 0.5, cy, u * 1.05)}
      />
      <path
        ref={ref(3)}
        className="f-alt ln o-b"
        d={`M${w * 0.62} ${cy + u}A${u} ${u} 0 0 1 ${w * 0.62 + u * 2} ${cy + u}Z`}
      />
      <path
        ref={ref(4)}
        className="f-sbg ln o-c"
        d={chamfer(w * 0.84, cy - u * 0.9, u * 1.8, u * 1.8, 20)}
      />
    </HeroSvg>
  );
}
