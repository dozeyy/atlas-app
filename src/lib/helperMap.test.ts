import { describe, expect, it } from "vitest";
import { fold, layoutMap, MAIN_ID, MAP_LIMIT, pathTo, startedBy } from "./helperMap";
import type { ReceiptThread } from "./types";

const KINDS = { output: 0, cacheWrite: 0, cacheRead: 0, input: 0, web: 0 };

function thread(agentId: string | null, parent: string | null, usd: number, extra: Partial<ReceiptThread> = {}): ReceiptThread {
  return {
    agentId,
    name: agentId ?? "Main chat",
    parentAgentId: parent,
    spawnDepth: parent ? 2 : agentId ? 1 : 0,
    model: "claude-sonnet-5-5",
    usd,
    tokens: 1000,
    cacheReadTokens: 0,
    messages: 4,
    durationMs: 1000,
    toolCalls: 2,
    kinds: KINDS,
    models: [],
    outcome: agentId ? "finished" : null,
    items: [],
    itemsOtherUsd: 0,
    flags: [],
    unpricedTokens: 0,
    ...extra,
  };
}

const SIZE = { width: 640, height: 420 };
const sum = (ts: { usd: number }[]) => ts.reduce((s, t) => s + t.usd, 0);

/** main -> a, b; a -> a1, a2; a1 -> a1x */
function nested(): ReceiptThread[] {
  return [
    thread(null, null, 5),
    thread("a", null, 2),
    thread("b", null, 1),
    thread("a1", "a", 0.5),
    thread("a2", "a", 0.25),
    thread("a1x", "a1", 0.125),
  ];
}

function many(n: number): ReceiptThread[] {
  return [thread(null, null, 10), ...Array.from({ length: n }, (_, i) => thread(`h${i}`, null, 0.1 + i * 0.01))];
}

describe("helper map: links", () => {
  it("hangs every helper from the thread that started it", () => {
    const m = layoutMap(nested(), SIZE);
    const edges = new Set(m.links.map((l) => `${l.from}>${l.to}`));
    expect(edges).toEqual(new Set(["main>a", "main>b", "a>a1", "a>a2", "a1>a1x"]));
    for (const n of m.nodes) if (n.parentId) expect(edges.has(`${n.parentId}>${n.id}`)).toBe(true);
  });

  it("puts each helper one ring deeper than the thread that started it", () => {
    const m = layoutMap(nested(), SIZE);
    const by = new Map(m.nodes.map((n) => [n.id, n]));
    expect(by.get("main")?.depth).toBe(0);
    expect(by.get("a")?.depth).toBe(1);
    expect(by.get("a1x")?.depth).toBe(3);
    for (const n of m.nodes) if (n.parentId) expect(n.depth).toBe((by.get(n.parentId)?.depth ?? -9) + 1);
  });

  it("hangs a helper whose starter is missing, itself, or in a loop from the main chat", () => {
    const parents = startedBy([thread("x", "ghost", 1), thread("y", "y", 1), thread("p", "q", 1), thread("q", "p", 1), thread("ok", "x", 1)]);
    expect(parents.get("x")).toBeNull();
    expect(parents.get("y")).toBeNull();
    expect(parents.get("p")).toBeNull();
    expect(parents.get("q")).toBeNull();
    expect(parents.get("ok")).toBe("x");
  });

  it("keeps a looped chat whole: every thread is still one node", () => {
    const ts = [thread(null, null, 3), thread("p", "q", 1), thread("q", "p", 1)];
    const m = layoutMap(ts, SIZE);
    expect(m.nodes.map((n) => n.id).sort()).toEqual(["main", "p", "q"]);
    expect(m.links).toHaveLength(2);
  });

  it("lights the way from the main chat down to a node", () => {
    const m = layoutMap(nested(), SIZE);
    expect([...pathTo(m, "a1x")].sort()).toEqual(["a", "a1", "a1x", "main"]);
    expect([...pathTo(m, "main")]).toEqual(["main"]);
  });
});

describe("helper map: spend", () => {
  it("adds up to the chat: every thread is a node and the nodes carry exactly their own spend", () => {
    const ts = nested();
    const m = layoutMap(ts, SIZE);
    expect(m.nodes).toHaveLength(ts.length);
    expect(sum(m.nodes)).toBeCloseTo(sum(ts), 10);
    for (const n of m.nodes) expect(n.usd).toBe(ts.find((t) => (t.agentId ?? MAIN_ID) === n.id)?.usd);
  });

  it("grows a node with what it spent", () => {
    const m = layoutMap(many(12), SIZE);
    const helpers = m.nodes.filter((n) => n.kind === "helper").sort((a, b) => a.usd - b.usd);
    for (let i = 1; i < helpers.length; i++) expect(helpers[i].r).toBeGreaterThanOrEqual(helpers[i - 1].r);
    expect(helpers[helpers.length - 1].r).toBeGreaterThan(helpers[0].r);
  });

  it("keeps a free helper a dot you can still hit", () => {
    const ts = [thread(null, null, 4), thread("free", null, 0), thread("big", null, 3)];
    const m = layoutMap(ts, SIZE);
    expect(m.nodes.find((n) => n.id === "free")?.r).toBeGreaterThanOrEqual(5);
  });
});

describe("helper map: one helper, none, and many", () => {
  it("draws the main chat alone when nothing ran", () => {
    const m = layoutMap([thread(null, null, 1)], SIZE);
    expect(m.nodes).toHaveLength(1);
    expect(m.links).toHaveLength(0);
    expect(m.nodes[0].x).toBe(SIZE.width / 2);
  });

  it("puts a single helper to the right of the main chat", () => {
    const m = layoutMap([thread(null, null, 1), thread("only", null, 1)], SIZE);
    const only = m.nodes.find((n) => n.id === "only");
    const root = m.nodes.find((n) => n.id === MAIN_ID);
    expect(only?.x).toBeGreaterThan(root?.x ?? 0);
    expect(Math.abs((only?.y ?? 0) - (root?.y ?? 0))).toBeLessThan(1);
  });

  it("draws up to the limit without folding anything", () => {
    const m = layoutMap(many(MAP_LIMIT), SIZE);
    expect(m.nodes).toHaveLength(MAP_LIMIT + 1);
    expect(m.nodes.some((n) => n.kind === "more")).toBe(false);
  });

  it("folds the smallest spenders into one +N node past the limit, and still adds up", () => {
    const ts = many(56);
    const m = layoutMap(ts, SIZE);
    const more = m.nodes.filter((n) => n.kind === "more");
    expect(more).toHaveLength(1);
    expect(m.nodes.filter((n) => n.kind !== "root").length).toBeLessThanOrEqual(MAP_LIMIT);
    expect(more[0].parentId).toBe(MAIN_ID);
    expect(more[0].hidden.length + m.nodes.filter((n) => n.kind === "helper").length).toBe(56);
    expect(sum(m.nodes)).toBeCloseTo(sum(ts), 10);
    // Everything kept spent more than everything folded.
    const keptMin = Math.min(...m.nodes.filter((n) => n.kind === "helper").map((n) => n.usd));
    expect(Math.max(...more[0].hidden.map((h) => h.usd))).toBeLessThanOrEqual(keptMin);
    expect(more[0].name).toBe(`${more[0].hidden.length} more helpers`);
  });

  it("never loses a helper to the fold: each is a node or inside exactly one +N node", () => {
    const ts = many(90);
    const m = layoutMap(ts, SIZE);
    const seen = new Map<string, number>();
    for (const n of m.nodes) {
      if (n.kind === "helper") seen.set(n.id, (seen.get(n.id) ?? 0) + 1);
      for (const h of n.hidden) seen.set(h.agentId as string, (seen.get(h.agentId as string) ?? 0) + 1);
    }
    expect(seen.size).toBe(90);
    expect([...seen.values()].every((c) => c === 1)).toBe(true);
  });

  it("keeps the starter of a big spender so the tree stays whole when folding", () => {
    // A cheap parent with an expensive child: the child must not float free.
    const ts = [thread(null, null, 1), thread("cheap-parent", null, 0.001), thread("big-child", "cheap-parent", 9), ...many(60).slice(1)];
    const m = layoutMap(ts, SIZE);
    const child = m.nodes.find((n) => n.id === "big-child");
    expect(child?.parentId).toBe("cheap-parent");
    expect(m.nodes.find((n) => n.id === "cheap-parent")).toBeTruthy();
    expect(sum(m.nodes)).toBeCloseTo(sum(ts), 10);
  });

  it("folds a nested overflow under its nearest drawn starter", () => {
    const kids = Array.from({ length: 45 }, (_, i) => thread(`k${i}`, "root-helper", 0.01 + i * 0.001));
    const ts = [thread(null, null, 1), thread("root-helper", null, 5), ...kids];
    const m = layoutMap(ts, SIZE);
    const more = m.nodes.find((n) => n.kind === "more");
    expect(more?.parentId).toBe("root-helper");
    expect(more?.id).toBe("more:root-helper");
    expect(sum(m.nodes)).toBeCloseTo(sum(ts), 10);
  });

  it("fold() keeps everything at or under the limit", () => {
    const hs = many(10).slice(1);
    const { kept, more } = fold(hs, startedBy(hs));
    expect(kept.size).toBe(10);
    expect(more.size).toBe(0);
  });
});

describe("helper map: picture", () => {
  it("keeps every node inside the frame", () => {
    for (const size of [{ width: 520, height: 360 }, { width: 900, height: 560 }, { width: 1400, height: 700 }]) {
      const m = layoutMap(many(30), size);
      for (const n of m.nodes) {
        expect(n.x - n.r).toBeGreaterThanOrEqual(0);
        expect(n.x + n.r).toBeLessThanOrEqual(size.width);
        expect(n.y - n.r).toBeGreaterThanOrEqual(0);
        expect(n.y + n.r).toBeLessThanOrEqual(size.height);
      }
    }
  });

  it("draws a link path from its parent to its child", () => {
    const m = layoutMap(nested(), SIZE);
    const by = new Map(m.nodes.map((n) => [n.id, n]));
    for (const l of m.links) {
      const from = by.get(l.from);
      const to = by.get(l.to);
      expect(l.d.startsWith(`M${Math.round((from?.x ?? 0) * 10) / 10} `)).toBe(true);
      expect(l.d.endsWith(`${Math.round((to?.y ?? 0) * 10) / 10}`)).toBe(true);
    }
  });

  it("orders the enter animation ring by ring from the main chat", () => {
    const m = layoutMap(nested(), SIZE);
    expect(m.nodes[0].id).toBe(MAIN_ID);
    expect(m.nodes.map((n) => n.index)).toEqual(m.nodes.map((_, i) => i));
    for (let i = 1; i < m.nodes.length; i++) expect(m.nodes[i].depth).toBeGreaterThanOrEqual(m.nodes[i - 1].depth);
  });
});
