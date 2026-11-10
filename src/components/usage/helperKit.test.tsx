import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Package } from "@phosphor-icons/react";
import { AgentAvatar, agentLook, avatarIconSize, avatarName, HELPER_KINDS, helperKind, kindLook, MainChatIcon, type HelperKind } from "./helperKit";
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
      ["game-design-advisor", "plan"],
      ["asset-designer", "design"],
      ["pc-optimizer", "perf"],
      ["playtest-triage", "test"],
      ["lane-agent", "other"],
      ["perf-profiler", "perf"],
      ["desktop-app-dev", "build"],
      ["batch-refactorer", "build"],
      ["fabric-mod-dev", "build"],
      ["statusline-setup", "other"],
    ];
    for (const [type, kind] of expected) expect([type, helperKind(type)]).toEqual([type, kind]);
    expect(helperKind(null)).toBe("other");
    expect(helperKind("")).toBe("other");
  });

  it("keeps the shape other pages rely on: an icon, colour classes and a word", () => {
    const look = agentLook("code-reviewer");
    expect(look.Icon).toBeTruthy();
    expect(look.tone).toMatch(/^bg-\S+ text-\S+$/);
    expect(look.label).toBe("Review");
    expect(look.fg).toMatch(/^var\(--/);
    expect(look.bg).toMatch(/^var\(--/);
  });

  it("names an avatar by its kind and where it sits", () => {
    expect(avatarName("code-reviewer")).toBe("Review helper");
    expect(avatarName(null)).toBe("Helper");
    expect(avatarName("verifier", "nested")).toBe("Test helper, started by another helper");
    expect(avatarName("anything", "main")).toBe("Main chat");
  });

  it("keeps the icon on the 16 / 20 / 24 grid", () => {
    expect([20, 24, 28, 32, 36, 40, 48].map(avatarIconSize)).toEqual([16, 16, 16, 20, 20, 24, 24]);
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
    expect([...nested.classList].some((c) => c.startsWith("text-"))).toBe(true);
    expect(main.getAttribute("aria-label")).toBe("Main chat");
  });

  it("stays silent when the words already stand beside it", () => {
    const { container } = render(<AgentAvatar type="verifier" quiet />);
    const av = container.querySelector(".helper-av")!;
    expect(av.getAttribute("aria-hidden")).toBe("true");
    expect(av.hasAttribute("title")).toBe(false);
  });
});
