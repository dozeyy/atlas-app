import { beforeAll, describe, expect, it } from "vitest";
import { mockSetupSnapshot } from "./setup-mock";
import {
  applyKind,
  chipWords,
  connectionWords,
  countByKind,
  countByScope,
  DEFAULT_FILTERS,
  displayChips,
  displayDescription,
  displayName,
  enabledTone,
  gridMove,
  groupItems,
  isOnMissingProject,
  KINDS,
  matchesQuery,
  permissionBuckets,
  relativeTime,
  ruleWords,
  scopeRuns,
  splitSummary,
  stateWords,
  toolsWords,
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

describe("hooks in plain words", () => {
  const hook = () => snap.items.find((i) => i.kind === "hook")!;

  it("leads with when the hook runs and keeps the settings name searchable", () => {
    const h = hook();
    expect(h.name).toBe("PreToolUse · Bash");
    expect(displayName(h)).toBe("Before a tool runs · Bash");
    expect(displayDescription(h)).toBe("Runs fmt.sh --check");
    expect(matchesQuery(h, "pretooluse")).toBe(true);
    expect(matchesQuery(h, "before a tool")).toBe(true);
  });

  it("spells several matchers as a list, drops a catch-all, and leaves an unknown event alone", () => {
    const h = hook();
    expect(displayName({ ...h, name: "PostToolUse · Edit|Write" })).toBe("After a tool runs · Edit, Write");
    expect(displayName({ ...h, name: "Stop · any" })).toBe("When Claude finishes");
    // A bar inside a pattern is part of the pattern: only a plain list of names is spelled out.
    expect(displayName({ ...h, name: "PreToolUse · Bash(npm test|lint)" })).toBe("Before a tool runs · Bash(npm test|lint)");
    expect(displayName({ ...h, name: "PreToolUse · mcp__atlas__.*|Edit" })).toBe("Before a tool runs · mcp__atlas__.*|Edit");
    expect(displayName({ ...h, name: "PreToolUse · mcp__atlas__read_item|Edit" })).toBe("Before a tool runs · mcp__atlas__read_item, Edit");
    expect(displayName({ ...h, name: "SomethingNew · Bash" })).toBe("SomethingNew · Bash");
    expect(displayDescription({ ...h, description: "prompt: Is this safe?" })).toBe("Asks Claude: Is this safe?");
    expect(displayDescription({ ...h, description: "something else" })).toBe("something else");
  });

  it("leaves every other kind exactly as it is named", () => {
    const skill = snap.items.find((i) => i.kind === "skill")!;
    expect(displayName(skill)).toBe(skill.name);
    expect(displayDescription(skill)).toBe(skill.description);
  });
});

describe("the settings file's own words stay off the surface", () => {
  const of = (kind: string, name?: string) => snap.items.find((i) => i.kind === kind && (!name || i.name === name))!;

  it("reads a permission rule in words only where it is sure of them", () => {
    expect(ruleWords("Bash(git status:*)")).toBe("Commands that start with git status");
    expect(ruleWords("Bash(npm run *)")).toBe("Commands that start with npm run");
    expect(ruleWords("Bash(npm test)")).toBe("The command npm test");
    expect(ruleWords("Bash")).toBe("Any command");
    expect(ruleWords("Read(*)")).toBe("Read any file");
    expect(ruleWords("Read(~/.zshrc)")).toBe("Read ~/.zshrc");
    expect(ruleWords("Edit(src/**)")).toBe("Change src/**");
    expect(ruleWords("WebFetch")).toBe("Open any web page");
    expect(ruleWords("WebFetch(domain:example.test)")).toBe("Open pages on example.test");
    expect(ruleWords("mcp__atlas__read_item")).toBe("read_item, from atlas");
    expect(ruleWords("mcp__atlas")).toBe("Every tool from atlas");
    // Not sure: shown as written.
    expect(ruleWords("Bash(git * --force:*)")).toBe("Bash(git * --force:*)");
    expect(ruleWords("Bash(a && b)")).toBe("Bash(a && b)");
    expect(ruleWords("Task(reviewer)")).toBe("Task(reviewer)");
    expect(ruleWords("WebFetch(https://x.test/*)")).toBe("WebFetch(https://x.test/*)");
  });

  it("names a permission and a plugin for a reader, and still finds them by the stored name", () => {
    const rule = of("permission", "Bash(git status:*)");
    expect(displayName(rule)).toBe("Commands that start with git status");
    expect(matchesQuery(rule, "bash(git")).toBe(true);
    expect(matchesQuery(rule, "start with git")).toBe(true);
    const plugin = of("plugin");
    expect(plugin.name).toBe("helpers@market");
    expect(displayName(plugin)).toBe("helpers");
    expect(matchesQuery(plugin, "helpers@market")).toBe(true);
    expect(displayName({ ...plugin, name: "@odd" })).toBe("@odd");
  });

  it("says how a connected tool is reached, not the transport", () => {
    const local = of("mcpServer", "github");
    expect(displayDescription(local)).toBe("Runs on this computer");
    expect(displayDescription({ ...local, description: "stdio: npx -y pkg" })).toBe("Runs on this computer");
    expect(displayDescription(of("mcpServer", "docs"))).toBe("Connects to example.test");
    expect(displayDescription({ ...local, description: "sse: not a url" })).toBe("Connects over the web");
    // A transport Atlas has no words for keeps the scan's line.
    expect(displayDescription({ ...local, description: "carrier-pigeon: coop 4", mcp: null })).toBe("carrier-pigeon: coop 4");
    expect(splitSummary("stdio: npx -y pkg")).toEqual({ transport: "stdio", target: "npx -y pkg" });
    expect(splitSummary("https://example.test/mcp")).toEqual({ transport: "", target: "https://example.test/mcp" });
    expect(connectionWords("stdio", "")).toBe("Runs on this computer");
    expect(matchesQuery(local, "npx")).toBe(true);
    expect(matchesQuery(local, "this computer")).toBe(true);
  });

  it("drops the tags the words already say and counts one thing in the singular", () => {
    expect(displayChips(of("mcpServer", "github"))).toEqual([]);
    expect(displayChips(of("hook"))).toEqual([]);
    expect(displayChips(of("permission"))).toEqual([]);
    expect(displayChips(of("plugin"))).toEqual(["v1.2.0", "1 skill", "2 hooks"]);
    expect(displayChips({ ...of("plugin"), chips: ["1 MCP servers", "1 output styles", "11 skills"] })).toEqual(["1 MCP server", "1 output style", "11 skills"]);
    const agent = of("agent");
    expect(displayChips(agent)).toEqual(agent.chips);
  });

  it("writes a tag the way the rest of the app does, with the file's own word on hover", () => {
    const agent = of("agent");
    // A bare family name gets no version: Atlas does not make one up.
    expect(chipWords(agent, "opus")).toEqual({ label: "Opus", title: "Model, as its file writes it: opus" });
    expect(chipWords(agent, "claude-opus-5-5")).toEqual({ label: "Opus 5.5", title: "Model, as its file writes it: claude-opus-5-5" });
    expect(chipWords(agent, "inherit").label).toBe("Session's model");
    // Only an agent's tag is a model: a skill tagged "opus" keeps its tag.
    expect(chipWords(of("skill"), "opus")).toEqual({ label: "opus" });
    expect(chipWords(of("skill"), "local").label).toBe("This computer only");
    expect(chipWords(of("skill"), "backup copy")).toEqual({ label: "Backup copy" });
    expect(chipWords(of("rule"), "src/**/*.ts")).toEqual({ label: "src/**/*.ts" });
  });

  it("says what the status line runs, with no type tag", () => {
    const line = of("statusLine");
    expect(displayDescription(line)).toBe("Runs statusline.sh");
    // The scan's own line is the bare command.
    expect(displayDescription({ ...line, description: "~/.claude/statusline.sh" })).toBe("Runs ~/.claude/statusline.sh");
    expect(displayDescription({ ...line, description: "" })).toBe("");
    expect(displayChips(line)).toEqual([]);
  });

  it("reads a file's tool list rule by rule, keeping the commas inside a rule", () => {
    expect(toolsWords("Read, Grep, Bash(git:*)")).toBe("Read, Grep, Commands that start with git");
    expect(toolsWords("Bash(git log:*), Read(a,b)")).toBe("Commands that start with git log, Read a,b");
    expect(toolsWords("Read, Grep")).toBe("Read, Grep");
    expect(toolsWords("Task(reviewer)")).toBe("Task(reviewer)");
  });

  it("calls a copy that loses to another Not in use, and says why on hover", () => {
    expect(stateWords({ state: "shadowed", label: "Shadowed", raw: null })).toEqual({ label: "Not in use", hint: "Another copy with the same name is used instead of this one." });
    expect(stateWords({ state: "on", label: "On", raw: null })).toEqual({ label: "On" });
  });
});
