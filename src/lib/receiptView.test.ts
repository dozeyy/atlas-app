import { describe, expect, it } from "vitest";
import { MockBackend } from "./mock";
import { byModel, fitColumn, flagText, itemDetail, itemTitle, whatItBought, whoSpent } from "./receiptView";
import { layoutMap } from "./helperMap";
import type { Receipt, ReceiptFlag, ReceiptItem } from "./types";

const sum = (lines: { usd: number }[]) => lines.reduce((s, l) => s + l.usd, 0);

/** Every chat the stand-in backend has, as the receipt the screen would get. */
async function receipts(): Promise<Receipt[]> {
  const b = new MockBackend();
  const page = await b.sessionsList({ limit: 200 });
  const out: Receipt[] = [];
  for (const row of page.rows) {
    const r = await b.sessionReceipt(row.sessionId);
    if (r) out.push(r);
  }
  return out;
}

describe("receipt: every list adds up to the chat", () => {
  it("who spent it, what it bought and the models each sum to the total, in every chat", async () => {
    const all = await receipts();
    expect(all.length).toBeGreaterThan(5);
    for (const r of all) {
      const total = r.totalUsd ?? 0;
      expect(sum(whoSpent(r))).toBeCloseTo(total, 6);
      expect(sum(whatItBought(r))).toBeCloseTo(total, 6);
      expect(sum(byModel(r))).toBeCloseTo(total, 6);
    }
  });

  it("folds the small spenders into one line without losing a cent", async () => {
    const all = await receipts();
    const big = [...all].sort((a, b) => b.threads.length - a.threads.length)[0];
    expect(big.threads.length).toBeGreaterThan(3);
    expect(big).toBeDefined();
    const lines = whoSpent(big, 3);
    expect(lines.filter((l) => l.kind === "helper")).toHaveLength(2);
    expect(lines.find((l) => l.kind === "more")?.label).toMatch(/^\d+ other helpers?$/);
    expect(sum(lines)).toBeCloseTo(big.totalUsd ?? 0, 6);
    // Main chat first, then the biggest helpers in order.
    expect(lines[0].kind).toBe("main");
    const helpers = lines.filter((l) => l.kind === "helper").map((l) => l.usd);
    expect([...helpers].sort((a, b) => b - a)).toEqual(helpers);
  });

  it("leaves out a kind that cost nothing, and a remainder that is only rounding", async () => {
    const [r] = await receipts();
    const lines = whatItBought({ ...r, kinds: { output: 1, cacheWrite: 0, cacheRead: 0, input: 0, web: 0 }, kindsOtherUsd: 0.001 });
    expect(lines.map((l) => l.key)).toEqual(["output"]);
  });

  it("the helper map's nodes carry exactly the chat's spend", async () => {
    for (const r of await receipts()) {
      const m = layoutMap(r.threads, { width: 800, height: 500 });
      expect(sum(m.nodes)).toBeCloseTo(sum(r.threads), 9);
    }
  });
});

describe("receipt: fitting the third column", () => {
  it("shows more rows the more room there is, and never more than exists", () => {
    const small = fitColumn(400, 5, 8);
    const big = fitColumn(900, 5, 8);
    expect(big.items + big.flags).toBeGreaterThan(small.items + small.flags);
    expect(big.flags).toBeLessThanOrEqual(3);
    expect(fitColumn(2000, 1, 2)).toEqual({ flags: 1, items: 2 });
    expect(fitColumn(2000, 0, 8)).toEqual({ flags: 0, items: 8 });
  });

  it("puts two flags before line items, and keeps at least three line items however little room", () => {
    expect(fitColumn(560, 3, 8).flags).toBeGreaterThanOrEqual(2);
    expect(fitColumn(100, 3, 8)).toEqual({ flags: 0, items: 3 });
  });

  it("stays within the room it was given when the room allows more than the minimum", () => {
    for (const room of [450, 520, 580, 640, 720, 900]) {
      const f = fitColumn(room, 3, 8);
      const used = 100 + (f.flags > 0 ? 44 : 0) + f.flags * 76 + f.items * 46;
      expect(used).toBeLessThanOrEqual(Math.max(room, 100 + 3 * 46));
    }
  });
});

describe("receipt: wording", () => {
  const read: ReceiptItem = { kind: "read", tool: "Read", path: "docs/tech.md", count: 14, tokens: 2_100_000, usd: 3.1, thread: null };
  const bash: ReceiptItem = { kind: "output", tool: "Bash", path: null, count: 1, tokens: 180_000, usd: 3, thread: "Main chat" };

  it("names a line by the file or tool and says what makes it big, with an estimate mark on the money", () => {
    expect(itemTitle(read)).toBe("Read docs/tech.md");
    expect(itemDetail(read)).toBe("14 times, ~2.1M tokens");
    expect(itemTitle(bash)).toBe("One Bash output");
    expect(itemDetail(bash)).toBe("~180k tokens");
  });

  it("writes each flag from its fields", () => {
    const base: ReceiptFlag = { kind: "repeat_read", label: "docs/tech.md", agentId: null, count: 14, tokens: 2_100_000, usd: 3.1, minutes: null, model: null, tools: [] };
    expect(flagText(base)).toEqual({ kicker: "Same file, again and again", name: "docs/tech.md", detail: "read 14 times, ~2.1M tokens, ~$3.10" });
    expect(flagText({ ...base, kind: "huge_output", label: "Bash", tokens: 180_000, usd: 3 }).detail).toBe("~180k tokens in one go, ~$3.00");
    const heavy = flagText({ ...base, kind: "heavy_helper", label: "Find the config", model: "claude-opus-4-1", tools: ["Read", "Grep"], usd: 0.9 });
    expect(heavy.kicker).toBe("Big model, small job");
    expect(heavy.detail).toBe("Opus 4.1, only Read, Grep, ~$0.90");
    const cold = flagText({ ...base, kind: "cache_miss", label: "Main chat", minutes: 31.4, usd: 0.4 });
    expect(cold.detail).toBe("after 31 min away, ~$0.40 extra");
  });

  it("never shows a flag's money when it is crumbs", () => {
    const f: ReceiptFlag = { kind: "huge_output", label: "Bash", agentId: null, count: 1, tokens: 50_000, usd: 0.001, minutes: null, model: null, tools: [] };
    expect(flagText(f).detail).toBe("~50k tokens in one go");
  });
});
