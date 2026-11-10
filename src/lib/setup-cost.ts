// What the setup costs: the numbers come from Rust (`setup_cost`); this file only words them and
// ranks them for the page. The screen speaks tokens (most people are on a plan, not the API);
// the API-price dollar estimate lives in hover text only. Every figure is an estimate.

import { compact, exact } from "./usage";
import type { CostReport, CostRow, ItemKind } from "./setup-types";

/** Dollars for hover text: `$0.04`, `$4.20`, `$21`, `$1.2k`. Never more than 3 digits. */
export function fmtUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v < 0.01) return "<$0.01";
  const cents = Math.round(v * 100) / 100;
  if (cents < 10) return `$${cents.toFixed(2)}`;
  const whole = Math.round(v);
  if (whole < 1000) return `$${whole}`;
  const k = Math.round(v / 100) / 10;
  return `$${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

/** Skills, agents and commands cost their body when they are called. */
const PER_CALL = new Set<ItemKind>(["skill", "agent", "command"]);

export function isPerCall(kind: string): boolean {
  return PER_CALL.has(kind as ItemKind);
}

/** One figure in the honest unit for what the item is. */
export interface CostWords {
  /** Tokens. Show with `compact()`: at most three digits (7.3k, 27M). */
  n: number;
  /** "tokens per call", "tokens per message" or "tokens when used". */
  unit: string;
}

/**
 * The one figure an item shows in its list and sheet:
 * skills, agents, commands: what loads each time they are called;
 * CLAUDE.md, rules, memory, output styles, MCP tools: what loads with every message;
 * a rule that only loads for matching files: its size, when it is used.
 */
export function costWords(r: CostRow): CostWords | null {
  if (isPerCall(r.kind) && r.bodyTokens > 0) return { n: r.bodyTokens, unit: "tokens per call" };
  if (r.tokens > 0) return { n: r.tokens, unit: "tokens per message" };
  if (r.bodyTokens > 0) return { n: r.bodyTokens, unit: "tokens when used" };
  return null;
}

/** "About $21 a week at API prices." Empty when nothing could be priced. */
export function usdHover(r: { usdWeek: number }, report: CostReport | null): string {
  if (!report || !(r.usdWeek > 0)) return "";
  return `Estimate: about ${fmtUsd(r.usdWeek)} a week at API prices, ${windowLabel(report)}.`;
}

/** The hover on an item's figure: exact tokens, then the API-price estimate. */
export function itemHover(r: CostRow, report: CostReport | null): string {
  const w = costWords(r);
  const head = w ? `${exact(w.n)} ${w.unit}.` : "";
  return [head, usdHover(r, report)].filter(Boolean).join(" ");
}

/** Tokens a row adds over the window: per message x messages. Without chats yet, its per-message size. */
export function weeklyTokens(r: CostRow): number {
  return r.turns > 0 ? r.tokens * r.turns : r.tokens;
}

/**
 * The rows that make up the "what it costs" ranking: what loads with every message, biggest
 * over the window first. On-demand items (skills, agents) are priced per call inside their
 * own list, so they are not mixed in here.
 */
export function topRows(report: CostReport | null, n: number): CostRow[] {
  if (!report) return [];
  return report.rows
    .filter((r) => r.tokens > 0)
    .sort((a, b) => weeklyTokens(b) - weeklyTokens(a))
    .slice(0, n);
}

/** The cost row for one setup item, if it has one. */
export function rowFor(report: CostReport | null, id: string): CostRow | null {
  return report?.rows.find((r) => r.id === id) ?? null;
}

/** `last 7 days` / `last day`: how long the figures cover. */
export function windowLabel(report: CostReport): string {
  return report.windowDays === 1 ? "last day" : `last ${report.windowDays} days`;
}

/**
 * The name a ranking row shows. Something that only loads in one project's chats carries that
 * project's name ("CLAUDE.md · pixel-garden"), so two files with the same name never look alike.
 */
export function rowTitle(r: CostRow): string {
  const project = /^Chats in (.+)$/.exec(r.loadsIn)?.[1];
  return project ? `${r.name} · ${project}` : r.name;
}

/**
 * A title that ends in a bracketed count ("Other connected tools (19)") as its label and its
 * count, so the count is set the way every Toolkit heading sets one: "Global 3", never "(3)".
 */
export function titleCount(title: string): { label: string; count: string | null } {
  const m = /^(.*\S)\s*\((\d[\d,]*)\)$/.exec(title);
  return m ? { label: m[1]!, count: m[2]! } : { label: title, count: null };
}

/** "8.8k per message" */
export function perMessage(r: CostRow): string {
  return `${compact(r.tokens)} per message`;
}
