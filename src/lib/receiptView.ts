// Pure: turns the receipt the engine sends into the lines the screen draws. No React here.
//
// The rule these keep: every list is its lines plus one "everything else" line, and together they
// are the chat's cost. A line is never dropped, only folded into "N other helpers".

import { compact, formatUsd, modelLabel, plural } from "./usage";
import type { Receipt, ReceiptFlag, ReceiptItem, ReceiptKinds, ReceiptThread } from "./types";

/** Under this a remainder is rounding, not a line. */
const CRUMB = 0.005;

/** An estimate, marked as one: "~$3.20". */
export const guess = (usd: number | null): string => (usd === null ? "" : `~${formatUsd(usd)}`);

export interface SpendLine {
  key: string;
  label: string;
  usd: number;
  /** The helper this line is (null: the main chat or a folded line). */
  agentId: string | null;
  kind: "main" | "helper" | "more" | "model" | "kind" | "other";
  /** The line's colour slot, for the model dots. */
  model?: string;
}

const other = (usd: number): SpendLine[] => (Math.abs(usd) >= CRUMB ? [{ key: "other", label: "Everything else", usd, agentId: null, kind: "other" }] : []);

/** Main chat first, then the biggest helpers, then one line for the rest. */
export function whoSpent(r: Receipt, limit = 6): SpendLine[] {
  const main = r.threads.find((t) => t.agentId === null);
  const helpers = r.threads.filter((t) => t.agentId !== null).sort((a, b) => b.usd - a.usd);
  const shown = helpers.slice(0, Math.max(0, limit - 1));
  const rest = helpers.slice(shown.length);
  const line = (t: ReceiptThread): SpendLine => ({ key: t.agentId ?? "main", label: t.name, usd: t.usd, agentId: t.agentId, kind: t.agentId ? "helper" : "main", model: t.model });
  return [
    ...(main ? [line(main)] : []),
    ...shown.map(line),
    ...(rest.length > 0
      ? [{ key: "more", label: `${plural(rest.length, "other helper")}`, usd: rest.reduce((s, t) => s + t.usd, 0), agentId: null, kind: "more" as const }]
      : []),
    ...other(r.threadsOtherUsd),
  ];
}

const KIND_LABEL: [keyof ReceiptKinds, string][] = [
  ["cacheWrite", "Cache writes"],
  ["cacheRead", "Cache reads"],
  ["output", "Output"],
  ["input", "Input"],
  ["web", "Web search"],
];

/** What the money bought, biggest first; kinds that cost nothing are left out. */
export function whatItBought(r: Receipt): SpendLine[] {
  const lines = KIND_LABEL.map(([k, label]) => ({ key: k, label, usd: r.kinds[k], agentId: null, kind: "kind" as const }))
    .filter((l) => l.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  return [...lines, ...other(r.kindsOtherUsd)];
}

export function byModel(r: Receipt): SpendLine[] {
  const lines = r.models.map((m) => ({ key: m.model, label: modelLabel(m.model), usd: m.usd, agentId: null, kind: "model" as const, model: m.model }));
  return [...lines, ...other(r.modelsOtherUsd)];
}

// ---- line items ------------------------------------------------------------------

export function itemTitle(i: ReceiptItem): string {
  if (i.kind === "read") return `Read ${i.path ?? "a file"}`;
  if (i.kind === "output") return `One ${i.tool} output`;
  return `${i.tool} output${i.path ? ` from ${i.path}` : ""}`;
}

/** "14 times, ~2.1M tokens": what makes the line big. Never any of the text itself. */
export function itemDetail(i: ReceiptItem): string {
  const tokens = `~${compact(i.tokens)} tokens`;
  if (i.kind === "read") return `${plural(i.count, "time")}, ${tokens}`;
  if (i.kind === "outputs") return `${plural(i.count, "result")}, ${tokens}`;
  return tokens;
}

// ---- flags -----------------------------------------------------------------------

export interface FlagText {
  kicker: string;
  name: string;
  detail: string;
}

export function flagText(f: ReceiptFlag): FlagText {
  const cost = f.usd !== null && f.usd >= CRUMB ? guess(f.usd) : "";
  const join = (...parts: string[]) => parts.filter(Boolean).join(", ");
  switch (f.kind) {
    case "repeat_read":
      return { kicker: "Same file, again and again", name: f.label, detail: join(`read ${plural(f.count, "time")}`, `~${compact(f.tokens)} tokens`, cost) };
    case "huge_output":
      return { kicker: "One huge result", name: f.label, detail: join(`~${compact(f.tokens)} tokens in one go`, cost) };
    case "heavy_helper":
      return {
        kicker: "Big model, small job",
        name: f.label,
        detail: join(f.model ? modelLabel(f.model) : "", f.tools.length > 0 ? `only ${f.tools.join(", ")}` : "", cost),
      };
    case "cache_miss":
      return {
        kicker: "Cache went cold",
        name: f.label,
        detail: join(f.minutes !== null ? `after ${Math.round(f.minutes)} min away` : "", cost ? `${cost} extra` : ""),
      };
    default:
      return { kicker: "Worth a look", name: f.label, detail: cost };
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

/** A share of the chat as a width, never invisible when there is any spend. */
export const barWidth = (usd: number, total: number): number => (total > 0 && usd > 0 ? Math.min(100, Math.max(1.5, (usd / total) * 100)) : 0);
