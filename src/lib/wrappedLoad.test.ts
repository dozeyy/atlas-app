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

  it("hints only with the words that differ, never a word every path shares", () => {
    const out = uniqueLabels([
      row("C--Users-Will-Documents-Games-Godot-Origin-Client", "Origin Client"),
      row("C--Users-Will-Documents-Minecraft-Mods-Origin-Client", "Origin Client"),
    ]);
    expect(out.map((r) => r.hint)).toEqual(["Games Godot", "Minecraft Mods"]);
    expect(out.map((r) => r.label)).toEqual(["Origin Client (Games Godot)", "Origin Client (Minecraft Mods)"]);
    // A shared parent at the end of the path is not a difference either.
    const shared = uniqueLabels([row("C--w-Alpha-Apps-tool", "tool"), row("C--w-Beta-Apps-tool", "tool")]);
    expect(shared.map((r) => r.hint)).toEqual(["Alpha", "Beta"]);
  });

  it("counts them when one path is the other's parent, instead of repeating a shared word", () => {
    const out = uniqueLabels([row("C--Users-Will-Documents-Origin-Client", "Origin Client"), row("C--Users-Will-Documents-Games-Origin-Client", "Origin Client")]);
    expect(out.map((r) => r.label)).toEqual(["Origin Client (1)", "Origin Client (2)"]);
  });

  it("counts them when the hints would not be told apart, or the name is not ASCII", () => {
    const same = uniqueLabels([row("C--w-A-B-x", "x"), row("C--w-A-b-x", "x")]);
    expect(same.map((r) => r.label)).toEqual(["x (1)", "x (2)"]);
    const jp = uniqueLabels([row("C--w-one---", "\u65e5\u672c\u8a9e"), row("C--w-two---", "\u65e5\u672c\u8a9e")]);
    expect(jp.map((r) => r.label)).toEqual(["\u65e5\u672c\u8a9e (1)", "\u65e5\u672c\u8a9e (2)"]);
    // A partly non-ASCII name still finds its ASCII words at the end of the key.
    const cafe = uniqueLabels([row("C--w-one-Caf--Bot", "Caf\u00e9 Bot"), row("C--w-two-Caf--Bot", "Caf\u00e9 Bot")]);
    expect(cafe.map((r) => r.hint)).toEqual(["one", "two"]);
  });

  it("keeps the bare name on a row that got a hint, and no hint on one that did not", () => {
    const out = uniqueLabels([
      { ...row("C--w-a-x", "x"), name: "x" },
      { ...row("C--w-b-x", "x"), name: "x" },
      { ...row("C--w-y", "y"), name: "y" },
    ]);
    expect(out.map((r) => r.name)).toEqual(["x", "x", "y"]);
    expect(out[2].hint).toBeUndefined();
    expect(out[0].hint).toBe("a");
  });
});
