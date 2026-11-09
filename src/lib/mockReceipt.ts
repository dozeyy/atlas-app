// Stand-in receipt for a plain browser and for tests. Deterministic and invented: it follows the
// same rules as the real one (every view's lines plus "everything else" add up to the chat's
// cost), so the screens can be built and tested without the desktop shell.

import type {
  Outcome,
  Receipt,
  ReceiptFlag,
  ReceiptItem,
  ReceiptKinds,
  ReceiptModel,
  ReceiptThread,
  ReceiptTokenKinds,
  Tokens,
} from "./types";

export interface MockThread {
  agentId: string | null;
  name: string;
  parentAgentId: string | null;
  spawnDepth: number;
  model: string;
  tokens: Tokens;
  messages: number;
  toolCalls: number;
  durationMs: number;
}

/** USD per million tokens: input, output (cache writes cost 1.25x input, reads 0.1x). */
export type MockRates = Record<string, [number, number]>;

const OUTCOMES: (Outcome | null)[] = ["finished", "finished", "errored", "finished", "stopped", null];

const POOL: { tool: string; path: string | null; kind: ReceiptItem["kind"] }[] = [
  { tool: "Read", path: "docs/tech.md", kind: "read" },
  { tool: "Bash", path: null, kind: "output" },
  { tool: "Read", path: "src/App.tsx", kind: "read" },
  { tool: "Grep", path: null, kind: "outputs" },
  { tool: "Read", path: "crates/core/src/usage/mod.rs", kind: "read" },
];

export function mockKinds(model: string, t: Tokens, rates: MockRates): ReceiptKinds {
  const [i, o] = rates[model] ?? [0, 0];
  return {
    output: (t.output * o) / 1e6,
    cacheWrite: (t.cacheWrite5m * i * 1.25) / 1e6,
    cacheRead: (t.cacheRead * i * 0.1) / 1e6,
    input: (t.input * i) / 1e6,
    web: 0,
  };
}

export const mockTokenKinds = (t: Tokens): ReceiptTokenKinds => ({
  output: t.output,
  cacheWrite: t.cacheWrite5m + t.cacheWrite1h,
  input: t.input,
  cacheRead: t.cacheRead,
});

const sumKinds = (k: ReceiptKinds) => k.output + k.cacheWrite + k.cacheRead + k.input + k.web;

function addKinds(a: ReceiptKinds, b: ReceiptKinds): ReceiptKinds {
  return {
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    input: a.input + b.input,
    web: a.web + b.web,
  };
}

function itemsFor(k: number, name: string, spend: number, bigMain: boolean): ReceiptItem[] {
  return [0, 1].map((n) => {
    const p = POOL[(k + n * 2) % POOL.length];
    const count = bigMain && n === 0 ? 7 : p.kind === "read" ? 1 + ((k + n) % 4) : p.kind === "outputs" ? 6 + k : 1;
    const per = p.kind === "output" ? 48_000 : 4000 * (1 + ((k * 3 + n) % 5));
    return {
      kind: p.kind,
      tool: p.tool,
      path: p.path,
      count,
      tokens: p.kind === "output" ? per : per * count,
      usd: spend * (n === 0 ? 0.11 : 0.05),
      thread: name,
    };
  });
}

export function buildMockReceipt(sessionId: string, totalUsd: number, main: MockThread, helpers: MockThread[], rates: MockRates): Receipt {
  const all = [main, ...helpers];
  const threads: ReceiptThread[] = all.map((t, k) => {
    const kinds = mockKinds(t.model, t.tokens, rates);
    const usd = sumKinds(kinds);
    const bigMain = k === 0 && t.messages >= 40;
    const items = itemsFor(k, t.name, kinds.cacheWrite + kinds.cacheRead, bigMain);
    const flags: ReceiptFlag[] = [];
    if (bigMain) {
      flags.push({ kind: "repeat_read", label: "docs/tech.md", agentId: null, count: 7, tokens: items[0].tokens, usd: items[0].usd, minutes: null, model: null, tools: [] });
    }
    if (k > 0 && t.model.includes("opus") && t.tokens.output < 10_000) {
      flags.push({ kind: "heavy_helper", label: t.name, agentId: t.agentId, count: t.toolCalls, tokens: t.tokens.total, usd, minutes: null, model: t.model, tools: ["Read", "Grep"] });
    }
    return {
      agentId: t.agentId,
      name: t.name,
      parentAgentId: t.parentAgentId,
      spawnDepth: t.spawnDepth,
      model: t.model,
      usd,
      tokens: t.tokens.total,
      cacheReadTokens: t.tokens.cacheRead,
      messages: t.messages,
      durationMs: t.durationMs,
      toolCalls: t.toolCalls,
      kinds,
      tokenKinds: mockTokenKinds(t.tokens),
      models: [{ model: t.model, usd, tokens: t.tokens.total }],
      outcome: k === 0 ? null : OUTCOMES[(k - 1) % OUTCOMES.length],
      items,
      itemsOtherUsd: usd - items.reduce((s, i) => s + (i.usd ?? 0), 0),
      flags,
      unpricedTokens: 0,
    };
  });

  const byModel = new Map<string, ReceiptModel>();
  for (const t of threads) {
    for (const m of t.models) {
      const cur = byModel.get(m.model) ?? { model: m.model, usd: 0, tokens: 0 };
      byModel.set(m.model, { model: m.model, usd: cur.usd + m.usd, tokens: cur.tokens + m.tokens });
    }
  }
  const models = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  const kinds = threads.reduce((k, t) => addKinds(k, t.kinds), { output: 0, cacheWrite: 0, cacheRead: 0, input: 0, web: 0 });

  // A file read in several places is one line; one tool's big output stays with its thread.
  const merged = new Map<string, ReceiptItem & { owners: Set<string> }>();
  for (const t of threads) {
    for (const i of t.items) {
      const key = i.kind === "read" ? `read|${i.path}` : `${i.kind}|${i.tool}|${t.name}`;
      const cur = merged.get(key);
      if (cur) {
        cur.count += i.count;
        cur.tokens += i.tokens;
        cur.usd = (cur.usd ?? 0) + (i.usd ?? 0);
        cur.owners.add(t.name);
      } else merged.set(key, { ...i, owners: new Set([t.name]) });
    }
  }
  const items: ReceiptItem[] = [...merged.values()]
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    .slice(0, 8)
    .map(({ owners, ...i }) => ({ ...i, thread: owners.size === 1 ? [...owners][0] : null }));

  const flags = threads
    .flatMap((t) => t.flags)
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    .slice(0, 6);

  return {
    sessionId,
    totalUsd,
    complete: true,
    scanned: true,
    threads,
    threadsOtherUsd: totalUsd - threads.reduce((s, t) => s + t.usd, 0),
    models,
    modelsOtherUsd: totalUsd - models.reduce((s, m) => s + m.usd, 0),
    kinds,
    kindsOtherUsd: totalUsd - sumKinds(kinds),
    totalTokens: threads.reduce((s, t) => s + t.tokens, 0),
    tokenKinds: threads.reduce(
      (k, t) => ({ output: k.output + t.tokenKinds.output, cacheWrite: k.cacheWrite + t.tokenKinds.cacheWrite, input: k.input + t.tokenKinds.input, cacheRead: k.cacheRead + t.tokenKinds.cacheRead }),
      { output: 0, cacheWrite: 0, input: 0, cacheRead: 0 },
    ),
    items,
    itemsOtherUsd: totalUsd - items.reduce((s, i) => s + (i.usd ?? 0), 0),
    flags,
  };
}
