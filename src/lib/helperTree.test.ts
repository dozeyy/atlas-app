import { describe, expect, it } from "vitest";
import { helperTree } from "./helperTree";
import type { AgentSummary } from "./types";

function agent(id: string, parent: string | null = null): AgentSummary {
  return {
    agentId: id,
    name: id,
    nameSource: "fallback",
    agentType: null,
    description: null,
    toolUseId: null,
    parentAgentId: parent,
    spawnDepth: parent ? 2 : 1,
    model: "m",
    models: ["m"],
    messages: 1,
    tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 0, webSearch: 0, webFetch: 0 },
    cost: { usd: null, complete: true, unpricedTokens: 0 },
    startedAt: 0,
    endedAt: 0,
    durationMs: 0,
    toolCalls: 0,
    missing: false,
  } as AgentSummary;
}

describe("helperTree", () => {
  it("hangs a helper under the one that started it and numbers in reading order", () => {
    const roots = helperTree([agent("a"), agent("b", "a"), agent("c"), agent("d", "b")]);
    expect(roots.map((r) => r.agent.agentId)).toEqual(["a", "c"]);
    expect(roots[0].kids.map((k) => k.agent.agentId)).toEqual(["b"]);
    expect(roots[0].kids[0].kids.map((k) => k.agent.agentId)).toEqual(["d"]);
    expect(roots[0].index).toBe(0);
    expect(roots[0].kids[0].index).toBe(1);
    expect(roots[0].kids[0].kids[0].index).toBe(2);
    expect(roots[1].index).toBe(3);
  });

  it("treats a helper whose starter is unknown as a root", () => {
    const roots = helperTree([agent("x", "ghost")]);
    expect(roots).toHaveLength(1);
    expect(roots[0].agent.agentId).toBe("x");
  });

  it("does not lose helpers that point at each other", () => {
    const roots = helperTree([agent("p", "q"), agent("q", "p")]);
    const seen: string[] = [];
    const walk = (list: typeof roots) =>
      list.forEach((n) => {
        seen.push(n.agent.agentId);
        walk(n.kids);
      });
    walk(roots);
    expect(seen.sort()).toEqual(["p", "q"]);
  });

  it("is empty for no helpers", () => {
    expect(helperTree([])).toEqual([]);
  });
});
