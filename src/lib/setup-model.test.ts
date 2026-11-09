import { beforeAll, describe, expect, it } from "vitest";
import { mockSetupSnapshot } from "./setup-mock";
import {
  applyKind,
  countByKind,
  countByScope,
  DEFAULT_FILTERS,
  enabledTone,
  gridMove,
  groupItems,
  isOnMissingProject,
  KINDS,
  matchesQuery,
  permissionBuckets,
  relativeTime,
  scopeRuns,
  visibleItems,
} from "./setup-model";
import type { SetupSnapshot } from "./setup-types";

let snap: SetupSnapshot;
let withWt: SetupSnapshot;
beforeAll(async () => {
  snap = await mockSetupSnapshot(false);
  withWt = await mockSetupSnapshot(true);
});

describe("scope runs", () => {
  it("cuts a sorted list into neighbours that share a place", () => {
    const skills = groupItems(snap.items).find((g) => g.meta.kind === "skill")!.items;
    const runs = scopeRuns(skills);
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.flatMap((r) => r.items)).toEqual(skills);
    for (const r of runs) expect(new Set(r.items.map((i) => i.scopeLabel))).toEqual(new Set([r.label]));
    expect(scopeRuns([])).toEqual([]);
  });
});

describe("arrow keys across a grid", () => {
  // Two rows of three, then a short third row of one.
  const box = (col: number, row: number) => ({ left: col * 100, top: row * 80, width: 90, height: 70 });
  const boxes = [box(0, 0), box(1, 0), box(2, 0), box(0, 1), box(1, 1), box(2, 1), box(0, 2)];

  it("steps by one left and right and stops at the ends", () => {
    expect(gridMove(boxes, 1, "ArrowRight")).toBe(2);
    expect(gridMove(boxes, 0, "ArrowLeft")).toBe(0);
    expect(gridMove(boxes, 6, "ArrowRight")).toBe(6);
  });

  it("goes up and down to the card nearest across in the next row", () => {
    expect(gridMove(boxes, 1, "ArrowDown")).toBe(4);
    expect(gridMove(boxes, 5, "ArrowUp")).toBe(2);
    expect(gridMove(boxes, 4, "ArrowDown")).toBe(6); // the short row: nearest is the only one
    expect(gridMove(boxes, 6, "ArrowDown")).toBe(6);
    expect(gridMove(boxes, 0, "ArrowUp")).toBe(0);
  });

  it("walks in reading order when nothing has a layout", () => {
    const flat = [0, 1, 2].map(() => ({ left: 0, top: 0, width: 0, height: 0 }));
    expect(gridMove(flat, 0, "ArrowDown")).toBe(1);
    expect(gridMove(flat, 0, "ArrowUp")).toBe(0);
  });
});

describe("search", () => {
  it("matches every word, anywhere in the name, description, scope or tags", () => {
    const hits = (q: string) => visibleItems(snap.items, { ...DEFAULT_FILTERS, query: q }).map((i) => i.name);
    expect(hits("commit")).toContain("commit-helper");
    expect(hits("COMMIT style")).toEqual(["commit-helper"]);
    expect(hits("stdio github")).toContain("github");
    expect(hits("zzzz")).toEqual([]);
    expect(hits("  ")).toHaveLength(visibleItems(snap.items, DEFAULT_FILTERS).length);
  });

  it("an empty query matches everything", () => {
    expect(matchesQuery(snap.items[0], "")).toBe(true);
  });
});

describe("filters", () => {
  it("hides worktree and backup items until asked", () => {
    expect(visibleItems(withWt.items, DEFAULT_FILTERS).some((i) => i.worktree)).toBe(false);
    expect(visibleItems(withWt.items, { ...DEFAULT_FILTERS, showWorktrees: true }).some((i) => i.worktree)).toBe(true);
    expect(visibleItems(snap.items, DEFAULT_FILTERS).some((i) => i.backup)).toBe(false);
    expect(visibleItems(snap.items, { ...DEFAULT_FILTERS, showBackups: true }).some((i) => i.backup)).toBe(true);
  });

  it("splits global from project items, and narrows to one project", () => {
    const g = visibleItems(snap.items, { ...DEFAULT_FILTERS, scope: "global" });
    expect(g.length).toBeGreaterThan(0);
    expect(g.every((i) => i.scope !== "project" && i.scope !== "local")).toBe(true);
    const p = visibleItems(snap.items, { ...DEFAULT_FILTERS, scope: "project" });
    expect(p.every((i) => i.scope === "project" || i.scope === "local")).toBe(true);
    const one = visibleItems(snap.items, { ...DEFAULT_FILTERS, scope: "project", projectId: "p-atlas" });
    expect(one.length).toBeGreaterThan(0);
    expect(one.every((i) => i.projectId === "p-atlas")).toBe(true);
  });

  it("counts by kind and scope add up", () => {
    const v = visibleItems(snap.items, DEFAULT_FILTERS);
    expect([...countByKind(v).values()].reduce((a, b) => a + b, 0)).toBe(v.length);
    expect(Object.values(countByScope(v)).reduce((a, b) => a + b, 0)).toBe(v.length);
    expect(applyKind(v, "skill").every((i) => i.kind === "skill")).toBe(true);
    expect(applyKind(v, null)).toBe(v);
  });
});

describe("groups", () => {
  it("come in the page's fixed order, sorted inside, with no empty group", () => {
    const g = groupItems(visibleItems(snap.items, DEFAULT_FILTERS));
    const order = KINDS.map((k) => k.kind);
    const idx = g.map((x) => order.indexOf(x.meta.kind));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(g.every((x) => x.items.length > 0)).toBe(true);
    const skills = g.find((x) => x.meta.kind === "skill")!.items;
    // Global before project before plugin, so the item that wins reads first.
    expect(skills[0].scope).toBe("user");
  });

  it("permissions split into blocked, asks first, allowed", () => {
    const perms = snap.items.filter((i) => i.kind === "permission");
    expect(permissionBuckets(perms).map((b) => b.id)).toEqual(["deny", "ask", "allow"]);
  });
});

describe("small helpers", () => {
  it("finds items on projects that are gone", () => {
    const gone = snap.items.find((i) => i.projectId === "p-gone")!;
    expect(isOnMissingProject(gone, snap.projects)).toBe(true);
    expect(isOnMissingProject(snap.items[0], snap.projects)).toBe(false);
  });

  it("says times in plain words", () => {
    const now = 1_000_000_000_000;
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe("4 d ago");
    expect(relativeTime(null, now)).toBe("");
  });

  it("gives every state a tone", () => {
    expect(enabledTone("on")).toBe("good");
    expect(enabledTone("rejected")).toBe("bad");
    expect(enabledTone("shadowed")).toBe("warn");
    expect(enabledTone("none")).toBe("muted");
  });
});
