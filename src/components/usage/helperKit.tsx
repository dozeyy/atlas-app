// Small friendly pieces shared by the session pages: a name for a session, a model chip, an
// avatar for each kind of helper, a cost that counts up. Colors come from the tokens only
// (tokens.css); nothing here invents a value.

import type { ComponentType } from "react";
import { Compass, Eye, Flask, Lightning, MapTrifold, Robot } from "@phosphor-icons/react";
import type { IconProps } from "@phosphor-icons/react";
import { CountUp } from "../CountUp";
import { compact, costView, formatUsd, modelLabel, tokenHint } from "../../lib/usage";
import type { Cost, SessionRow } from "../../lib/types";

// ---- names -------------------------------------------------------------------

/** What to call a session: its name, else where it happened. Never an id. */
export function sessionName(row: Pick<SessionRow, "name" | "projectName">): string {
  return row.name?.trim() || `Session in ${row.projectName}`;
}

// ---- model chips -------------------------------------------------------------

/** Which chart colour a model family wears: the same dot on the Dashboard, Sessions and here. */
export function modelTone(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus")) return 1;
  if (m.includes("sonnet")) return 2;
  if (m.includes("haiku")) return 3;
  return 4;
}

/** "Sonnet + Haiku": the families a session used, each with its colour dot, on one quiet inline run. */
export function ModelDots({ models }: { models: string[] }) {
  const seen = new Map<string, string>();
  for (const m of models) {
    const family = modelLabel(m).split(" ")[0] ?? m;
    if (!seen.has(family)) seen.set(family, m);
  }
  const list = [...seen];
  return (
    <span title={models.map(modelLabel).join(" + ")} className="whitespace-nowrap">
      {list.map(([family, id], i) => (
        <span key={family}>
          {i > 0 && " + "}
          <span
            aria-hidden="true"
            className="mr-1 inline-block size-1.5 rounded-full align-middle"
            style={{ background: `var(--chart-${modelTone(id)})` }}
          />
          {family}
        </span>
      ))}
    </span>
  );
}

export function ModelChip({ model, className = "" }: { model: string; className?: string }) {
  return (
    <span
      title={model}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-bg px-2 text-caption text-ink-2 ${className}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: `var(--chart-${modelTone(model)})` }} />
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

// ---- a token figure that counts up --------------------------------------------

/**
 * A token figure that counts up the first time `id` shows in a launch (Will, 2026-11-08:
 * tokens everywhere, money on hover). The hover holds the exact count and the API-price
 * estimate; screen readers get the final figure and the estimate as words, never the ticks.
 */
export function TokenFigure({ tokens, cost, id, note, className = "" }: { tokens: number; cost: Cost; id: string; note?: string; className?: string }) {
  const v = costView(cost);
  return (
    <span className="tabular-nums" title={note ? `${tokenHint(tokens, cost)}\n${note}` : tokenHint(tokens, cost)}>
      <CountUp value={tokens} id={id} format={(n) => `${compact(Math.round(n))} tokens`} className={className} />
      {!v.none && <span className="sr-only">{`, about ${formatUsd(cost.usd ?? 0)} at API prices, estimated${v.partial ? ", incomplete" : ""}`}</span>}
    </span>
  );
}
