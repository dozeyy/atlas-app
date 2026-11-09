import { describe, expect, it } from "vitest";
import { costWords, fmtUsd, isPerCall, itemHover, perMessage, rowFor, topRows, usdHover, weeklyTokens, windowLabel } from "./setup-cost";
import type { CostReport, CostRow } from "./setup-types";

function row(over: Partial<CostRow>): CostRow {
  return {
    id: null,
    name: "x",
    kind: "instructions",
    scopeLabel: "Global",
    loadsIn: "All chats",
    global: true,
    path: null,
    tokens: 100,
    turns: 10,
    usdLoaded: 0,
    bodyTokens: 0,
    uses: null,
    usdUsed: 0,
    usdWeek: 0,
    measured: false,
    ...over,
  };
}

function report(rows: CostRow[], over: Partial<CostReport> = {}): CostReport {
  return { windowDays: 7, charsPerToken: 2.4, turns: 100, globalTokens: 0, usdWeek: rows.reduce((n, r) => n + r.usdWeek, 0), incomplete: false, rows, ...over };
}

describe("dollars (hover text only)", () => {
  it.each([
    [0, "$0"],
    [0.004, "<$0.01"],
    [0.04, "$0.04"],
    [4.2, "$4.20"],
    [9.996, "$10"],
    [21.26, "$21"],
    [999.4, "$999"],
    [999.6, "$1.0k"],
    [1234, "$1.2k"],
    [25_000, "$25k"],
  ])("%f reads as %s", (v, want) => {
    expect(fmtUsd(v)).toBe(want);
  });

  it("words the window the same way everywhere", () => {
    expect(windowLabel(report([]))).toBe("last 7 days");
    expect(windowLabel(report([], { windowDays: 1 }))).toBe("last day");
  });

  it("keeps the estimate out of the words and in the hover", () => {
    const r = row({ usdWeek: 21.26 });
    expect(usdHover(r, report([r]))).toBe("Estimate: about $21 a week at API prices, last 7 days.");
    expect(usdHover(row({ usdWeek: 0 }), report([]))).toBe("");
    expect(usdHover(r, null)).toBe("");
  });
});

describe("what an item shows", () => {
  it("names the honest unit for each kind", () => {
    expect(isPerCall("skill") && isPerCall("agent") && isPerCall("command")).toBe(true);
    expect(isPerCall("rule") || isPerCall("instructions") || isPerCall("mcpServer")).toBe(false);

    // On-demand things: what loads when they are called.
    expect(costWords(row({ kind: "skill", tokens: 80, bodyTokens: 7300 }))).toEqual({ n: 7300, unit: "tokens per call" });
    expect(costWords(row({ kind: "agent", tokens: 80, bodyTokens: 900 }))?.unit).toBe("tokens per call");
    // Always-loaded things: what loads with every message.
    expect(costWords(row({ kind: "instructions", tokens: 8804 }))).toEqual({ n: 8804, unit: "tokens per message" });
    expect(costWords(row({ kind: "mcpServer", tokens: 3400 }))?.unit).toBe("tokens per message");
    expect(costWords(row({ kind: "rule", tokens: 2791 }))?.unit).toBe("tokens per message");
    // A rule that only loads for matching files: its size, when it is used.
    expect(costWords(row({ kind: "rule", tokens: 0, bodyTokens: 300 }))).toEqual({ n: 300, unit: "tokens when used" });
    // A skill with no body to measure falls back to its listing.
    expect(costWords(row({ kind: "skill", tokens: 80, bodyTokens: 0 }))?.unit).toBe("tokens per message");
    expect(costWords(row({ tokens: 0, bodyTokens: 0 }))).toBeNull();
  });

  it("puts exact tokens first and the API-price estimate after it in the hover", () => {
    const r = row({ kind: "skill", tokens: 80, bodyTokens: 7300, usdWeek: 4.2 });
    expect(itemHover(r, report([r]))).toBe("7,300 tokens per call. Estimate: about $4.20 a week at API prices, last 7 days.");
    expect(itemHover(row({ tokens: 500 }), null)).toBe("500 tokens per message.");
  });

  it("says per message in compact tokens", () => {
    expect(perMessage(row({ tokens: 8804 }))).toBe("8.8k per message");
  });
});

describe("ranking", () => {
  const rows = [
    row({ id: "a", tokens: 100, turns: 50 }), // 5,000 over the window
    row({ id: "b", tokens: 400, turns: 5 }), // 2,000
    row({ id: "c", kind: "skill", tokens: 0, bodyTokens: 9000 }), // on demand: not ranked
    row({ id: "d", kind: "mcpServer", tokens: 90, turns: 30 }), // 2,700
  ];

  it("ranks what loads with every message by tokens over the window", () => {
    expect(weeklyTokens(rows[0]!)).toBe(5000);
    expect(topRows(report(rows), 5).map((r) => r.id)).toEqual(["a", "d", "b"]);
    expect(topRows(report(rows), 2).map((r) => r.id)).toEqual(["a", "d"]);
    expect(topRows(null, 5)).toEqual([]);
  });

  it("falls back to per-message size when there are no chats yet", () => {
    const sizes = [row({ id: "small", tokens: 10, turns: 0 }), row({ id: "big", tokens: 900, turns: 0 })];
    expect(weeklyTokens(sizes[1]!)).toBe(900);
    expect(topRows(report(sizes, { turns: 0 }), 5).map((r) => r.id)).toEqual(["big", "small"]);
  });

  it("finds the row of one item by id", () => {
    expect(rowFor(report(rows), "c")?.kind).toBe("skill");
    expect(rowFor(report(rows), "zzz")).toBeNull();
    expect(rowFor(null, "a")).toBeNull();
  });
});
