import { describe, expect, it } from "vitest";
import { mockSetupSnapshot } from "./setup-mock";
import { displayChips } from "./setup-model";
import { BADGES, badge, conflictWords, kindWords, moreWords, scopeWords, stateWords, tagWords } from "./tagWords";
import type { Conflict, Enabled, EnabledKind, ScopeKind } from "./setup-types";

const DOT = " · ";

// Every state word the scan (crates/core/src/setup) can send, with its kind. A new one lands here
// and in stateWords, or the sweep below fails on it.
const RAW_STATES: [EnabledKind, string, string | null][] = [
  ["on", "On", null],
  ["on", "On in 3 of 4 projects", null],
  ["off", "Off", null],
  ["off", "Off", "off"],
  ["off", "Off in all projects", null],
  ["off", "Plugin off", null],
  ["off", "Hooks disabled", null],
  ["active", "Active", null],
  ["inactive", "Overridden", null],
  ["inactive", "Not selected", null],
  ["shadowed", "Shadowed", null],
  ["approved", "Approved", null],
  ["rejected", "Rejected", null],
  ["pending", "Pending approval", null],
  ["custom", "ask", "ask"],
  ["none", "Account", null],
];

const SCOPES: [ScopeKind, string][] = [
  ["user", "Global"],
  ["project", `Project${DOT}atlas`],
  ["local", `Local${DOT}atlas`],
  ["plugin", `Plugin${DOT}helpers`],
  ["synced", "claude.ai"],
  ["connector", "claude.ai"],
  ["managed", "Managed"],
];

/** A tip is at least one whole sentence (a few start with a lowercase name, "claude.ai"). */
const sentence = (s: string) => expect(s, s).toMatch(/^\S.{10,}[.]$/);

describe("tag words: where it lives", () => {
  it("explains every scope and names the project where the item is used", () => {
    for (const [scope, label] of SCOPES) {
      const w = scopeWords(scope, label);
      expect(w.label).toBe(label);
      sentence(w.tip);
    }
    expect(scopeWords("project", `Project${DOT}atlas`).tip).toContain("working in atlas");
    expect(scopeWords("local", `Local${DOT}atlas`).tip).toContain("only on this computer");
    expect(scopeWords("plugin", `Plugin${DOT}helpers`).tip).toContain("plugin helpers");
    expect(scopeWords("user", "Global").tip).toContain("every project");
  });
});

describe("tag words: in use or not", () => {
  it("has words for every state the scan sends", () => {
    for (const [state, label, raw] of RAW_STATES) {
      const w = stateWords({ state, label, raw });
      expect(w.label, label).not.toBe("");
      sentence(w.tip);
    }
  });

  it("calls a copy that loses to another Not in use, and says why", () => {
    expect(stateWords({ state: "shadowed", label: "Shadowed", raw: null })).toEqual({ label: "Not in use", tip: "Another copy with the same name is used instead of this one." });
  });

  it("gives a state it does not know no tip, so the sweep catches it", () => {
    expect(stateWords({ state: "on", label: "Mystery", raw: null }).tip).toBe("");
  });

  it("quotes the settings value behind a custom state", () => {
    expect(stateWords({ state: "custom", label: "ask", raw: "ask" }).tip).toContain('"ask"');
  });
});

describe("tag words: which copy wins", () => {
  // The Global copy wins; `self` says which of the two the chip sits on.
  const defined = (status: Conflict["status"], label: string, self: "winner" | "loser"): Conflict => ({
    status,
    label,
    definedIn: [
      { id: "a", scopeLabel: "Global", winner: true, isSelf: self === "winner" },
      { id: "b", scopeLabel: `Project${DOT}atlas`, winner: false, isSelf: self === "loser" },
    ],
  });

  it("says which copy wins and where the other one lives", () => {
    const lost = conflictWords(defined("overridden", "Overridden by Global", "loser"));
    expect(lost.label).toBe("Overridden by Global");
    expect(lost.tip).toContain("the Global copy with this name wins");
    const won = conflictWords(defined("overrides", `Overrides Project${DOT}atlas`, "winner"));
    expect(won.tip).toContain("This copy is the one Claude uses");
    expect(won.tip).toContain(`Project${DOT}atlas`);
  });

  it("reads the winner off the label when the list is empty", () => {
    expect(conflictWords({ status: "overridden", label: "Overridden by Global", definedIn: [] }).tip).toContain("the Global copy");
  });

  it("explains a tie and a duplicate", () => {
    for (const status of ["conflict", "duplicate"] as const) sentence(conflictWords({ status, label: "x", definedIn: [] }).tip);
  });
});

describe("tag words: the plain tags", () => {
  it("knows every tag the mock setup shows", async () => {
    const snap = await mockSetupSnapshot(true);
    let seen = 0;
    for (const i of snap.items) {
      for (const c of displayChips(i)) {
        const w = tagWords(i.kind, c);
        expect(w, `${i.kind} ${i.name}: ${c}`).not.toBeNull();
        sentence(w!.tip);
        seen += 1;
      }
      const e: Enabled = i.enabled;
      if (e.label) sentence(stateWords(e).tip);
      sentence(scopeWords(i.scope, i.scopeLabel).tip);
      if (i.conflict) sentence(conflictWords(i.conflict).tip);
    }
    expect(seen).toBeGreaterThan(5);
  });

  it("explains a plugin's version and counts, a rule's paths, an agent's model and a local file", () => {
    expect(tagWords("plugin", "v1.2.0")!.tip).toContain("Version 1.2.0");
    expect(tagWords("plugin", "2 hooks")!.tip).toContain("2 hooks");
    expect(tagWords("rule", "**/*.ts")!.tip).toContain("**/*.ts");
    expect(tagWords("agent", "sonnet")).toMatchObject({ label: "Sonnet" });
    expect(tagWords("agent", "inherit")!.label).toBe("Session's model");
    expect(tagWords("settings", "local")!.label).toBe("This computer only");
    expect(tagWords("mcpServer", "stdio")!.tip).toContain("a program Claude starts");
  });

  it("returns null for a tag it does not know", () => {
    expect(tagWords("skill", "mystery")).toBeNull();
    expect(tagWords("skill", "opus")).toBeNull();
  });
});

describe("tag words: the fixed badges", () => {
  it("every badge has a label and an explanation", () => {
    for (const id of Object.keys(BADGES) as (keyof typeof BADGES)[]) {
      const w = badge(id);
      expect(w.label, id).not.toBe("");
      sentence(w.tip);
    }
  });

  it("counts the hidden tags and describes a kind by its own line", () => {
    expect(moreWords(1)).toEqual({ label: "+1", tip: "1 more tag. Open the card to see them all." });
    expect(moreWords(3).label).toBe("+3");
    expect(kindWords("skill", "Reusable know-how Claude loads when it is relevant.")).toEqual({ label: "Skill", tip: "Reusable know-how Claude loads when it is relevant." });
  });
});
