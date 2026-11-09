import { describe, expect, it } from "vitest";
import { fold, layoutMap, MAIN_ID, MAP_LIMIT, MIN_ZOOM, NODE_GAP, pathTo, placePlate, plateSize, rectHitsCircle, startedBy, wrapName, zoomFor, type MapLayout } from "./helperMap";
import { modelFamily } from "./modelFamily";
import type { ReceiptThread } from "./types";

const KINDS = { output: 0, cacheWrite: 0, cacheRead: 0, input: 0, web: 0 };
const TOKEN_KINDS = { output: 0, cacheWrite: 0, input: 0, cacheRead: 0 };

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
    tokenKinds: TOKEN_KINDS,
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
    const m = layoutMap(many(12), SIZE, undefined, "usd");
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
    const m = layoutMap(ts, SIZE, undefined, "usd");
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

describe("helper map: tokens", () => {
  it("sizes and folds by tokens when asked, and carries each node's own tokens", () => {
    const ts = [thread(null, null, 1), thread("cheap-but-big", null, 0.01, { tokens: 900_000 }), thread("dear-but-small", null, 9, { tokens: 10 })];
    const m = layoutMap(ts, SIZE, undefined, "tokens");
    const big = m.nodes.find((n) => n.id === "cheap-but-big");
    const small = m.nodes.find((n) => n.id === "dear-but-small");
    expect(big?.tokens).toBe(900_000);
    expect(big?.r ?? 0).toBeGreaterThan(small?.r ?? 99);
    const byMoney = layoutMap(ts, SIZE, undefined, "usd");
    expect(byMoney.nodes.find((n) => n.id === "dear-but-small")?.r ?? 0).toBeGreaterThan(byMoney.nodes.find((n) => n.id === "cheap-but-big")?.r ?? 99);
    // The fold keeps the biggest by tokens.
    const hs = Array.from({ length: 6 }, (_, i) => thread(`h${i}`, null, 6 - i, { tokens: (i + 1) * 100 }));
    const { kept } = fold(hs, startedBy(hs), 3, "tokens");
    // Two kept and one "+N" node make the limit of three.
    expect([...kept].sort()).toEqual(["h4", "h5"]);
  });
});

describe("helper map: names", () => {
  it("wraps a name without ever dropping a character", () => {
    for (const name of ["Find the config", "x".repeat(70), "Review the migration of the usage cache schema and the receipt scan", "a b  c\td", ""]) {
      const lines = wrapName(name);
      expect(lines.join("").replace(/\s+/g, "")).toBe(name.replace(/\s+/g, ""));
      for (const l of lines) expect(l.length).toBeLessThanOrEqual(26);
    }
  });

  it("finds every node a plate that covers no bubble and stays on the canvas, in every kind of tree", () => {
    const named = (ts: ReceiptThread[]) => ts.map((t, i) => (i % 3 === 0 ? { ...t, name: `${t.name} - read the whole usage module and report what it does` } : t));
    const sets: ReceiptThread[][] = [nested(), many(1), many(6), many(12), named(many(30)), named(many(MAP_LIMIT)), named(many(90))];
    for (const ts of sets) {
      for (const size of [{ width: 900, height: 560 }, { width: 1280, height: 640 }]) {
        const m: MapLayout = layoutMap(ts, size, undefined, "tokens");
        for (const n of m.nodes) {
          const p = placePlate(m, n.id, "12.4M tokens, finished");
          expect(p).not.toBeNull();
          if (!p) continue;
          for (const o of m.nodes) expect(rectHitsCircle(p, o)).toBe(false);
          expect(p.x).toBeGreaterThanOrEqual(0);
          expect(p.y).toBeGreaterThanOrEqual(0);
          expect(p.x + p.w).toBeLessThanOrEqual(m.width);
          expect(p.y + p.h).toBeLessThanOrEqual(m.height);
          // The plate holds the whole name.
          expect(p.lines.join("").replace(/\s+/g, "")).toBe(n.name.replace(/\s+/g, ""));
          expect(p.w).toBeGreaterThanOrEqual(plateSize(n.name, "").w);
        }
      }
    }
  });
});

describe("model families", () => {
  it("tells the families apart by name, and calls the rest other", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("opus");
    expect(modelFamily("claude-sonnet-5-5")).toBe("sonnet");
    expect(modelFamily("claude-haiku-5-5")).toBe("haiku");
    expect(modelFamily("claude-fable-5-1")).toBe("fable");
    expect(modelFamily("gpt-whatever")).toBe("other");
    expect(modelFamily("")).toBe("other");
    expect(modelFamily(null)).toBe("other");
  });
});

describe("helper map: picture", () => {
  it("keeps every node inside the canvas, and the canvas is never smaller than the pane", () => {
    for (const size of [{ width: 520, height: 360 }, { width: 900, height: 560 }, { width: 1400, height: 700 }]) {
      for (const n of [1, 5, 30, 40, 90]) {
        const m = layoutMap(many(n), size);
        expect(m.width).toBeGreaterThanOrEqual(size.width);
        expect(m.height).toBeGreaterThanOrEqual(size.height);
        for (const node of m.nodes) {
          expect(node.x - node.r).toBeGreaterThanOrEqual(0);
          expect(node.x + node.r).toBeLessThanOrEqual(m.width);
          expect(node.y - node.r).toBeGreaterThanOrEqual(0);
          expect(node.y + node.r).toBeLessThanOrEqual(m.height);
        }
      }
    }
  });

  it("never lets two bubbles touch: every pair keeps the gap, from one helper to a folded crowd", () => {
    const sets: ReceiptThread[][] = [nested(), many(1), many(2), many(3), many(8), many(9), many(17), many(30), many(MAP_LIMIT), many(90)];
    // Equal helpers are the tightest case: every bubble is as big as it gets.
    sets.push([thread(null, null, 1), ...Array.from({ length: 24 }, (_, i) => thread(`e${i}`, null, 1))]);
    for (const ts of sets) {
      for (const size of [{ width: 900, height: 560 }, { width: 1280, height: 640 }]) {
        const m = layoutMap(ts, size);
        for (let i = 0; i < m.nodes.length; i++) {
          for (let j = i + 1; j < m.nodes.length; j++) {
            const a = m.nodes[i];
            const b = m.nodes[j];
            const gap = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
            expect(gap).toBeGreaterThanOrEqual(NODE_GAP - 0.5);
          }
        }
      }
    }
  });

  it("puts a plate inside what the pane shows when a bubble sits at the edge of the view", () => {
    const m = layoutMap(many(MAP_LIMIT), { width: 738, height: 551 }, undefined, "tokens");
    // A pane showing the middle of a canvas bigger than itself.
    const view = { x: (m.width - 738) / 2, y: (m.height - 551) / 2, w: 738, h: 551 };
    const inView = (n: { x: number; y: number }) => n.x > view.x && n.x < view.x + view.w && n.y > view.y + 20 && n.y < view.y + view.h - 20;
    let checked = 0;
    for (const n of m.nodes.filter(inView)) {
      const p = placePlate(m, n.id, "12.4M tokens, finished", view);
      expect(p).not.toBeNull();
      if (!p) continue;
      for (const o of m.nodes) expect(rectHitsCircle(p, o)).toBe(false);
      // Every bubble in view has a plate in view, top edge included.
      expect(p.y).toBeGreaterThanOrEqual(view.y);
      expect(p.y + p.h).toBeLessThanOrEqual(view.y + view.h);
      expect(p.x).toBeGreaterThanOrEqual(view.x);
      expect(p.x + p.w).toBeLessThanOrEqual(view.x + view.w);
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });

  it("keeps every plate inside a zoomed-out pane, right edge included (101-helper chat)", () => {
    const pane = { width: 738, height: 551 };
    const m = layoutMap(many(101), pane, undefined, "tokens");
    const z = zoomFor(m, pane);
    const view = { x: 0, y: 0, w: pane.width / z, h: pane.height / z };
    for (const n of m.nodes) {
      if (n.x > view.x + view.w || n.y > view.y + view.h) continue;
      const p = placePlate(m, n.id, "12.4M tokens, finished", view, z)!;
      expect(p.x).toBeGreaterThanOrEqual(view.x);
      expect(p.y).toBeGreaterThanOrEqual(view.y);
      expect(p.x + p.w).toBeLessThanOrEqual(view.x + view.w + 0.01);
      expect(p.y + p.h).toBeLessThanOrEqual(view.y + view.h + 0.01);
    }
  });

  it("zooms a big tree out a little, never below the floor, and a plate then takes more canvas so it reads at full size", () => {
    const pane = { width: 410, height: 369 };
    const m = layoutMap(many(MAP_LIMIT), pane, undefined, "tokens");
    const z = zoomFor(m, pane);
    expect(z).toBe(MIN_ZOOM);
    expect(zoomFor({ width: 300, height: 200 }, pane)).toBe(1);
    const node = m.nodes.find((n) => n.kind === "helper");
    expect(node).toBeDefined();
    const at1 = placePlate(m, node!.id, "12.4M tokens, finished");
    const atZ = placePlate(m, node!.id, "12.4M tokens, finished", undefined, z);
    expect(atZ!.w).toBeCloseTo(at1!.w / z, 5);
    for (const o of m.nodes) expect(rectHitsCircle(atZ!, o)).toBe(false);
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
