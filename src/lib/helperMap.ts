// Pure: the helper map. The main chat sits in the middle and every helper hangs from the thread
// that started it, ring by ring. A node grows with what it spent. No React here.
//
// What this must get right (tests in helperMap.test.ts): every link is a real "started by"
// relation, every thread is exactly one node (or sits inside exactly one "+N" node), the nodes
// add up to the chat, no two nodes touch, and a name plate can always be put where it covers no
// other node.
//
// The picture is as big as it needs to be: when there are too many nodes for the room, the
// canvas grows past the pane and the pane scrolls, rather than squeezing the nodes together.

import type { Outcome, ReceiptThread } from "./types";

/** Helpers drawn before the rest fold into "+N" nodes. */
export const MAP_LIMIT = 40;

export const MAIN_ID = "main";

/** What a node's size follows: money, or the tokens the app leads with everywhere else. */
export type Metric = "usd" | "tokens";

export const weightOf = (t: Pick<ReceiptThread, "usd" | "tokens">, by: Metric): number => (by === "usd" ? t.usd : t.tokens);

export interface MapNode {
  /** `main`, a helper's id, or `more:<starter id>` for the folded ones. */
  id: string;
  kind: "root" | "helper" | "more";
  name: string;
  /** What this thread spent on its own (a "+N" node: what the folded ones spent together). */
  usd: number;
  /** Same, in tokens (the headline kind: cache reads are listed apart). */
  tokens: number;
  depth: number;
  parentId: string | null;
  outcome: Outcome | null;
  thread: ReceiptThread | null;
  /** A "+N" node: the helpers folded into it, biggest first. */
  hidden: ReceiptThread[];
  x: number;
  y: number;
  r: number;
  /** Radians, 0 = right. */
  angle: number;
  /** Distance from the middle before the picture is stretched. */
  rho: number;
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
  /** The canvas: at least the pane, bigger when the nodes need the room. */
  width: number;
  height: number;
}

/** Bubble radii: the smallest still holds a 20 px icon, the biggest is a helper that did the most. */
export const R_MIN = 17;
export const R_MAX = 27;
export const ROOT_R = 30;
/** Clear space between two neighbouring bubbles, edge to edge. */
export const NODE_GAP = 24;
const RING_FIRST_MIN = 104;
const RING_STEP_MIN = 92;
/** A crowded ring is dealt out over up to this many staggered tracks, a bubble and a gap apart. */
const MAX_TRACKS = 4;
const TRACK_STEP = 2 * R_MAX + NODE_GAP;
/** What a name plate can be, so the canvas keeps room beyond the outer bubbles for one. */
const CHAR_W = 7; // generous width of one 12 px character
const LINE_H = 16;
const PAD_X = 10;
const PAD_Y = 8;
const WRAP_AT = 26;
const PLATE_MAX_W = WRAP_AT * CHAR_W + PAD_X * 2;
const PLATE_ROOM_H = LINE_H * 5 + PAD_Y * 2; // four lines of name and the detail
const MARGIN_X = PLATE_MAX_W + 24;
const MARGIN_Y = PLATE_ROOM_H + 24;
/** A few helpers are spread out to use the pane, but never past this stretch. */
const MAX_SCALE = 1.6;
const MAX_ASPECT = 1.6;

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
 * Keep the biggest helpers (with the helpers that started them, so the tree stays whole) and
 * fold the rest into one "+N" node under the nearest kept starter. At most `limit` nodes are
 * drawn besides the main chat.
 */
export function fold(helpers: ReceiptThread[], parents: Map<string, string | null>, limit = MAP_LIMIT, by: Metric = "tokens"): Folded {
  const everyone = new Set(helpers.map((h) => h.agentId as string));
  if (helpers.length <= limit) return { kept: everyone, more: new Map() };

  const order = new Map(helpers.map((h, i) => [h.agentId as string, i]));
  const bySize = [...helpers].sort((a, b) => weightOf(b, by) - weightOf(a, by) || (order.get(a.agentId as string) ?? 0) - (order.get(b.agentId as string) ?? 0));

  const group = (kept: Set<string>) => {
    const more = new Map<string | null, ReceiptThread[]>();
    for (const h of bySize) {
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
    for (const h of bySize) {
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

/**
 * Lay the threads out for a pane of `size`. Nodes sized by `by` (tokens by default: the unit the
 * rest of the app leads with). The result's width and height are the canvas: never smaller than
 * the pane, and larger when the nodes need more room than the pane has.
 */
export function layoutMap(threads: ReceiptThread[], size: { width: number; height: number }, limit = MAP_LIMIT, by: Metric = "tokens"): MapLayout {
  const paneW = Math.max(1, Math.round(size.width));
  const paneH = Math.max(1, Math.round(size.height));
  const main = threads.find((t) => t.agentId === null); // never a helper: each thread is one node
  const helpers = threads.filter((t) => t.agentId !== null);
  const parents = startedBy(helpers);
  const { kept, more } = fold(helpers, parents, limit, by);

  const nodes = new Map<string, MapNode>();
  const kids = new Map<string, string[]>();
  const add = (n: Omit<MapNode, "x" | "y" | "r" | "angle" | "rho" | "index">) => {
    nodes.set(n.id, { ...n, x: 0, y: 0, r: R_MIN, angle: 0, rho: 0, index: 0 });
    if (n.parentId !== null) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n.id]);
  };

  add({
    id: MAIN_ID,
    kind: "root",
    name: main?.name ?? "Main chat",
    usd: main?.usd ?? 0,
    tokens: main?.tokens ?? 0,
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
      tokens: h.tokens,
      depth: depthOf(id),
      parentId: p !== null && kept.has(p) ? p : MAIN_ID,
      outcome: h.outcome,
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
      tokens: list.reduce((s, t) => s + t.tokens, 0),
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

  // Sizes: a bubble grows with the square root of what it did (area follows the figure), between
  // the smallest that holds an icon and the biggest we allow. The main chat has one fixed size.
  const all = [...nodes.values()];
  const w = (n: MapNode) => (by === "usd" ? n.usd : n.tokens);
  const maxHelper = all.filter((n) => n.kind === "helper").reduce((m, n) => Math.max(m, w(n)), 0);
  for (const n of all) {
    if (n.kind === "root") n.r = ROOT_R;
    else n.r = clamp(R_MIN + (R_MAX - R_MIN) * Math.sqrt(maxHelper > 0 ? w(n) / maxHelper : 0), R_MIN, R_MAX);
  }

  // Rings: each depth is a ring. A ring with many bubbles is dealt out over a few staggered tracks
  // (every other bubble a track further out) so it needs a smaller radius; the radius is the
  // smallest at which bubbles that share a track keep the gap, measured from the real angles.
  const deepest = all.reduce((m, n) => Math.max(m, n.depth), 0);
  let outer = 0;
  for (let k = 1; k <= deepest; k++) {
    const ring = all.filter((n) => n.depth === k).sort((x, y) => x.angle - y.angle);
    const floor = k === 1 ? RING_FIRST_MIN : outer + RING_STEP_MIN;
    let best = { tracks: 1, base: floor, outer: Infinity };
    for (let tracks = 1; tracks <= Math.min(MAX_TRACKS, Math.max(1, ring.length)); tracks++) {
      // The closest two bubbles on one track (bubble i is on track i % tracks; the seam where
      // the last meets the first counts too).
      let gap = 2 * Math.PI;
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        for (let step = 1; step < n; step++) {
          const j = (i + step) % n;
          if (j % tracks !== i % tracks) continue;
          const d = j > i ? ring[j].angle - ring[i].angle : ring[j].angle + 2 * Math.PI - ring[i].angle;
          gap = Math.min(gap, d);
          break;
        }
      }
      const need = TRACK_STEP / (2 * Math.sin(Math.min(gap / 2, Math.PI / 2)));
      const base = Math.max(floor, need);
      const reachOut = base + (tracks - 1) * TRACK_STEP;
      // The fewest tracks that reach the smallest outer edge: the inner track then sits close in.
      if (reachOut < best.outer) best = { tracks, base, outer: reachOut };
    }
    ring.forEach((n, i) => (n.rho = best.base + (i % best.tracks) * TRACK_STEP));
    outer = best.outer;
  }
  const needed = deepest > 0 ? outer : 0;

  // A short tree is stretched to use the pane (never past MAX_SCALE); a big one stays at its
  // natural size and the canvas grows.
  const roomY = Math.max(1, paneH / 2 - MARGIN_Y - R_MAX);
  const roomX = Math.max(1, paneW / 2 - MARGIN_X - R_MAX);
  const scale = deepest > 0 ? clamp(Math.min(roomX, roomY) / needed, 1, MAX_SCALE) : 1;
  const ratio = deepest > 0 && scale > 1 ? clamp(roomX / (needed * scale), 1, MAX_ASPECT) : 1;
  const extentX = needed * scale * ratio + R_MAX + MARGIN_X;
  const extentY = needed * scale + R_MAX + MARGIN_Y;
  const width = Math.max(paneW, Math.ceil(2 * extentX));
  const height = Math.max(paneH, Math.ceil(2 * extentY));
  const cx = width / 2;
  const cy = height / 2;
  const at = (angle: number, rho: number) => ({ x: cx + rho * scale * ratio * Math.cos(angle), y: cy + rho * scale * Math.sin(angle) });

  for (const n of all) {
    const p = at(n.angle, n.rho);
    n.x = p.x;
    n.y = p.y;
  }

  const ranked = [...all].sort((a, b) => a.depth - b.depth || a.angle - b.angle);
  ranked.forEach((n, i) => (n.index = i));

  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  const links: MapLink[] = [];
  for (const n of all) {
    if (n.parentId === null) continue;
    const p = nodes.get(n.parentId) as MapNode;
    const mid = (p.rho + n.rho) / 2;
    const a = at(p.kind === "root" ? n.angle : p.angle, mid);
    const b = at(n.angle, mid);
    links.push({ id: `${p.id}>${n.id}`, from: p.id, to: n.id, d: `M${f(p.x)} ${f(p.y)}C${f(a.x)} ${f(a.y)} ${f(b.x)} ${f(b.y)} ${f(n.x)} ${f(n.y)}` });
  }
  return { nodes: ranked, links, width, height };
}

/** How far a big tree is zoomed out so the pane shows more of it: never below this, so a bubble stays readable. */
export const MIN_ZOOM = 0.7;

/** The zoom for a canvas shown in a pane: 1 when it fits, down to MIN_ZOOM when it does not. */
export function zoomFor(layout: { width: number; height: number }, pane: { width: number; height: number }): number {
  return clamp(Math.min(pane.width / layout.width, pane.height / layout.height), MIN_ZOOM, 1);
}

/** The ids from the main chat down to `id`: what lights up when you point at a node. */
export function pathTo(layout: MapLayout, id: string): Set<string> {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const out = new Set<string>();
  for (let at = byId.get(id); at; at = at.parentId ? byId.get(at.parentId) : undefined) out.add(at.id);
  return out;
}

// ---- name plates ------------------------------------------------------------------------------
// A name is never cut and never drawn inside a bubble. It appears on a plate when a node is
// pointed at or focused, placed where it covers no other bubble.

export interface Plate {
  /** Top-left corner and size, in canvas pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  lines: string[];
  detail: string;
}

/** Break a name into lines at word boundaries (a word longer than a line is split). Never drops text. */
export function wrapName(name: string, at = WRAP_AT): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of name.trim().split(/\s+/)) {
    let w = word;
    while (w.length > at) {
      if (line) {
        out.push(line);
        line = "";
      }
      out.push(w.slice(0, at));
      w = w.slice(at);
    }
    if (!w) continue;
    if (!line) line = w;
    else if (line.length + 1 + w.length <= at) line += ` ${w}`;
    else {
      out.push(line);
      line = w;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}

/** The size a plate needs for `name` and one line of detail. */
export function plateSize(name: string, detail: string): { w: number; h: number; lines: string[] } {
  const lines = wrapName(name);
  const longest = Math.max(...lines.map((l) => l.length), Math.ceil(detail.length * 0.92));
  return { w: Math.ceil(longest * CHAR_W + PAD_X * 2), h: lines.length * LINE_H + LINE_H + PAD_Y * 2, lines };
}

/** Does the rectangle touch the circle (grown by `grow`)? */
export function rectHitsCircle(r: { x: number; y: number; w: number; h: number }, c: { x: number; y: number; r: number }, grow = 0): boolean {
  const nx = clamp(c.x, r.x, r.x + r.w);
  const ny = clamp(c.y, r.y, r.y + r.h);
  return (nx - c.x) ** 2 + (ny - c.y) ** 2 < (c.r + grow) ** 2;
}

/**
 * Where to put the plate for `id`: the nearest spot, preferring outward from the middle, that is
 * inside the canvas and touches no bubble (its own included). If every spot is taken it takes
 * the one that covers the least, which a canvas this roomy should never need. When the pane shows
 * only part of the canvas (`view`), a spot inside what is showing is preferred, so the name is
 * never hidden beyond the pane's edge.
 */
export function placePlate(layout: MapLayout, id: string, detail: string, view?: { x: number; y: number; w: number; h: number }, zoom = 1): Plate | null {
  const node = layout.nodes.find((n) => n.id === id);
  if (!node) return null;
  // A zoomed-out picture shows the plate at its normal size, so it takes more canvas.
  const size = plateSize(node.name, detail);
  const { lines } = size;
  const w = size.w / zoom;
  const h = size.h / zoom;
  const cx = layout.width / 2;
  const cy = layout.height / 2;
  const out = node.kind === "root" ? Math.PI / 2 : Math.atan2(node.y - cy, node.x - cx);
  const others = layout.nodes;

  let best: { plate: Plate; score: number } | null = null;
  const dirs = 16;
  for (const d of [8, 22, 44, 76, 120, 180]) {
    for (let k = 0; k < dirs; k++) {
      // Try the outward direction first, then fan out either side.
      const step = Math.ceil(k / 2) * ((k % 2 ? 1 : -1) * ((2 * Math.PI) / dirs));
      const a = out + step;
      const ux = Math.cos(a);
      const uy = Math.sin(a);
      const px = node.x + ux * (node.r + d);
      const py = node.y + uy * (node.r + d);
      const rect = { x: px - (ux > 0.35 ? 0 : ux < -0.35 ? w : w / 2), y: py - (uy > 0.35 ? 0 : uy < -0.35 ? h : h / 2), w, h };
      let hits = 0;
      for (const o of others) if (rectHitsCircle(rect, o, 6)) hits++;
      const outside = rect.x < 4 || rect.y < 4 || rect.x + w > layout.width - 4 || rect.y + h > layout.height - 4;
      const unseen = !!view && view.w > 0 && view.h > 0 && (rect.x < view.x + 4 || rect.y < view.y + 4 || rect.x + w > view.x + view.w - 4 || rect.y + h > view.y + view.h - 4);
      // A plate cut off by the pane edge cannot be read at all, so that is the worst outcome
      // (Will saw a right-edge bubble's name clipped); covering a bubble comes next.
      const score = hits * 1000 + (outside ? 500 : 0) + (unseen ? 5000 : 0) + d + Math.abs(step) * 6;
      if (!best || score < best.score) best = { plate: { ...rect, lines, detail }, score };
      if (score < 200) return best.plate;
    }
  }
  if (!best) return null;
  // Last guard: whatever won stays inside what the pane shows.
  const p = best.plate;
  if (view && view.w > w + 8 && view.h > h + 8) {
    p.x = Math.min(Math.max(p.x, view.x + 4), view.x + view.w - 4 - w);
    p.y = Math.min(Math.max(p.y, view.y + 4), view.y + view.h - 4 - h);
  }
  return p;
}
