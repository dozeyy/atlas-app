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
 * "Opus 5.5, high effort + Haiku 5.5": the models a session used under their full names (never a
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

// One icon per kind of work, on a tile whose shape and tint say which family of work it is. The
// tints are the four chart colours and nothing else; the glyph is ink, so it reads at 20 px.
// The list, the map, the helper's own page and Now all draw the same avatar.

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

/** A tile's outline: every family of work has its own, so the shape tells it before the glyph does. */
export type TileShape = "tile" | "arch" | "shield" | "leaf";

export interface Look {
  Icon: ComponentType<IconProps>;
  /** Tailwind classes for an HTML avatar: the tile's tint and the glyph's colour. */
  tone: string;
  /** What the icon stands for, in a word: the legend's text. */
  label: string;
  kind: HelperKind;
  /** The tile's outline. */
  shape: TileShape;
  /** The same colours as CSS values, for drawing the avatar in SVG (the helper map): the family's
      chart colour (outlines), the tile's tint, and the glyph. */
  fg: string;
  bg: string;
  ink: string;
}

/**
 * The four families of work. Each has one chart colour and one tile shape, so the two say the same
 * thing and neither is needed alone:
 *   make   clay, a rounded square     builds, designs, writes
 *   look   slate, an arch             explores, plans, reviews
 *   check  sand, a shield             tests, debugs, measures
 *   run    neutral, a leaf            releases, tidies, everything else
 * The tint is 30% of the chart colour: strong enough to tell the four apart under an ink glyph.
 */
const tint = (n: number) => `color-mix(in srgb, var(--chart-${n}) 30%, transparent)`;
const FAMILIES = {
  make: { tone: "bg-chart-1/30 text-ink", fg: "var(--chart-1)", bg: tint(1), ink: "var(--ink)", shape: "tile" },
  look: { tone: "bg-chart-2/30 text-ink", fg: "var(--chart-2)", bg: tint(2), ink: "var(--ink)", shape: "arch" },
  check: { tone: "bg-chart-3/30 text-ink", fg: "var(--chart-3)", bg: tint(3), ink: "var(--ink)", shape: "shield" },
  run: { tone: "bg-chart-4/30 text-ink", fg: "var(--chart-4)", bg: tint(4), ink: "var(--ink)", shape: "leaf" },
} as const satisfies Record<string, { tone: string; fg: string; bg: string; ink: string; shape: TileShape }>;

/**
 * Each kind's icon, family and name. Thirteen kinds, thirteen different icons, and none is an icon
 * the Toolkit already uses for a kind of setup item (the lightning bolt is Skills, the robot is
 * Agents, the paint brush is Themes) or the one the Library uses for what it installs (the package).
 * A test holds both.
 */
const KINDS: Record<HelperKind, { Icon: ComponentType<IconProps>; label: string; family: keyof typeof FAMILIES }> = {
  explore: { Icon: Compass, label: "Explore", family: "look" },
  plan: { Icon: MapTrifold, label: "Plan", family: "look" },
  review: { Icon: Eye, label: "Review", family: "look" },
  test: { Icon: Flask, label: "Test", family: "check" },
  build: { Icon: Hammer, label: "Build", family: "make" },
  design: { Icon: Palette, label: "Design", family: "make" },
  debug: { Icon: Bug, label: "Debug", family: "check" },
  docs: { Icon: PencilLine, label: "Writing", family: "make" },
  ops: { Icon: RocketLaunch, label: "Release", family: "run" },
  chore: { Icon: Broom, label: "Chores", family: "run" },
  perf: { Icon: Gauge, label: "Speed", family: "check" },
  general: { Icon: Shapes, label: "General", family: "run" },
  other: { Icon: HeadCircuit, label: "Other", family: "run" },
};

/** Each shape's corners as a share of the tile's side: top-left, top-right, bottom-right, bottom-left. */
const CORNERS: Record<TileShape, [number, number, number, number]> = {
  tile: [0.3, 0.3, 0.3, 0.3],
  arch: [0.5, 0.5, 0.18, 0.18],
  shield: [0.18, 0.18, 0.5, 0.5],
  leaf: [0.5, 0.18, 0.5, 0.18],
};

/** A tile's four corner radii in px, clockwise from the top left. `grow` widens it for a ring around it. */
export function tileCorners(shape: TileShape, side: number, grow = 0): [number, number, number, number] {
  const half = side / 2 + grow;
  return CORNERS[shape].map((f) => Math.min(half, Math.round(side * f) + grow)) as [number, number, number, number];
}

/** The same tile as an SVG path centred on 0,0 (the helper map draws it). */
export function tilePath(shape: TileShape, side: number, grow = 0): string {
  const h = side / 2 + grow;
  const [tl, tr, br, bl] = tileCorners(shape, side, grow);
  return `M${-h + tl} ${-h}H${h - tr}A${tr} ${tr} 0 0 1 ${h} ${-h + tr}V${h - br}A${br} ${br} 0 0 1 ${h - br} ${h}H${-h + bl}A${bl} ${bl} 0 0 1 ${-h} ${h - bl}V${-h + tl}A${tl} ${tl} 0 0 1 ${-h + tl} ${-h}Z`;
}

/** How far the tile behind a helper's helper shows at its top left. */
export function echoOffset(size: number): number {
  return size >= 32 ? 3 : 2;
}

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
 * word inside "a-b-c" still counts as a word. It does not sit at "_", so "unit_tester" is read as
 * "unit-tester"; a compound that hides its word, "playtest" or "codebase", is listed whole.)
 */
const RULES: [RegExp, HelperKind][] = [
  [/bug|crash|debug|diagnos|troubleshoot|\bhunt|investigat/, "debug"],
  [/\bperf(ormance)?\b|profil(er|ing)|optimi[sz]|benchmark/, "perf"],
  [/\btest|playtest|pytest|unittest|verif|\bqa\b|\bvalidat/, "test"],
  [/review|audit|\bcriti(c|que)/, "review"],
  [/explor|search|research|\bfind|\bfetch|lookup|look-up|\bscout|\brecon\b/, "explore"],
  [/\bspec(s|ification\w*)?\b/, "plan"],
  [/\bdoc(s|ument\w*)?\b|writ|\bguide|changelog|readme|\breport/, "docs"],
  [/\bplan(s|ner|ning)?\b|architect|\badvis|strateg/, "plan"],
  [/releas|deploy|packag|publish|\b(dev-?)?ops\b|\binfra/, "ops"],
  [/design|\bui\b|\bux\b|\bstyl|\bbrand|\bassets?\b|visual|frontend/, "design"],
  [/\bchores?\b|mechanic|clean-?up|\btidy|\bformat|\blint|\brenam|housekeep/, "chore"],
  [/\bgeneral/, "general"],
  [/\bcod(e(base)?|er|ing)\b|build|\bdev(s|elop\w*)?\b|engineer|implement|refactor|\bprogram|\bmod(s|der|ding)?\b|\bport(s|er|ing)?\b/, "build"],
];

export function helperKind(type: string | null): HelperKind {
  const t = (type ?? "").toLowerCase().replace(/_/g, "-");
  for (const [re, kind] of RULES) if (re.test(t)) return kind;
  return "other";
}

/**
 * Whose saved file a path is: the helper whose id is the whole id in "agent-<id>", never one whose
 * id only starts another's ("agent-a1.jsonl" is a1's file, "agent-a12.jsonl" is not).
 */
export function helperOfFile<T extends { agentId: string }>(path: string, agents: readonly T[]): T | undefined {
  return agents.find((a) => {
    const at = path.lastIndexOf(`agent-${a.agentId}`);
    if (at < 0) return false;
    const after = path.charAt(at + 6 + a.agentId.length);
    return after === "" || !/[A-Za-z0-9_-]/.test(after);
  });
}

/** A kind's icon, colours and name. */
export function kindLook(kind: HelperKind): Look {
  const k = KINDS[kind];
  return { Icon: k.Icon, label: k.label, kind, ...FAMILIES[k.family] };
}

/** An icon and a color per kind of helper, so a row of them reads at a glance. The list and the map both use it. */
export function agentLook(type: string | null): Look {
  return kindLook(helperKind(type));
}

/** Where a thread sits in the chat: the chat itself, a helper it started, or a helper started by another helper. */
export type AvatarLevel = "main" | "helper" | "nested";

/** What an avatar says when pointed at or read out: "Review helper", "Main session". */
export function avatarName(type: string | null, level: AvatarLevel = "helper"): string {
  if (level === "main") return "Main session";
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
 * A helper's face. The icon is its kind of work and the tile's shape and tint its family. Where it
 * sits is told by shape too: the main chat is a solid clay circle, a helper a tinted tile, and a
 * helper started by another helper the same tile hollow with a second tile showing behind its top
 * left (two cues, so it never rests on fill against outline alone). It names itself in its hover
 * and to a screen reader unless `quiet` (when the same words already stand beside it).
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
  const { Icon, tone, shape, fg } = agentLook(type);
  const name = avatarName(type, level);
  const Glyph = level === "main" ? MainChatIcon : Icon;
  // Hollow means no fill at all: the colour class stays, the background class goes (a utility
  // would win over .helper-av.nested, and the list would not match the map).
  const paint = level === "main" ? "bg-accent text-on-accent" : level === "nested" ? `${tone.replace(/\bbg-\S+\s*/g, "")} nested` : tone;
  const corners = level === "main" ? "50%" : tileCorners(shape, size).map((r) => `${r}px`).join(" ");
  return (
    <span
      {...(quiet ? { "aria-hidden": true } : { role: "img", "aria-label": name, title: name })}
      style={{ width: size, height: size, borderRadius: corners, ["--av" as string]: fg, ["--echo" as string]: `${echoOffset(size)}px` }}
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
 * A token figure that counts up the first time `id` shows in a launch (2026-11-08:
 * tokens everywhere, money on hover). The hover holds the exact count and the API-price
 * estimate; screen readers get the final figure and the estimate as words, never the ticks.
 */
export function TokenFigure({ tokens, cost, id, note, className = "" }: { tokens: number; cost: Cost; id: string; note?: string; className?: string }) {
  const v = costView(cost);
  return (
    // The unit sits beside the figure in body type, never inside the display size (the Dashboard
    // hero's pattern): "203k" large, "tokens" small on the same baseline.
    <span className="inline-flex flex-wrap items-baseline gap-x-2.5 tabular-nums" title={note ? `${tokenHint(tokens, cost)}\n${note}` : tokenHint(tokens, cost)}>
      <CountUp value={tokens} id={id} format={(n) => compact(Math.round(n))} className={className} />
      <span className="text-lead font-semibold text-ink-2">tokens</span>
      {!v.none && <span className="sr-only">{`, about ${formatUsd(cost.usd ?? 0)} at API prices, estimated${v.partial ? ", incomplete" : ""}`}</span>}
    </span>
  );
}
