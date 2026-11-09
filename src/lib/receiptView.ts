// Pure: turns the receipt the engine sends into the lines the screen draws. No React here.
//
// The rule these keep: every list is its lines plus one "everything else" line, and together they
// are the chat's tokens (input + output + cache writes; cache reads are listed apart, as
// everywhere else in the app). Dollars are only an estimate, so they ride along in `usd` for the
// hover text and are never the figure on screen. A line is never dropped, only folded into
// "N other helpers".

import { compact, formatUsd, modelLabel, plural } from "./usage";
import type { Receipt, ReceiptFlag, ReceiptItem, ReceiptThread } from "./types";

/** An estimate in dollars, marked as one, for hover text: "about $3.20". */
export const guess = (usd: number | null): string => (usd === null ? "" : `about ${formatUsd(usd)}`);

/** "12.4M tokens" */
export const tokensText = (n: number): string => `${compact(n)} tokens`;

export interface SpendLine {
  key: string;
  label: string;
  tokens: number;
  /** The estimate behind the figure; shown only in the hover text. */
  usd: number | null;
  /** The helper this line is (null: the main chat or a folded line). */
  agentId: string | null;
  kind: "main" | "helper" | "more" | "model" | "kind" | "other";
  /** The line's colour slot, for the model dots. */
  model?: string;
}

/** The hover text of a line: what its tokens come to in dollars, as an estimate. */
export const lineTitle = (l: Pick<SpendLine, "label" | "tokens" | "usd">): string =>
  `${l.label}: ${tokensText(l.tokens)}${l.usd !== null && l.usd >= 0.005 ? `, ${guess(l.usd)}` : ""}`;

const other = (tokens: number): SpendLine[] => (tokens >= 1 ? [{ key: "other", label: "Everything else", tokens, usd: null, agentId: null, kind: "other" }] : []);

/** What no listed line explains: the chat's tokens less the lines. Never below zero. */
const left = (r: Receipt, lines: { tokens: number }[]): number => Math.max(0, r.totalTokens - lines.reduce((s, l) => s + l.tokens, 0));

/** Main chat first, then the biggest helpers, then one line for the rest. */
export function whoUsed(r: Receipt, limit = 6): SpendLine[] {
  const main = r.threads.find((t) => t.agentId === null);
  const helpers = r.threads.filter((t) => t.agentId !== null).sort((a, b) => b.tokens - a.tokens);
  const shown = helpers.slice(0, Math.max(0, limit - 1));
  const rest = helpers.slice(shown.length);
  const line = (t: ReceiptThread): SpendLine => ({ key: t.agentId ?? "main", label: t.name, tokens: t.tokens, usd: t.usd, agentId: t.agentId, kind: t.agentId ? "helper" : "main", model: t.model });
  const lines: SpendLine[] = [
    ...(main ? [line(main)] : []),
    ...shown.map(line),
    ...(rest.length > 0
      ? [{ key: "more", label: `${plural(rest.length, "other helper")}`, tokens: rest.reduce((s, t) => s + t.tokens, 0), usd: rest.reduce((s, t) => s + t.usd, 0), agentId: null, kind: "more" as const }]
      : []),
  ];
  return [...lines, ...other(left(r, lines))];
}

const KIND_LABEL: ["output" | "cacheWrite" | "input", string][] = [
  ["cacheWrite", "Cache writes"],
  ["output", "Output"],
  ["input", "Input"],
];

/** The headline kinds of token, biggest first; a kind with none is left out. */
export function whatItUsed(r: Receipt): SpendLine[] {
  const lines: SpendLine[] = KIND_LABEL.map(([k, label]) => ({ key: k, label, tokens: r.tokenKinds[k], usd: r.kinds[k], agentId: null, kind: "kind" as const }))
    .filter((l) => l.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  return [...lines, ...other(left(r, lines))];
}

/** Cache reads, listed apart from the total (they are re-reads of what is already stored). */
export const cacheReads = (r: Receipt): { tokens: number; usd: number } => ({ tokens: r.tokenKinds.cacheRead, usd: r.kinds.cacheRead });

export function byModel(r: Receipt): SpendLine[] {
  const lines: SpendLine[] = r.models.map((m) => ({ key: m.model, label: modelLabel(m.model), tokens: m.tokens, usd: m.usd, agentId: null, kind: "model" as const, model: m.model }));
  return [...lines, ...other(left(r, lines))];
}

// ---- line items ------------------------------------------------------------------

export function itemTitle(i: ReceiptItem): string {
  if (i.kind === "read") return `Read ${i.path ?? "a file"}`;
  if (i.kind === "output") return `One ${i.tool} output`;
  return `${i.tool} output${i.path ? ` from ${i.path}` : ""}`;
}

/** "14 times": what makes the line big. Never any of the text itself. */
export function itemDetail(i: ReceiptItem): string {
  if (i.kind === "read") return plural(i.count, "time");
  if (i.kind === "outputs") return plural(i.count, "result");
  return "";
}

/** The hover text of a line item: its tokens and the dollar estimate behind them. */
export const itemTitleFull = (i: ReceiptItem): string => `${itemTitle(i)}: about ${compact(i.tokens)} tokens${i.usd !== null && i.usd >= 0.005 ? `, ${guess(i.usd)}` : ""}`;

// ---- flags -----------------------------------------------------------------------

export interface FlagText {
  kicker: string;
  name: string;
  detail: string;
  /** Hover text: the detail plus the dollar estimate. */
  title: string;
}

export function flagText(f: ReceiptFlag): FlagText {
  const cost = f.usd !== null && f.usd >= 0.005 ? guess(f.usd) : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(", ");
  const tok = f.tokens > 0 ? `about ${compact(f.tokens)} tokens` : "";
  const make = (kicker: string, detail: string, extra = ""): FlagText => ({ kicker, name: f.label, detail, title: join(`${kicker}: ${f.label}`, detail, extra || cost) });
  switch (f.kind) {
    case "repeat_read":
      return make("Same file, again and again", join(`read ${plural(f.count, "time")}`, tok));
    case "huge_output":
      return make("One huge result", join(tok ? `${tok} in one go` : ""));
    case "heavy_helper":
      return make("Big model, small job", join(f.model ? modelLabel(f.model) : "", f.tools.length > 0 ? `only ${f.tools.join(", ")}` : "", tok));
    case "cache_miss":
      return make("Cache went cold", join(f.minutes !== null ? `after ${Math.round(f.minutes)} min away` : "", tok ? `${tok} re-cached` : ""), cost ? `${cost} extra` : "");
    default:
      return make("Worth a look", tok);
  }
}

/** Row heights of the third receipt column (px), so it can be sized to the room it has. */
const FLAG_H = 76;
const ITEM_H = 46;
const COLUMN_BASE = 100; // heading, "Everything else", total
const FLAG_BLOCK = 44; // heading, gap, the "N more flags" line
const MIN_ITEMS = 3;

/**
 * How many flags and line items fit in a column `room` px tall, so the receipt never needs a
 * scrollbar when it can be avoided. Two flags first, then line items, then a third flag; never
 * fewer than three line items (those would scroll instead).
 */
export function fitColumn(room: number, flags: number, items: number): { flags: number; items: number } {
  let i = Math.min(MIN_ITEMS, items);
  let budget = room - COLUMN_BASE - (flags > 0 ? FLAG_BLOCK : 0) - i * ITEM_H;
  let f = 0;
  for (;;) {
    if (f < Math.min(2, flags) && budget >= FLAG_H) f += 1, (budget -= FLAG_H);
    else if (i < items && budget >= ITEM_H) i += 1, (budget -= ITEM_H);
    else if (f < Math.min(3, flags) && budget >= FLAG_H) f += 1, (budget -= FLAG_H);
    else break;
  }
  return { flags: f, items: i };
}

/** A share of the chat as a width, never invisible when there is any use. */
export const barWidth = (tokens: number, total: number): number => (total > 0 && tokens > 0 ? Math.min(100, Math.max(1.5, (tokens / total) * 100)) : 0);
