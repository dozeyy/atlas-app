import { describe, expect, it } from "vitest";
import { helperName, shownName, typeName } from "./helperName";
import * as kit from "../components/usage/helperKit";
import * as progress from "./helperProgress";

const sources = import.meta.glob("./*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

describe("helper names live in src/lib", () => {
  it("is the one rule the pages and the model code share", () => {
    expect(kit.helperName).toBe(helperName);
    expect(kit.shownName).toBe(shownName);
    expect(progress.typeName).toBe(typeName);
    expect(typeName("ui-builder")).toBe("UI builder");
    expect(typeName(null)).toBe("Helper");
  });

  it("no model file in src/lib loads a component or a page (types only)", () => {
    const bad: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (/\.test\.ts$/.test(file)) continue;
      for (const m of text.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"(\.\.\/(?:components|pages)\/[^"]+)"/gm)) {
        if (!m[1]) bad.push(`${file} imports ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
