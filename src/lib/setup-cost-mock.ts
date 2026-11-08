// A believable made-up cost report for the plain-browser build and for tests: built from the
// mock setup so every row points at a real mock item. Prices: 0.20 per million tokens read.

import type { CostReport, CostRow, SetupItem } from "./setup-types";

const WEEK_TURNS = 1_800;
const READ_USD_PER_TOKEN = 0.2e-6;

function row(it: SetupItem | null, name: string, kind: string, extra: Partial<CostRow>): CostRow {
  const r: CostRow = {
    id: it?.id ?? null,
    name,
    kind,
    scopeLabel: it?.scopeLabel ?? "Claude app and claude.ai",
    loadsIn: it && it.scope !== "project" && it.scope !== "local" ? "All chats" : "Chats in atlas",
    global: !(it && (it.scope === "project" || it.scope === "local")),
    path: it?.path ?? null,
    tokens: 0,
    turns: 0,
    usdLoaded: 0,
    bodyTokens: 0,
    uses: null,
    usdUsed: 0,
    usdWeek: 0,
    measured: false,
    ...extra,
  };
  r.usdWeek = r.usdLoaded + r.usdUsed;
  return r;
}

export function mockCostReport(items: SetupItem[]): CostReport {
  const rows: CostRow[] = [];
  for (const it of items) {
    if (it.backup || it.worktree || !it.path) continue;
    const size = Math.round((it.size ?? 1200) / 2.4);
    const turns = it.scope === "project" || it.scope === "local" ? Math.round(WEEK_TURNS * 0.6) : WEEK_TURNS;
    switch (it.kind) {
      case "instructions":
      case "autoMemory":
      case "outputStyle":
        rows.push(row(it, it.name, it.kind, { tokens: size, turns, usdLoaded: size * turns * READ_USD_PER_TOKEN }));
        break;
      case "rule": {
        const scoped = it.chips.length > 0;
        rows.push(
          row(it, it.name, it.kind, scoped ? { bodyTokens: size } : { tokens: size, turns, usdLoaded: size * turns * READ_USD_PER_TOKEN }),
        );
        break;
      }
      case "skill":
      case "agent": {
        const listing = Math.round(40 + it.description.length / 2.4);
        const uses = it.name.length % 4;
        const body = Math.round(size / 2);
        rows.push(
          row(it, it.name, it.kind, {
            tokens: listing,
            turns,
            usdLoaded: listing * turns * READ_USD_PER_TOKEN,
            bodyTokens: body,
            uses,
            usdUsed: uses * body * (6.25e-6 + 20 * READ_USD_PER_TOKEN),
          }),
        );
        break;
      }
      case "command":
        rows.push(row(it, it.name, it.kind, { tokens: 30, turns, usdLoaded: 30 * turns * READ_USD_PER_TOKEN, bodyTokens: size }));
        break;
      default:
        break;
    }
  }
  rows.push(row(null, "Other connected tools (4)", "mcpServer", { tokens: 3400, turns: 900, usdLoaded: 3400 * 900 * READ_USD_PER_TOKEN, measured: true, global: false, loadsIn: "Chats that connect them" }));
  rows.sort((a, b) => b.usdWeek - a.usdWeek || b.tokens - a.tokens || a.name.localeCompare(b.name));
  return {
    windowDays: 7,
    charsPerToken: 2.4,
    turns: WEEK_TURNS,
    globalTokens: rows.filter((r) => r.global).reduce((n, r) => n + r.tokens, 0),
    usdWeek: rows.reduce((n, r) => n + r.usdWeek, 0),
    incomplete: false,
    rows: rows.filter((r) => r.tokens > 0 || r.bodyTokens > 0),
  };
}
