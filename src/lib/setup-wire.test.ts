import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MockSetupWorld, mockSetupSnapshot, mockSetupSource } from "./setup-mock";
import type {
  Conflict,
  DefinedIn,
  DeleteOutcome,
  DetailRow,
  Draft,
  Enabled,
  HiddenCounts,
  MaskedRange,
  McpInfo,
  Problem,
  ProjectState,
  RawEdit,
  RootStatus,
  SetupItem,
  SetupProject,
  SetupSnapshot,
  SourceView,
  UndoOutcome,
} from "./setup-types";

// fixtures/setup-wire-keys.json is written by the Rust test
// `the_wire_format_matches_the_front_end_key_list` from what discovery really
// serialises. Here: the TypeScript types and the browser mock must name exactly
// those keys, so a renamed field on either side fails a test, not the page.
const wire: Record<string, string[]> = JSON.parse(readFileSync(resolve(__dirname, "../../fixtures/setup-wire-keys.json"), "utf8"));

// Each record must list every key of its type (the compiler enforces that) ...
const TYPE_KEYS = {
  snapshot: { version: 1, root: 1, items: 1, projects: 1, hidden: 1, elapsedMs: 1 } satisfies Record<keyof SetupSnapshot, 1>,
  root: { dir: 1, dirExists: 1, claudeJson: 1, claudeJsonState: 1 } satisfies Record<keyof RootStatus, 1>,
  hidden: { worktrees: 1, missingProjects: 1, emptyProjects: 1, backups: 1 } satisfies Record<keyof HiddenCounts, 1>,
  project: {
    id: 1, name: 1, path: 1, exists: 1, isHome: 1, isWorktree: 1, parentId: 1, worktreeCount: 1, itemCount: 1, localMcpCount: 1, lastActivityMs: 1,
  } satisfies Record<keyof SetupProject, 1>,
  item: {
    id: 1, kind: 1, scope: 1, scopeLabel: 1, projectId: 1, plugin: 1, name: 1, description: 1, path: 1, linkTarget: 1, size: 1, modifiedMs: 1,
    enabled: 1, conflict: 1, chips: 1, warnings: 1, detail: 1, attachments: 1, usedBy: 1, mcp: 1, backup: 1, realProjectFile: 1, hasSecrets: 1, worktree: 1, editable: 1, deletable: 1, locked: 1,
  } satisfies Record<keyof SetupItem, 1>,
  enabled: { state: 1, label: 1, raw: 1 } satisfies Record<keyof Enabled, 1>,
  conflict: { status: 1, label: 1, definedIn: 1 } satisfies Record<keyof Conflict, 1>,
  definedIn: { id: 1, scopeLabel: 1, winner: 1, isSelf: 1 } satisfies Record<keyof DefinedIn, 1>,
  detailRow: { label: 1, value: 1 } satisfies Record<keyof DetailRow, 1>,
  mcp: { transport: 1, summary: 1, envKeys: 1, headerKeys: 1, perProject: 1, onCount: 1, totalProjects: 1 } satisfies Record<keyof McpInfo, 1>,
  projectState: { projectId: 1, projectName: 1, on: 1 } satisfies Record<keyof ProjectState, 1>,
  source: { id: 1, text: 1, language: 1, truncated: 1, maskedRanges: 1, size: 1, lineEnding: 1, bom: 1 } satisfies Record<keyof SourceView, 1>,
  maskedRange: { start: 1, end: 1, key: 1, index: 1 } satisfies Record<keyof MaskedRange, 1>,
  rawEdit: {
    id: 1, text: 1, language: 1, stamp: 1, lineEnding: 1, bom: 1, path: 1, hasSecrets: 1, needsReveal: 1, folderName: 1,
  } satisfies Record<keyof RawEdit, 1>,
  problem: { message: 1, line: 1 } satisfies Record<keyof Problem, 1>,
  deleteOutcome: { backupId: 1, name: 1, kind: 1, note: 1 } satisfies Record<keyof DeleteOutcome, 1>,
  undoOutcome: { name: 1, kind: 1 } satisfies Record<keyof UndoOutcome, 1>,
  draft: { kind: 1, name: 1, title: 1, path: 1, language: 1, text: 1, folderName: 1, whereNote: 1 } satisfies Record<keyof Draft, 1>,
};

describe("wire format", () => {
  it.each(Object.keys(TYPE_KEYS))("the %s type names the keys Rust sends", (name) => {
    expect(Object.keys(TYPE_KEYS[name as keyof typeof TYPE_KEYS]).sort()).toEqual(wire[name]);
  });

  it("the browser mock builds objects with exactly those keys", async () => {
    const s = await mockSetupSnapshot(true);
    expect(Object.keys(s).sort()).toEqual(wire.snapshot);
    expect(Object.keys(s.root).sort()).toEqual(wire.root);
    expect(Object.keys(s.hidden).sort()).toEqual(wire.hidden);
    for (const p of s.projects) expect(Object.keys(p).sort()).toEqual(wire.project);
    for (const i of s.items) {
      expect(Object.keys(i).sort(), i.name).toEqual(wire.item);
      expect(Object.keys(i.enabled).sort()).toEqual(wire.enabled);
      for (const r of i.detail) expect(Object.keys(r).sort()).toEqual(wire.detailRow);
      if (i.mcp) {
        expect(Object.keys(i.mcp).sort()).toEqual(wire.mcp);
        for (const p of i.mcp.perProject) expect(Object.keys(p).sort()).toEqual(wire.projectState);
      }
      if (i.conflict) {
        expect(Object.keys(i.conflict).sort()).toEqual(wire.conflict);
        for (const d of i.conflict.definedIn) expect(Object.keys(d).sort()).toEqual(wire.definedIn);
      }
    }
    const v = await mockSetupSource("settings:1");
    expect(Object.keys(v).sort()).toEqual(wire.source);
    for (const r of v.maskedRanges) expect(Object.keys(r).sort()).toEqual(wire.maskedRange);
  });

  it("the mock's write replies name exactly those keys", () => {
    const w = new MockSetupWorld();
    const skill = w.snapshot(false).items.find((i) => i.kind === "skill" && i.deletable)!;
    expect(Object.keys(w.raw(skill.id, true)).sort()).toEqual(wire.rawEdit);
    expect(Object.keys(w.validate(skill.id, "---\nname: x\n")[0]!).sort()).toEqual(wire.problem);
    const out = w.delete(skill.id);
    expect(Object.keys(out).sort()).toEqual(wire.deleteOutcome);
    expect(Object.keys(w.undo(out.backupId)).sort()).toEqual(wire.undoOutcome);
    expect(Object.keys(w.draft("skill", "wire-check")).sort()).toEqual(wire.draft);
  });
});
