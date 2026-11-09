import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { withKeys } from "./keyHints";

const SRC = join(__dirname, "..");

/** Where a key name may be written without going through the Show shortcuts switch. */
const ALLOWED = new Set([
  "components/HelpSheets.tsx", // the Keyboard shortcuts sheet: the one explicit place to see them
  "lib/appMenu.ts", // the list that sheet draws, and modName
  "lib/keyHints.ts", // the switch itself
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

/** Code without comments: a comment may say "Ctrl+K", only drawn text may not. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

// "Ctrl+K", "Cmd+,", "Alt+Up", and badges such as "Ctrl F" or "Cmd S".
const HINT = /\b(Ctrl|Cmd|Alt)\+|\b(Ctrl|Cmd) [A-Z]\b/;

describe("key hints go through Settings > Show shortcuts", () => {
  it("withKeys adds the keys only when asked", () => {
    expect(withKeys("Sessions", "Ctrl+3", false)).toBe("Sessions");
    expect(withKeys("Sessions", "Ctrl+3", true)).toBe("Sessions (Ctrl+3)");
  });

  it("no file writes a key name without using keyHints (or being the shortcuts list)", () => {
    const bad = files(SRC)
      .map((p) => ({ rel: relative(SRC, p).replace(/\\/g, "/"), text: readFileSync(p, "utf8") }))
      .filter(({ rel }) => !ALLOWED.has(rel))
      .filter(({ text }) => HINT.test(code(text)) && !/from "(\.\.?\/)+(lib\/)?keyHints"/.test(text))
      .map(({ rel }) => rel);
    // A hardcoded "Ctrl+6" in a hover or a badge ignores the switch: draw it with useKeyHints().
    expect(bad).toEqual([]);
  });
});
