// What the setup costs: the numbers come from Rust (`setup_cost`); this file only formats
// them and groups them for the page. Every figure is an estimate and is shown as one.

import type { CostReport, CostRow, ItemKind } from "./setup-types";

/** Dollars for a figure on the page: `$0.04`, `$4.20`, `$21`, `$1.2k`. Never more than 3 digits. */
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

/** Tokens or turns: `430`, `8.8k`, `12k`, `1.3M`. */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The estimate marker: a leading tilde, once per figure. */
export function approx(v: number): string {
  return `~${fmtUsd(v)}`;
}

/** What a row costs when it only has a size (no turns to price): tokens, not dollars. */
export function hasDollars(r: CostRow): boolean {
  return r.usdWeek > 0;
}

/** Dollars per week by item kind, for the tile readouts. */
export function costByKind(report: CostReport | null): Map<ItemKind, number> {
  const m = new Map<ItemKind, number>();
  if (!report) return m;
  for (const r of report.rows) m.set(r.kind as ItemKind, (m.get(r.kind as ItemKind) ?? 0) + r.usdWeek);
  return m;
}

/** The rows that make up the "what it costs" ranking: dollars first, or size when nothing is priced. */
export function topRows(report: CostReport | null, n: number): CostRow[] {
  if (!report) return [];
  const priced = report.rows.filter(hasDollars);
  if (priced.length > 0) return priced.slice(0, n);
  return [...report.rows].sort((a, b) => b.tokens + b.bodyTokens - (a.tokens + a.bodyTokens)).slice(0, n);
}

/** The cost row for one setup item, if it has one. */
export function rowFor(report: CostReport | null, id: string): CostRow | null {
  return report?.rows.find((r) => r.id === id) ?? null;
}

/** `Last 7 days` / `Last 24 hours`: how long the dollars cover. */
export function windowLabel(report: CostReport): string {
  return report.windowDays === 1 ? "last day" : `last ${report.windowDays} days`;
}

/** "8.8k tokens x 12k turns" */
export function loadLine(r: CostRow): string {
  return `${fmtCount(r.tokens)} tokens x ${fmtCount(r.turns)} turns`;
}
