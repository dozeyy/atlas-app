import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Package } from "@phosphor-icons/react";
import { AgentAvatar, agentLook, avatarIconSize, avatarName, HELPER_KINDS, helperKind, helperName, helperOfFile, kindLook, MainChatIcon, shownName, tileCorners, tilePath, type HelperKind } from "./helperKit";
import { typeName } from "../../lib/helperProgress";
import { typeLabel } from "../../pages/AgentDetail";
import { KINDS as SETUP_KINDS } from "../../lib/setup-model";

describe("helper icons", () => {
  it("covers every kind of work a helper does", () => {
    for (const k of ["explore", "plan", "review", "test", "build", "design", "debug", "docs", "ops", "chore", "other"] as HelperKind[]) {
      expect(HELPER_KINDS).toContain(k);
    }
  });

  it("gives every kind its own icon and its own name, and none wears the main chat's", () => {
    const icons = HELPER_KINDS.map((k) => kindLook(k).Icon);
    expect(new Set(icons).size).toBe(HELPER_KINDS.length);
    expect(icons).not.toContain(MainChatIcon);
    expect(new Set(HELPER_KINDS.map((k) => kindLook(k).label)).size).toBe(HELPER_KINDS.length);
  });

  it("shares no icon with a kind of setup item in the Toolkit, nor with the Library's package", () => {
    const taken = new Set<unknown>([...SETUP_KINDS.map((k) => k.icon), Package]);
    for (const k of HELPER_KINDS) expect([k, taken.has(kindLook(k).Icon)]).toEqual([k, false]);
    expect(taken.has(MainChatIcon)).toBe(false);
  });

  it("names a saved file's helper by its whole id, never by one that only starts it", () => {
    const agents = [{ agentId: "a1" }, { agentId: "a12" }, { agentId: "a1-b" }];
    const file = (id: string) => `projects/-work-atlas/s-9/subagents/agent-${id}.jsonl`;
    expect(helperOfFile(file("a1"), agents)?.agentId).toBe("a1");
    expect(helperOfFile(file("a12"), agents)?.agentId).toBe("a12");
    expect(helperOfFile(file("a1-b"), agents)?.agentId).toBe("a1-b");
    // The longer ids listed first make no difference, and a file of no listed helper has no name.
    expect(helperOfFile(file("a12"), [...agents].reverse())?.agentId).toBe("a12");
    expect(helperOfFile(file("a123"), agents)).toBeUndefined();
    expect(helperOfFile("projects/x/agent-a1", agents)?.agentId).toBe("a1");
  });

  it("a kind's own name lands on that kind", () => {
    for (const k of HELPER_KINDS) if (k !== "other") expect(helperKind(k)).toBe(k);
  });

  it("puts real helper types on the kind a person would expect", () => {
    const expected: [string, HelperKind][] = [
      ["ui-builder", "design"],
      ["design-director", "design"],
      ["design-reviewer", "review"],
      ["code-reviewer", "review"],
      ["verify-auditor", "test"],
      ["verifier", "test"],
      ["bug-hunter", "debug"],
      ["crash-investigator", "debug"],
      ["render-debugger", "debug"],
      ["researcher", "explore"],
      ["Explore", "explore"],
      ["Plan", "plan"],
      ["architect", "plan"],
      ["general-purpose", "general"],
      ["release-packager", "ops"],
      ["site-deployer", "ops"],
      ["chore-runner", "chore"],
      ["spec-writer", "plan"],
      ["impeccable-documenter", "docs"],
      ["investigator", "debug"],
      ["docs-lookup", "explore"],
      ["layout-design-advisor", "plan"],
      ["asset-designer", "design"],
      ["query-optimizer", "perf"],
      ["smoke-test-triage", "test"],
      ["lane-agent", "other"],
      ["perf-profiler", "perf"],
      ["desktop-app-dev", "build"],
      ["batch-refactorer", "build"],
      ["mobile-app-dev", "build"],
      ["statusline-setup", "other"],
    ];
    for (const [type, kind] of expected) expect([type, helperKind(type)]).toEqual([type, kind]);
    expect(helperKind(null)).toBe("other");
    expect(helperKind("")).toBe("other");
  });

  it("matches a short word as a word, never as letters inside a longer one", () => {
    const expected: [string, HelperKind][] = [
      // "spec" in "specialist", "doc" in "docker", "port" in "support" and "report".
      ["security-specialist", "other"],
      ["frontend-specialist", "design"],
      ["docker-deployer", "ops"],
      ["support-agent", "other"],
      ["report-builder", "docs"],
      // The same slip with the other short words.
      ["information-gatherer", "other"],
      ["explanation-writer", "docs"],
      ["latest-news-fetcher", "explore"],
      ["profile-manager", "other"],
      ["reconciler", "other"],
      ["model-router", "other"],
      ["device-manager", "other"],
      ["splinter-finder", "explore"],
      // And the words still count where they are words.
      ["spec-writer", "plan"],
      ["specs", "plan"],
      ["specification-author", "plan"],
      ["docs", "docs"],
      ["documentation-helper", "docs"],
      ["mc-port-parity", "build"],
      ["porter", "build"],
      ["game-modder", "build"],
      ["fabric-mod-dev", "build"],
      ["web-developer", "build"],
      ["code-formatter", "chore"],
      ["lint-fixer", "chore"],
      ["pytest-runner", "test"],
      ["devops-engineer", "ops"],
      ["sprint-planner", "plan"],
      ["performance-tuner", "perf"],
      ["recon", "explore"],
      // A word after "_" or inside a compound is still that word (these fell to "other" once).
      ["playtest-triage", "test"],
      ["unit_tester", "test"],
      ["codebase-analyzer", "build"],
      ["codebase-locator", "build"],
      ["code_reviewer", "review"],
    ];
    for (const [type, kind] of expected) expect([type, helperKind(type)]).toEqual([type, kind]);
  });

  it("keeps the shape other pages rely on: an icon, colour classes and a word", () => {
    const look = agentLook("code-reviewer");
    expect(look.Icon).toBeTruthy();
    expect(look.tone).toMatch(/^bg-\S+$/);
    expect(look.label).toBe("Review");
    expect(look.fg).toMatch(/^var\(--chart-[1-4]\)$/);
    expect(look.bg).toContain(look.fg);
    // The glyph: ink pulled over halfway to the family's colour (screens.css draws the same on the HTML avatar).
    expect(look.ink).toBe("color-mix(in srgb, var(--chart-2) 55%, var(--ink))");
  });

  it("tints a tile from the four chart colours only, and gives every family its own shape", () => {
    const looks = HELPER_KINDS.map(kindLook);
    for (const l of looks) {
      expect([l.kind, l.tone]).toEqual([l.kind, expect.stringMatching(/^bg-chart-[1-4]\/30$/)]);
      expect([l.kind, l.bg]).toEqual([l.kind, expect.stringMatching(/^color-mix\(in srgb, var\(--chart-[1-4]\) 30%, transparent\)$/)]);
    }
    // One colour, one shape: the two say the same thing, so neither is needed alone.
    const pairs = new Set(looks.map((l) => `${l.fg} ${l.shape}`));
    expect(pairs.size).toBe(4);
    expect(new Set(looks.map((l) => l.fg)).size).toBe(4);
    expect(new Set(looks.map((l) => l.shape)).size).toBe(4);
  });

  it("draws the same tile in the list and on the map", () => {
    expect(tileCorners("tile", 20)).toEqual([6, 6, 6, 6]);
    expect(tileCorners("arch", 20)).toEqual([10, 10, 4, 4]);
    expect(tileCorners("shield", 40)).toEqual([7, 7, 20, 20]);
    expect(tileCorners("leaf", 40)).toEqual([20, 7, 20, 7]);
    // A ring around a tile never has a corner wider than half its side.
    expect(Math.max(...tileCorners("arch", 20, 5))).toBe(15);
    expect(tilePath("tile", 20)).toBe("M-4 -10H4A6 6 0 0 1 10 -4V4A6 6 0 0 1 4 10H-4A6 6 0 0 1 -10 4V-4A6 6 0 0 1 -4 -10Z");
  });

  it("names an avatar by its kind and where it sits", () => {
    expect(avatarName("code-reviewer")).toBe("Review helper");
    expect(avatarName(null)).toBe("Helper");
    expect(avatarName("verifier", "nested")).toBe("Test helper, started by another helper");
    expect(avatarName("anything", "main")).toBe("Main session");
  });

  it("keeps the icon on the 16 / 20 / 24 grid", () => {
    expect([20, 24, 28, 32, 36, 40, 48].map(avatarIconSize)).toEqual([16, 16, 16, 20, 20, 24, 24]);
  });
});

describe("helper names", () => {
  it("puts the known short forms back in capitals", () => {
    expect(helperName("Ui builder")).toBe("UI builder");
    expect(helperName("Qa lead")).toBe("QA lead");
    expect(helperName("Api tester")).toBe("API tester");
    expect(helperName("Mcp server dev")).toBe("MCP server dev");
    expect(helperName("Fix ci")).toBe("Fix CI");
    expect(helperName("Pr reviewer")).toBe("PR reviewer");
    expect(helperName("a typical ui builder")).toBe("a typical UI builder");
    expect(helperName("ui-builder")).toBe("UI-builder");
    expect(helperName("Web ui and api (mcp)")).toBe("Web UI and API (MCP)");
  });

  it("only as whole words, and touches nothing else", () => {
    for (const name of ["Build fixer", "Guide writer", "Price checker", "Circuit tester", "Apiary keeper", "Quality", "Sprint planner", "Code reviewer", "General purpose", "UI builder", "Explore", ""]) {
      expect(helperName(name)).toBe(name);
    }
    expect(helperName("ui2 and api3")).toBe("ui2 and api3");
    // Only a name made from the type is touched; what a person or Claude wrote stays as written.
    expect(shownName({ name: "Ui builder", nameSource: "type" })).toBe("UI builder");
    expect(shownName({ name: "check the ui again", nameSource: "description" })).toBe("check the ui again");
  });

  it("is what the type labels on Now, Sessions and Team go through", () => {
    expect(typeName("ui-builder")).toBe("UI builder");
    expect(typeLabel("ui-builder")).toBe("UI builder");
    expect(typeLabel("qa_runner")).toBe("QA runner");
    expect(typeName("general-purpose")).toBe("General purpose");
    expect(typeLabel(null)).toBe("Helper");
  });
});

describe("helper avatar", () => {
  it("says its kind in its hover and to a screen reader", () => {
    const { getByRole } = render(<AgentAvatar type="code-reviewer" />);
    const av = getByRole("img", { name: "Review helper" });
    expect(av.getAttribute("title")).toBe("Review helper");
  });

  it("tells the main chat, a helper and a helper's helper apart by shape", () => {
    const { container } = render(
      <>
        <AgentAvatar type={null} level="main" />
        <AgentAvatar type="verifier" />
        <AgentAvatar type="verifier" level="nested" />
      </>,
    );
    const [main, helper, nested] = [...container.querySelectorAll<HTMLElement>(".helper-av")];
    expect(main.style.borderRadius).toBe("50%");
    expect(helper.style.borderRadius).not.toBe("50%");
    expect(helper.classList.contains("nested")).toBe(false);
    expect(nested.classList.contains("nested")).toBe(true);
    // Hollow: the helper's tile has a fill class, its helper's tile has none (as on the map).
    expect([...helper.classList].some((c) => c.startsWith("bg-"))).toBe(true);
    expect([...nested.classList].some((c) => c.startsWith("bg-"))).toBe(false);
    // Both wear the family's glyph and (filled) ring through one class; the main chat does not.
    expect(helper.classList.contains("fam")).toBe(true);
    expect(nested.classList.contains("fam")).toBe(true);
    expect(main.classList.contains("fam")).toBe(false);
    // The second cue: the tile behind it, drawn from its family's colour (trail.css reads both).
    expect(nested.style.getPropertyValue("--av")).toBe("var(--chart-3)");
    expect(nested.style.getPropertyValue("--echo")).toBe("3px");
    // Same family, same corners, whichever level.
    expect(nested.style.borderRadius).toBe(helper.style.borderRadius);
    expect(main.getAttribute("aria-label")).toBe("Main session");
  });

  it("stays silent when the words already stand beside it", () => {
    const { container } = render(<AgentAvatar type="verifier" quiet />);
    const av = container.querySelector(".helper-av")!;
    expect(av.getAttribute("aria-hidden")).toBe("true");
    expect(av.hasAttribute("title")).toBe(false);
  });
});
