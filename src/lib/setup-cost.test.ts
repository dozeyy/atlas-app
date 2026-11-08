import { describe, expect, it } from "vitest";
import { approx, costByKind, fmtCount, fmtUsd, hasDollars, loadLine, rowFor, topRows, windowLabel } from "./setup-cost";
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

describe("figures", () => {
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
  ])("dollars %f read as %s", (v, want) => {
    expect(fmtUsd(v)).toBe(want);
  });

  it.each([
    [0, "0"],
    [430, "430"],
    [8804, "8.8k"],
    [9999, "10k"],
    [12_084, "12k"],
    [1_300_000, "1.3M"],
  ])("counts %f read as %s", (n, want) => expect(fmtCount(n)).toBe(want));

  it("marks an estimate with a leading tilde", () => {
    expect(approx(21.26)).toBe("~$21");
    expect(approx(0)).toBe("~$0");
  });

  it("says tokens and turns the same way everywhere", () => {
    expect(loadLine(row({ tokens: 8804, turns: 12_084 }))).toBe("8.8k tokens x 12k turns");
    expect(windowLabel(report([]))).toBe("last 7 days");
    expect(windowLabel(report([], { windowDays: 1 }))).toBe("last day");
  });
});

describe("grouping", () => {
  const rows = [
    row({ id: "a", kind: "instructions", usdWeek: 5 }),
    row({ id: "b", kind: "instructions", usdWeek: 3 }),
    row({ id: "c", kind: "skill", usdWeek: 1 }),
    row({ id: "d", kind: "mcpServer", usdWeek: 0.5 }),
  ];

  it("adds up dollars by kind", () => {
    const m = costByKind(report(rows));
    expect(m.get("instructions")).toBe(8);
    expect(m.get("skill")).toBe(1);
    expect(m.get("mcpServer")).toBe(0.5);
    expect(m.has("agent")).toBe(false);
    expect(costByKind(null).size).toBe(0);
  });

  it("ranks by dollars and caps the list", () => {
    expect(topRows(report(rows), 2).map((r) => r.id)).toEqual(["a", "b"]);
    expect(topRows(null, 5)).toEqual([]);
  });

  it("falls back to size when nothing could be priced", () => {
    const sizes = [row({ id: "small", tokens: 10 }), row({ id: "big", tokens: 900 }), row({ id: "body", tokens: 0, bodyTokens: 300 })];
    expect(sizes.some(hasDollars)).toBe(false);
    expect(topRows(report(sizes, { turns: 0 }), 5).map((r) => r.id)).toEqual(["big", "body", "small"]);
  });

  it("finds the row of one item by id", () => {
    expect(rowFor(report(rows), "c")?.kind).toBe("skill");
    expect(rowFor(report(rows), "zzz")).toBeNull();
    expect(rowFor(null, "a")).toBeNull();
  });
});
