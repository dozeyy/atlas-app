import { describe, expect, it } from "vitest";
import { uniqueLabels } from "./wrappedLoad";

const row = (key: string, label: string) => ({ key, label });

describe("uniqueLabels", () => {
  it("leaves distinct names alone, in order", () => {
    const rows = [row("C--Users-Will-Documents-atlas", "atlas"), row("C--Users-Will-Documents-site", "site")];
    expect(uniqueLabels(rows)).toEqual(rows);
  });

  it("tells two folders of the same name apart by their parent", () => {
    const out = uniqueLabels([
      row("C--Users-Will-Documents-Minecraft-Mods-Origin-Client", "Origin Client"),
      row("C--Users-Will-Documents-Desktop-Apps-Origin-Client", "Origin Client"),
      row("C--Users-Will-Documents-atlas", "atlas"),
    ]);
    expect(out.map((r) => r.label)).toEqual(["Origin Client (Minecraft Mods)", "Origin Client (Desktop Apps)", "atlas"]);
    expect(new Set(out.map((r) => r.label)).size).toBe(3);
  });

  it("counts them when the keys give no usable parent", () => {
    const out = uniqueLabels([row("-mock-a", "x"), row("-mock-a", "x")]);
    expect(out.map((r) => r.label)).toEqual(["x (1)", "x (2)"]);
    // A parent that is the same word twice is no help either.
    const same = uniqueLabels([row("C--a-b-x", "x"), row("C--a-b-x", "x")]);
    expect(new Set(same.map((r) => r.label)).size).toBe(2);
  });

  it("copes with a label that is not at the end of its key", () => {
    const out = uniqueLabels([row("C--w-one-thing", "Unknown project"), row("C--w-two-thing", "Unknown project")]);
    expect(new Set(out.map((r) => r.label)).size).toBe(2);
    expect(out.every((r) => r.label.startsWith("Unknown project ("))).toBe(true);
  });
});
