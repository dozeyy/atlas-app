// Pure: the helper map. The main chat sits in the middle and every helper hangs from the thread
// that started it, ring by ring. A node grows with what it spent. No React here.
//
// What this must get right (tests in helperMap.test.ts): every link is a real "started by"
// relation, every thread is exactly one node (or sits inside exactly one "+N" node), and the
// spend of all nodes adds up to the chat.

import type { Outcome, ReceiptThread } from "./types";

/** Helpers drawn before the rest fold into "+N" nodes. */
export const MAP_LIMIT = 40;

export const MAIN_ID = "main";

export interface MapNode {
  /** `main`, a helper's id, or `more:<starter id>` for the folded ones. */
  id: string;
  kind: "root" | "helper" | "more";
  name: string;
  /** What this thread spent on its own (a "+N" node: what the folded ones spent together). */
  usd: number;
  depth: number;
  parentId: string | null;
  outcome: Outcome | null;
  thread: ReceiptThread | null;
  /** A "+N" node: the helpers folded into it, biggest spender first. */
  hidden: ReceiptThread[];
  x: number;
  y: number;
  r: number;
  /** Radians, 0 = right. */
  angle: number;
  /** Order of appearance: ring by ring, sweeping around. */
  index: number;
}

export interface MapLink {
  id: string;
  from: string;
  to: string;
  /** Cubic path in the same pixels as the nodes. */
  d: string;
}

export interface MapLayout {
  nodes: MapNode[];
  links: MapLink[];
  width: number;
  height: number;
}

const R_MIN = 5;
const ROOT_MIN = 16;
const RING_FIRST = 58;
const RING_PER_NODE = 14;
const RING_MAX = 260;
const LABEL_ROOM = 96;
const EDGE_ROOM = 34;
const MAX_ASPECT = 1.7;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Whom each helper hangs from. A starter that is not in the list, is the helper itself, or leads
 * back around to it would lose the helper; such a helper hangs from the main chat instead.
 */
export function startedBy(helpers: ReceiptThread[]): Map<string, string | null> {
  const ids = new Set(helpers.map((h) => h.agentId as string));
  const raw = new Map(helpers.map((h) => [h.agentId as string, h.parentAgentId]));
  const out = new Map<string, string | null>();
  for (const h of helpers) {
    const id = h.agentId as string;
    let at = h.parentAgentId;
    let ok = at !== null && ids.has(at);
    for (let hops = 0; ok && at !== null && hops <= helpers.length; hops++) {
      if (at === id) ok = false;
      at = raw.get(at) ?? null;
    }
    out.set(id, ok && h.parentAgentId !== id ? h.parentAgentId : null);
  }
  return out;
}

interface Folded {
  kept: Set<string>;
  /** Starter id (null = the main chat) -> the helpers folded under it. */
  more: Map<string | null, ReceiptThread[]>;
}

/**
 * Keep the biggest spenders (with the helpers that started them, so the tree stays whole) and
 * fold the rest into one "+N" node under the nearest kept starter. At most `limit` nodes are
 * drawn besides the main chat.
 */
export function fold(helpers: ReceiptThread[], parents: Map<string, string | null>, limit = MAP_LIMIT): Folded {
  const everyone = new Set(helpers.map((h) => h.agentId as string));
  if (helpers.length <= limit) return { kept: everyone, more: new Map() };

  const order = new Map(helpers.map((h, i) => [h.agentId as string, i]));
  const bySpend = [...helpers].sort((a, b) => b.usd - a.usd || (order.get(a.agentId as string) ?? 0) - (order.get(b.agentId as string) ?? 0));

  const group = (kept: Set<string>) => {
    const more = new Map<string | null, ReceiptThread[]>();
    for (const h of bySpend) {
      const id = h.agentId as string;
      if (kept.has(id)) continue;
      let at = parents.get(id) ?? null;
      while (at !== null && !kept.has(at)) at = parents.get(at) ?? null;
      const list = more.get(at) ?? [];
      list.push(h);
      more.set(at, list);
    }
    return more;
  };
  for (let budget = limit; budget >= 1; budget--) {
    const kept = new Set<string>();
    for (const h of bySpend) {
      const id = h.agentId as string;
      if (kept.has(id)) continue;
      const chain = [id];
      for (let at = parents.get(id) ?? null; at !== null && !kept.has(at); at = parents.get(at) ?? null) chain.push(at);
      if (kept.size + chain.length <= budget) chain.forEach((c) => kept.add(c));
    }
    const more = group(kept);
    if (kept.size + more.size <= limit) return { kept, more };
  }
  return { kept: new Set(), more: group(new Set()) };
}

const outcomeOf = (t: ReceiptThread): Outcome | null => t.outcome;

/** Lay the threads out inside `width` x `height` pixels. */
export function layoutMap(threads: ReceiptThread[], size: { width: number; height: number }, limit = MAP_LIMIT): MapLayout {
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  const main = threads.find((t) => t.agentId === null) ?? threads[0];
  const helpers = threads.filter((t) => t.agentId !== null);
  const parents = startedBy(helpers);
  const { kept, more } = fold(helpers, parents, limit);

  const nodes = new Map<string, MapNode>();
  const kids = new Map<string, string[]>();
  const add = (n: Omit<MapNode, "x" | "y" | "r" | "angle" | "index">) => {
    nodes.set(n.id, { ...n, x: 0, y: 0, r: R_MIN, angle: 0, index: 0 });
    if (n.parentId !== null) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id]);
  };

  add({
    id: MAIN_ID,
    kind: "root",
    name: main?.name ?? "Main chat",
    usd: main?.usd ?? 0,
    depth: 0,
    parentId: null,
    outcome: null,
    thread: main ?? null,
    hidden: [],
  });
  // Parents come before their children in start order, but do not rely on it.
  const depthOf = (id: string): number => {
    let d = 1;
    for (let at = parents.get(id) ?? null; at !== null && kept.has(at); at = parents.get(at) ?? null) d++;
    return d;
  };
  const keptHelpers = helpers.filter((h) => kept.has(h.agentId as string)).sort((a, b) => depthOf(a.agentId as string) - depthOf(b.agentId as string));
  for (const h of keptHelpers) {
    const id = h.agentId as string;
    const p = parents.get(id) ?? null;
    add({
      id,
      kind: "helper",
      name: h.name,
      usd: h.usd,
      depth: depthOf(id),
      parentId: p !== null && kept.has(p) ? p : MAIN_ID,
      outcome: outcomeOf(h),
      thread: h,
      hidden: [],
    });
  }
  // Children in the order the helpers started.
  const startOrder = new Map(helpers.map((h, i) => [h.agentId as string, i]));
  for (const list of kids.values()) list.sort((a, b) => (startOrder.get(a) ?? -1) - (startOrder.get(b) ?? -1));
  for (const [starter, list] of more) {
    const parentId = starter ?? MAIN_ID;
    const parent = nodes.get(parentId);
    add({
      id: `more:${parentId}`,
      kind: "more",
      name: `${list.length} more ${list.length === 1 ? "helper" : "helpers"}`,
      usd: list.reduce((s, t) => s + t.usd, 0),
      depth: (parent?.depth ?? 0) + 1,
      parentId,
      outcome: null,
      thread: null,
      hidden: list,
    });
  }

  // Angles: each node owns a wedge, split among its children by how many leaves they carry.
  const leaves = new Map<string, number>();
  const count = (id: string): number => {
    const c = kids.get(id) ?? [];
    const n = c.length === 0 ? 1 : c.reduce((s, k) => s + count(k), 0);
    leaves.set(id, n);
    return n;
  };
  count(MAIN_ID);
  const wedge = (id: string, a0: number, a1: number) => {
    const n = nodes.get(id) as MapNode;
    n.angle = (a0 + a1) / 2;
    const c = kids.get(id) ?? [];
    const total = c.reduce((s, k) => s + (leaves.get(k) ?? 1), 0);
    let at = a0;
    for (const k of c) {
      const span = ((a1 - a0) * (leaves.get(k) ?? 1)) / total;
      wedge(k, at, at + span);
      at += span;
    }
  };
  wedge(MAIN_ID, -Math.PI, Math.PI);

  // Rings: spaced for how many nodes sit on them, then shrunk to fit the room.
  const all = [...nodes.values()];
  const deepest = all.reduce((m, n) => Math.max(m, n.depth), 0);
  const perRing = Array.from({ length: deepest + 1 }, (_, k) => all.filter((n) => n.depth === k).length);
  const reach: number[] = [0];
  for (let k = 1; k <= deepest; k++) reach[k] = reach[k - 1] + Math.min(RING_MAX, RING_FIRST + RING_PER_NODE * perRing[k]);

  const ry = Math.max(40, height / 2 - EDGE_ROOM);
  const rx = Math.max(40, Math.min(width / 2 - LABEL_ROOM, ry * MAX_ASPECT));
  const ratio = rx / ry;
  const fit = deepest > 0 ? Math.min(1, ry / reach[deepest]) : 1;
  const cx = width / 2;
  const cy = height / 2;
  const at = (angle: number, rho: number) => ({ x: cx + rho * ratio * Math.cos(angle), y: cy + rho * Math.sin(angle) });

  // Sizes: the biggest helper gets the most room its ring allows; everyone else by the square
  // root of their spend (area follows spend), never below a dot you can still hit.
  let spacing = Infinity;
  for (let k = 1; k <= deepest; k++) {
    const mean = (reach[k] * fit * (1 + ratio)) / 2;
    spacing = Math.min(spacing, (2 * Math.PI * mean) / Math.max(1, perRing[k]));
  }
  const cap = clamp(0.42 * spacing, 8, 24);
  const rootCap = clamp(deepest > 0 ? 0.45 * reach[1] * fit : 30, ROOT_MIN, 30);
  const maxHelper = all.filter((n) => n.kind !== "root").reduce((m, n) => Math.max(m, n.usd), 0);
  const total = all.reduce((s, n) => s + n.usd, 0);

  for (const n of all) {
    const rho = reach[n.depth] * fit;
    const p = at(n.angle, rho);
    n.x = p.x;
    n.y = p.y;
    n.r =
      n.kind === "root"
        ? ROOT_MIN + (rootCap - ROOT_MIN) * Math.sqrt(total > 0 ? n.usd / total : 0)
        : R_MIN + (cap - R_MIN) * Math.sqrt(maxHelper > 0 ? n.usd / maxHelper : 0);
  }

  const ranked = [...all].sort((a, b) => a.depth - b.depth || a.angle - b.angle);
  ranked.forEach((n, i) => (n.index = i));

  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  const links: MapLink[] = [];
  for (const n of all) {
    if (n.parentId === null) continue;
    const p = nodes.get(n.parentId) as MapNode;
    const rp = reach[p.depth] * fit;
    const rc = reach[n.depth] * fit;
    const mid = (rp + rc) / 2;
    const a = at(p.kind === "root" ? n.angle : p.angle, mid);
    const b = at(n.angle, mid);
    links.push({ id: `${p.id}>${n.id}`, from: p.id, to: n.id, d: `M${f(p.x)} ${f(p.y)}C${f(a.x)} ${f(a.y)} ${f(b.x)} ${f(b.y)} ${f(n.x)} ${f(n.y)}` });
  }
  return { nodes: ranked, links, width, height };
}

/** The ids from the main chat down to `id`: what lights up when you point at a node. */
export function pathTo(layout: MapLayout, id: string): Set<string> {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (let at = byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) out.add(at.id);
  return out;
}
