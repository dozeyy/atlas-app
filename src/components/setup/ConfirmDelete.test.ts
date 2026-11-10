import { describe, expect, it } from "vitest";
import { mockSetupSnapshot } from "../../lib/setup-mock";
import { removedPath } from "./ConfirmDelete";

describe("the path under the delete question", () => {
  it("is the folder for a skill and the file for everything else", async () => {
    const snap = await mockSetupSnapshot(false);
    const skill = snap.items.find((i) => i.kind === "skill" && i.path)!;
    expect(skill.path).toMatch(/SKILL\.md$/);
    expect(removedPath(skill)).toBe(skill.path!.replace(/\/SKILL\.md$/, ""));
    expect(removedPath({ ...skill, path: "C:\\Users\\you\\.claude\\skills\\tidy\\SKILL.md" })).toBe("C:\\Users\\you\\.claude\\skills\\tidy");
    const agent = snap.items.find((i) => i.kind === "agent" && i.path)!;
    expect(removedPath(agent)).toBe(agent.path);
    expect(removedPath({ ...agent, path: null })).toBeNull();
  });
});
