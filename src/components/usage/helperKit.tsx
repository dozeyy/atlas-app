// Small friendly pieces shared by the session pages: a name for a session, a model chip, an
// avatar for each kind of helper, a cost that counts up. Colors come from the tokens only
// (tokens.css); nothing here invents a value.

import type { ComponentType } from "react";
import { Broom, Bug, ChatCircleText, Compass, Eye, Flask, Gauge, Hammer, HeadCircuit, MapTrifold, Palette, PencilLine, RocketLaunch, Shapes } from "@phosphor-icons/react";
import type { IconProps } from "@phosphor-icons/react";
import { CountUp } from "../CountUp";
import { compact, costView, formatUsd, modelLabel, modelWithEffort, tokenHint } from "../../lib/usage";
import type { Cost, Outcome, SessionRow } from "../../lib/types";

// ---- names -------------------------------------------------------------------

/** What to call a session: its name, else where it happened. Never an id. */
export function sessionName(row: Pick<SessionRow, "name" | "projectName">): string {
  return row.name?.trim() || `Session in ${row.projectName}`;
}

// The name rules are plain text and live in src/lib (model code uses them without loading React);
// they are handed on from here so every page keeps one import.
export { helperName, shownName } from "../../lib/helperName";

// ---- model chips -------------------------------------------------------------

/** Which chart colour a model family wears: the same dot on the Dashboard, Sessions and here. */
export function modelTone(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("opus")) return 1;
  if (m.includes("sonnet")) return 2;
  if (m.includes("haiku")) return 3;
  return 4;
}

/**
 * "Opus 5.5 · high + Haiku 5.5": the models a session used under their full names (never a
 * family alone), each with its colour dot, on one quiet inline run. `effort` goes on `main`.
 */
export function ModelDots({ models, main, effort, hint }: { models: string[]; main?: string; effort?: string | null; /** The hover, when it says more than the ids. */ hint?: string }) {
  // A dated and an undated id of one model are one entry.
  const seen = new Map<string, string>();
  for (const m of models) if (!seen.has(modelLabel(m))) seen.set(modelLabel(m), m);
  const mainName = main ? modelLabel(main) : null;
  const list = [...seen].map(([name, id]) => [name === mainName ? modelWithEffort(id, effort) : name, id] as const);
  return (
    <span title={hint ?? models.join(" + ")} className="whitespace-nowrap">
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

export function ModelChip({ model, effort, className = "" }: { model: string; effort?: string | null; className?: string }) {
  return (
    <span
      title={effort ? `${model}, reasoning effort ${effort}` : model}
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-bg px-2 text-caption text-ink-2 ${className}`}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: `var(--chart-${modelTone(model)})` }} />
      {modelWithEffort(model, effort)}
    </span>
  );
}

// ---- helper avatars ----------------------------------------------------------

// One icon per kind of work, so a row of helpers tells its kinds apart by shape first and colour
// second. The list, the map, the helper's own page and Now all draw the same avatar.

/** The kinds of work a helper does. Every helper type lands on exactly one. */
export type HelperKind =
  | "explore"
  | "plan"
  | "review"
  | "test"
  | "build"
  | "design"
  | "debug"
  | "docs"
  | "ops"
  | "chore"
  | "perf"
  | "general"
  | "other";

export interface Look {
  Icon: ComponentType<IconProps>;
  /** Tailwind classes for an HTML avatar: the tile's fill and the icon's colour. */
  tone: string;
  /** What the icon stands for, in a word: the legend's text. */
  label: string;
  kind: HelperKind;
  /** The same two colours as CSS values, for drawing the avatar in SVG (the helper map). */
  fg: string;
  bg: string;
}

const TONES = {
  clay: { tone: "bg-accent-tint text-accent-text", fg: "var(--accent-text)", bg: "var(--accent-tint)" },
  slate: { tone: "bg-raised text-slate", fg: "var(--slate)", bg: "var(--raised)" },
  amber: { tone: "bg-warning-tint text-warning", fg: "var(--warning)", bg: "var(--warning-tint)" },
  green: { tone: "bg-success-tint text-success", fg: "var(--success)", bg: "var(--success-tint)" },
  blue: { tone: "bg-info-tint text-info", fg: "var(--info)", bg: "var(--info-tint)" },
  plain: { tone: "bg-raised text-ink-2", fg: "var(--ink-2)", bg: "var(--raised)" },
} as const;

/**
 * Each kind's icon, colour and name. Thirteen kinds, thirteen different icons, and none is an icon
 * the Toolkit already uses for a kind of setup item (the lightning bolt is Skills, the robot is
 * Agents, the paint brush is Themes) or the one the Library uses for what it installs (the package).
 * A test holds both.
 */
const KINDS: Record<HelperKind, { Icon: ComponentType<IconProps>; label: string; tone: keyof typeof TONES }> = {
  explore: { Icon: Compass, label: "Explore", tone: "slate" },
  plan: { Icon: MapTrifold, label: "Plan", tone: "amber" },
  review: { Icon: Eye, label: "Review", tone: "green" },
  test: { Icon: Flask, label: "Test", tone: "blue" },
  build: { Icon: Hammer, label: "Build", tone: "clay" },
  design: { Icon: Palette, label: "Design", tone: "blue" },
  debug: { Icon: Bug, label: "Debug", tone: "amber" },
  docs: { Icon: PencilLine, label: "Writing", tone: "slate" },
  ops: { Icon: RocketLaunch, label: "Release", tone: "green" },
  chore: { Icon: Broom, label: "Chores", tone: "plain" },
  perf: { Icon: Gauge, label: "Speed", tone: "blue" },
  general: { Icon: Shapes, label: "General", tone: "clay" },
  other: { Icon: HeadCircuit, label: "Other", tone: "plain" },
};

/** The kinds in the order a legend lists them. */
export const HELPER_KINDS = Object.keys(KINDS) as HelperKind[];

/**
 * Which kind a helper type is, from the words in its name. Order matters: the more telling word
 * wins, so "code-reviewer" reviews (it does not build), "ui-builder" designs, "crash-investigator"
 * debugs, "verify-auditor" tests and "spec-writer" plans. Only a name with none of these words is
 * "other".
 *
 * A short word is matched as a word, never as letters inside a longer one: "spec" is not in
 * "specialist", "doc" not in "docker", "port" not in "support" or "report", "format" not in
 * "information", "plan" not in "explanation", "test" not in "latest". (`\b` sits at a hyphen, so a
 * word inside "a-b-c" still counts as a word.)
 */
const RULES: [RegExp, HelperKind][] = [
  [/bug|crash|debug|diagnos|troubleshoot|\bhunt|investigat/, "debug"],
  [/\bperf(ormance)?\b|profil(er|ing)|optimi[sz]|benchmark/, "perf"],
  [/\btest|pytest|unittest|verif|\bqa\b|\bvalidat/, "test"],
  [/review|audit|\bcriti(c|que)/, "review"],
  [/explor|search|research|\bfind|\bfetch|lookup|look-up|\bscout|\brecon\b/, "explore"],
  [/\bspec(s|ification\w*)?\b/, "plan"],
  [/\bdoc(s|ument\w*)?\b|writ|\bguide|changelog|readme|\breport/, "docs"],
  [/\bplan(s|ner|ning)?\b|architect|\badvis|strateg/, "plan"],
  [/releas|deploy|packag|publish|\b(dev-?)?ops\b|\binfra/, "ops"],
  [/design|\bui\b|\bux\b|\bstyl|\bbrand|\bassets?\b|visual|frontend/, "design"],
  [/\bchores?\b|mechanic|clean-?up|\btidy|\bformat|\blint|\brenam|housekeep/, "chore"],
  [/\bgeneral/, "general"],
  [/\bcod(e|er|ing)\b|build|\bdev(s|elop\w*)?\b|engineer|implement|refactor|\bprogram|\bmod(s|der|ding)?\b|\bport(s|er|ing)?\b/, "build"],
];

export function helperKind(type: string | null): HelperKind {
  const t = (type ?? "").toLowerCase();
  for (const [re, kind] of RULES) if (re.test(t)) return kind;
  return "other";
}

/** A kind's icon, colours and name. */
export function kindLook(kind: HelperKind): Look {
  const k = KINDS[kind];
  return { Icon: k.Icon, label: k.label, kind, ...TONES[k.tone] };
}

/** An icon and a color per kind of helper, so a row of them reads at a glance. The list and the map both use it. */
export function agentLook(type: string | null): Look {
  return kindLook(helperKind(type));
}

/** Where a thread sits in the chat: the chat itself, a helper it started, or a helper started by another helper. */
export type AvatarLevel = "main" | "helper" | "nested";

/** What an avatar says when pointed at or read out: "Review helper", "Main chat". */
export function avatarName(type: string | null, level: AvatarLevel = "helper"): string {
  if (level === "main") return "Main chat";
  const { kind, label } = agentLook(type);
  const name = kind === "other" ? "Helper" : `${label} helper`;
  return level === "nested" ? `${name}, started by another helper` : name;
}

/** The icon inside an avatar sits on the 16 / 20 / 24 grid. */
export function avatarIconSize(size: number): number {
  return size >= 40 ? 24 : size >= 32 ? 20 : 16;
}

/** The main chat's icon, wherever it stands beside helpers. */
export const MainChatIcon = ChatCircleText;

/**
 * A helper's face. The icon is its kind of work; the shape is where it sits: the main chat is a
 * solid clay circle, a helper a tinted tile, a helper started by another helper the same tile
 * hollow. It names itself in its hover and to a screen reader unless `quiet` (when the same words
 * already stand beside it).
 */
export function AgentAvatar({
  type,
  size = 40,
  level = "helper",
  quiet = false,
}: {
  type: string | null;
  size?: number;
  level?: AvatarLevel;
  quiet?: boolean;
}) {
  const { Icon, tone } = agentLook(type);
  const name = avatarName(type, level);
  const Glyph = level === "main" ? MainChatIcon : Icon;
  // Hollow means no fill at all: the colour class stays, the background class goes (a utility
  // would win over .helper-av.nested, and the list would not match the map).
  const paint = level === "main" ? "bg-accent text-on-accent" : level === "nested" ? `${tone.replace(/\bbg-\S+\s*/g, "")} nested` : tone;
  return (
    <span
      {...(quiet ? { "aria-hidden": true } : { role: "img", "aria-label": name, title: name })}
      style={{ width: size, height: size, borderRadius: level === "main" ? "50%" : Math.round(size * 0.3) }}
      className={`helper-av flex shrink-0 items-center justify-center ${paint}`}
    >
      <Glyph size={avatarIconSize(size)} weight="duotone" />
    </span>
  );
}

// ---- how a helper ended --------------------------------------------------------

/** The word and the colour for how a helper ended. The list, the map and the slice share them. */
export const OUTCOMES: Record<Outcome, { label: string; color: string }> = {
  finished: { label: "Finished", color: "var(--success)" },
  errored: { label: "Errored", color: "var(--danger)" },
  stopped: { label: "Stopped", color: "var(--warning)" },
};

/** A dot and a word: how a helper ended. Never the colour alone. */
export function OutcomeMark({ outcome }: { outcome: Outcome }) {
  const o = OUTCOMES[outcome];
  return (
    <span className="inline-flex flex-none items-baseline gap-1.5 whitespace-nowrap">
      <i aria-hidden="true" className="size-2 shrink-0 self-center rounded-full" style={{ background: o.color }} />
      {o.label}
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
