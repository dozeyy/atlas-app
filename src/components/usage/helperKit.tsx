// Small friendly pieces shared by the session pages: a model chip, an avatar for each kind
// of helper, a cost that counts up, a sparkline, a two-part bar. Colors come from the
// tokens only (tokens.css); nothing here invents a value.

import { useEffect, useRef, useState } from "react";
import type { ComponentType } from "react";
import { Compass, Eye, Flask, Lightning, MapTrifold, Robot } from "@phosphor-icons/react";
import type { IconProps } from "@phosphor-icons/react";
import { costView, formatUsd, modelLabel } from "../../lib/usage";
import type { Cost, SessionRow } from "../../lib/types";

// ---- names -------------------------------------------------------------------

/** What to call a session: its name, else where it happened. Never an id. */
export function sessionName(row: Pick<SessionRow, "name" | "projectName">): string {
  return row.name?.trim() || `Session in ${row.projectName}`;
}

// ---- model chips -------------------------------------------------------------

function modelTone(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("opus")) return "bg-accent";
  if (m.includes("sonnet")) return "bg-slate";
  if (m.includes("haiku")) return "bg-success";
  return "bg-ink-2";
}

export function ModelChip({ model, className = "" }: { model: string; className?: string }) {
  return (
    <span
      title={model}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-bg px-2 text-caption text-ink-2 ${className}`}
    >
      <span aria-hidden="true" className={`size-1.5 rounded-full ${modelTone(model)}`} />
      {modelLabel(model)}
    </span>
  );
}

// ---- helper avatars ----------------------------------------------------------

interface Look {
  Icon: ComponentType<IconProps>;
  tone: string;
}

/** An icon and a color per kind of helper, so a row of them reads at a glance. */
export function agentLook(type: string | null): Look {
  const t = (type ?? "").toLowerCase();
  if (/explor|search|research|find/.test(t)) return { Icon: Compass, tone: "bg-raised text-slate" };
  if (/plan|architect/.test(t)) return { Icon: MapTrifold, tone: "bg-warning-tint text-warning" };
  if (/review|audit/.test(t)) return { Icon: Eye, tone: "bg-success-tint text-success" };
  if (/test|verif|qa/.test(t)) return { Icon: Flask, tone: "bg-success-tint text-success" };
  if (/general|code|build|dev/.test(t)) return { Icon: Lightning, tone: "bg-accent-tint text-accent-text" };
  return { Icon: Robot, tone: "bg-raised text-ink-2" };
}

export function AgentAvatar({ type, size = 40 }: { type: string | null; size?: number }) {
  const { Icon, tone } = agentLook(type);
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={`flex shrink-0 items-center justify-center rounded-card ${tone}`}
    >
      <Icon size={Math.round(size * 0.55)} weight="duotone" />
    </span>
  );
}

// ---- a number that counts up ---------------------------------------------------

function reducedMotion(): boolean {
  if (import.meta.env.MODE === "test") return true;
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return true;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Eases the shown number toward `target` (from 0 on first show, from where it was after). */
export function useCountUp(target: number, ms = 700): { value: number; running: boolean } {
  const [shown, setShown] = useState(() => (reducedMotion() ? target : 0));
  const from = useRef(shown);
  useEffect(() => {
    if (reducedMotion() || from.current === target) {
      from.current = target;
      setShown(target);
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - p) ** 3;
      const v = origin + (target - origin) * eased;
      from.current = v;
      setShown(v);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return { value: shown, running: shown !== target };
}

/** A cost that ticks up to its figure. Screen readers get the final figure, never the ticks. */
export function CostTicker({ cost, className = "" }: { cost: Cost; className?: string }) {
  const v = costView(cost);
  const { value, running } = useCountUp(cost.usd ?? 0);
  if (v.none) return <span className={`text-ink-2 ${className}`}>{v.text}</span>;
  const final = v.text;
  const live = `${formatUsd(value)}${v.partial ? "+" : ""}`;
  return (
    <span className={`tabular-nums ${className}`} title="An estimate from the price list, not a bill.">
      <span aria-hidden={running || undefined}>{running ? live : final}</span>
      {running && <span className="sr-only">{final}</span>}
      <span className="sr-only">{`, estimated${v.partial ? ", incomplete" : ""}`}</span>
    </span>
  );
}

// ---- sparkline -------------------------------------------------------------------

/** A quiet line with a wash under it. Decorative: the numbers beside it say the same thing. */
export function Sparkline({ values, className = "" }: { values: number[]; className?: string }) {
  const W = 240;
  const H = 56;
  const pad = 3;
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const x = (i: number) => (i / (values.length - 1)) * W;
  const y = (v: number) => H - pad - (v / max) * (H - pad * 2);
  const line = values.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L${W} ${H} L0 ${H} Z`;
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`block w-full ${className}`}>
      <path d={area} fill="var(--accent-tint)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ---- a bar in two parts ----------------------------------------------------------

export interface Part {
  key: string;
  label: string;
  value: number;
  tone: string;
  text: string;
}

/** One horizontal bar split in parts, each named in a legend under it (color is never the only cue). */
export function SplitBar({ parts, label }: { parts: Part[]; label: string }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div>
      <div role="img" aria-label={label} className="flex h-2.5 overflow-hidden rounded-full bg-raised">
        {parts.map((p) => (
          <div
            key={p.key}
            className={`${p.tone} h-full`}
            style={{ width: `${total > 0 ? (Math.max(0, p.value) / total) * 100 : 0}%` }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2 text-caption text-ink-2">
            <span aria-hidden="true" className={`size-2 rounded-full ${p.tone}`} />
            <span>{p.label}</span>
            <span className="tabular-nums text-ink">{p.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
