import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { mockCostReport } from "./setup-cost-mock";
import { mockSetupSnapshot } from "./setup-mock";
import type { CostReport, CostRow } from "./setup-types";

// fixtures/setup-cost-wire-keys.json is written by the Rust test
// `the_wire_format_matches_the_front_end_key_list` (crates/core/tests/setup_cost.rs) from what
// `setup_cost` really serialises. The TypeScript types and the browser mock must name exactly
// those keys, so a renamed field on either side fails a test, not the page.
const wire: Record<string, string[]> = JSON.parse(readFileSync(resolve(__dirname, "../../fixtures/setup-cost-wire-keys.json"), "utf8"));

const REPORT_KEYS = { windowDays: 1, charsPerToken: 1, turns: 1, globalTokens: 1, usdWeek: 1, incomplete: 1, rows: 1 } satisfies Record<keyof CostReport, 1>;
const ROW_KEYS = {
  id: 1, name: 1, kind: 1, scopeLabel: 1, loadsIn: 1, global: 1, path: 1, tokens: 1, turns: 1, usdLoaded: 1, bodyTokens: 1, uses: 1, usdUsed: 1, usdWeek: 1, measured: 1,
} satisfies Record<keyof CostRow, 1>;

describe("setup cost wire format", () => {
  it("the types name the keys Rust sends", () => {
    expect(Object.keys(REPORT_KEYS).sort()).toEqual(wire.costReport);
    expect(Object.keys(ROW_KEYS).sort()).toEqual(wire.costRow);
  });

  it("the browser mock builds objects with exactly those keys", async () => {
    const rep = mockCostReport((await mockSetupSnapshot(false)).items);
    expect(Object.keys(rep).sort()).toEqual(wire.costReport);
    expect(rep.rows.length).toBeGreaterThan(3);
    for (const r of rep.rows) expect(Object.keys(r).sort(), r.name).toEqual(wire.costRow);
  });
});
