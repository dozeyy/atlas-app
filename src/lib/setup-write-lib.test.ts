import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, splitFrontmatter } from "./markdown";
import { progress, progressTitle, SETUP_STEPS } from "./setup-steps";
import { itemsForTile, MORE_KINDS, TILE_KINDS, tileKinds } from "./setup-model";
import { mockSetupSnapshot } from "./setup-mock";
import { joinUsage, trackable, usageWindow, WINDOW_DAYS } from "./usage-join";
import type { SetupItem } from "./setup-types";
import type { ItemUse } from "./usageTypes";

describe("markdown reader", () => {
  it("splits frontmatter into fields and keeps the body", () => {
    const r = splitFrontmatter("---\nname: x\ntools: Read, Grep\n---\n# Hi\n");
    expect(r.fields).toEqual([
      { key: "name", value: "x" },
      { key: "tools", value: "Read, Grep" },
    ]);
    expect(r.body).toBe("# Hi\n");
  });

  it("leaves unclosed frontmatter alone", () => {
    expect(splitFrontmatter("---\nname: x\nbody").fields).toEqual([]);
  });

  it("builds data, never HTML, so a script tag is just text", () => {
    const blocks = parseMarkdown("# T\n\n<script>alert(1)</script>\n\n- a\n- b\n\n```js\nlet x\n```\n");
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "code"]);
    const inline = parseInline("**bold** `code` <b>x</b>");
    expect(inline.some((i) => i.type === "strong")).toBe(true);
    expect(inline.map((i) => i.text).join("")).toContain("<b>x</b>");
  });
});

describe("tiles", () => {
  it("cover every kind exactly once, with More holding the rest", () => {
    expect(TILE_KINDS.length + 1).toBe(12);
    expect(new Set([...TILE_KINDS, ...MORE_KINDS]).size).toBe(TILE_KINDS.length + MORE_KINDS.length);
    expect(tileKinds("more")).toBe(MORE_KINDS);
    expect(tileKinds("skill")).toEqual(["skill"]);
  });

  it("collect the items of their kind", async () => {
    const snap = await mockSetupSnapshot(false);
    const skills = itemsForTile(snap.items, "skill");
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.every((i) => i.kind === "skill")).toBe(true);
  });
});

describe("setup steps", () => {
  it("tick from the scan and stay data-driven", async () => {
    const snap = await mockSetupSnapshot(false);
    const full = progress(snap.items);
    expect(full.total).toBe(SETUP_STEPS.length);
    expect(full.complete).toBe(true);
    expect(progressTitle(full)).toBe("Your setup is complete");

    const bare = progress(snap.items.filter((i) => i.kind !== "agent" && i.kind !== "hook"));
    expect(bare.todo.map((s) => s.id)).toEqual(["agent", "hook"]);
    expect(progressTitle(bare)).toBe(`Your setup: ${SETUP_STEPS.length - 2} of ${SETUP_STEPS.length} done`);
  });

  it("do not count plugin, synced or backup copies as yours", async () => {
    const snap = await mockSetupSnapshot(false);
    const only = snap.items.filter((i) => i.kind === "skill" && (i.scope === "plugin" || i.scope === "synced"));
    expect(only.length).toBeGreaterThan(0);
    expect(progress(only).done.map((s) => s.id)).not.toContain("skill");
  });
});

describe("usage join", () => {
  const DAY = 86_400_000;
  const now = Date.UTC(2026, 10, 8, 12);
  const mk = (over: Partial<SetupItem>): SetupItem =>
    ({
      id: over.name ?? "x",
      kind: "skill",
      scope: "user",
      name: "x",
      modifiedMs: now - 90 * DAY,
      backup: false,
      worktree: false,
      conflict: null,
      ...over,
    }) as SetupItem;
  const use = (id: string, uses: number, lastUsed: number | null = now - DAY): ItemUse => ({ id, kind: "skill", uses, sessions: 1, lastUsed });

  it("asks for exactly thirty local days ending today", () => {
    const w = usageWindow(new Date(2026, 10, 8, 12));
    expect(w.to).toBe("2026-11-08");
    expect(w.from).toBe("2026-10-10");
    expect(WINDOW_DAYS).toBe(30);
  });

  it("matches by name, keeping a synced skill's prefix", () => {
    const items = [mk({ name: "commit-helper" }), mk({ name: "anthropic-skills:docx", scope: "synced" }), mk({ name: "docx" })];
    const rows = joinUsage(items, [use("commit-helper", 7), use("anthropic-skills:docx", 2)], [], now);
    const by = Object.fromEntries(rows.map((r) => [r.id, r.uses30d]));
    expect(by["commit-helper"]).toBe(7);
    expect(by["anthropic-skills:docx"]).toBe(2);
    expect(by["docx"]).toBe(0);
  });

  it("matches agents by their type", () => {
    const rows = joinUsage([mk({ name: "code-reviewer", kind: "agent" })], [], [{ id: "code-reviewer", kind: "agent", uses: 4, sessions: 2, lastUsed: now }], now);
    expect(rows[0]).toMatchObject({ kind: "agent", uses30d: 4 });
  });

  it("marks anything touched inside the window as new, so it is not called unused", () => {
    const rows = joinUsage([mk({ name: "old" }), mk({ name: "fresh", modifiedMs: now - DAY }), mk({ name: "nodate", modifiedMs: null })], [], [], now);
    const isNew = Object.fromEntries(rows.map((r) => [r.id, r.isNew]));
    expect(isNew).toEqual({ old: false, fresh: true, nodate: false });
  });

  it("keeps an item that ran only before the window at zero, with its last use", () => {
    const rows = joinUsage([mk({ name: "rare" })], [use("rare", 0, now - 60 * DAY)], [], now);
    expect(rows[0]).toMatchObject({ uses30d: 0, lastUsed: now - 60 * DAY });
  });

  it("leaves out backups, worktree copies, the losing copy of a clash, and other kinds", () => {
    expect(trackable(mk({ backup: true }))).toBe(false);
    expect(trackable(mk({ worktree: true }))).toBe(false);
    expect(trackable(mk({ conflict: { status: "overridden", label: "", definedIn: [] } }))).toBe(false);
    expect(trackable(mk({ kind: "rule" }))).toBe(false);
    expect(trackable(mk({}))).toBe(true);
  });
});
