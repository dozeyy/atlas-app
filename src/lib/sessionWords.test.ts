import { describe, expect, it } from "vitest";
import { MockUsage } from "./mockUsage";
import { mockCostReport } from "./setup-cost-mock";
import { costWords, loadsInWords, receiptWords } from "./sessionWords";

describe("the engine's fixed names, in the app's word", () => {
  it("rewords where a thing loads and leaves a project's own name alone", () => {
    expect(loadsInWords("All chats")).toBe("All sessions");
    expect(loadsInWords("Chats in atlas")).toBe("Sessions in atlas");
    expect(loadsInWords("Chats under docs/chats")).toBe("Sessions under docs/chats");
    expect(loadsInWords("Chats that connect them")).toBe("Sessions that connect them");
    expect(loadsInWords("Every project")).toBe("Every project");
  });

  it("names the main thread of a receipt 'Main session' and touches no helper", async () => {
    const usage = new MockUsage();
    const row = (await usage.sessionsList({ limit: 50 })).rows.find((r) => r.agentCount > 0)!;
    const raw = (await usage.sessionReceipt(row.sessionId))!;
    // The mock answers the way the engine does.
    expect(raw.threads.find((t) => t.agentId === null)!.name).toBe("Main chat");
    const said = receiptWords(raw)!;
    expect(said.threads.find((t) => t.agentId === null)!.name).toBe("Main session");
    expect(said.threads.filter((t) => t.agentId !== null).map((t) => t.name)).toEqual(raw.threads.filter((t) => t.agentId !== null).map((t) => t.name));
    expect(JSON.stringify(said)).not.toContain("Main chat");
    expect(receiptWords(null)).toBeNull();
  });

  it("rewords every row of the cost report", () => {
    const report = costWords(mockCostReport([]));
    expect(report.rows.length).toBeGreaterThan(0);
    for (const r of report.rows) expect(r.loadsIn).not.toMatch(/chats/i);
  });
});
