import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for "buttons ignore clicks near their edge" (Will, 2026-11-08).
 *
 * Proven with a real mouse: a `:active { transform: scale(.96) }` on the button itself
 * shrinks its hit box while the mouse is down, so a mouseup 2 px inside the original edge
 * lands outside the shrunken box and no click fires. A hover `translateY` does the same at
 * the top and bottom edge. The fix: the element you click never gets a transform; an inner
 * face does. This test reads the CSS that ships and fails if any :hover / :active /
 * :focus-visible rule moves the interactive element itself.
 *
 * Safe and allowed: rules whose subject is a descendant (`.btn:active .btn-face`,
 * `.press:active > *`) and SVG marks that only GROW from a fixed hit target (`.cell`,
 * `.seg-bar`, `.bar` have a separate `.bar-hit` rect, so the pointer target never moves).
 */
const files = ["trail.css", "screens.css", "index.css"].map((f) => readFileSync(resolve(__dirname, f), "utf8"));
const css = files.join("\n").replace(/\/\*[\s\S]*?\*\//g, "");

const MOVES = /(^|[;\s])(transform|scale|translate|rotate|zoom)\s*:/;
// SVG marks that enlarge from a stable hit rect, never shrink away from the pointer.
const GROW_ONLY = [/\.cell\b/, /\.seg-bar\b/, /\.bar\b/];

function rules(): { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.startsWith("@")) continue; // @keyframes steps etc. have no pointer state
    out.push({ selector, body: m[2] });
  }
  return out;
}

/** The last compound selector: what the rule actually styles. */
function subject(sel: string): string {
  const parts = sel.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  return parts[parts.length - 1] ?? sel;
}

describe("hit box stays put", () => {
  const moving = rules().filter(
    (r) => MOVES.test(r.body) && /:(hover|active|focus-visible)/.test(r.selector),
  );

  it("finds the pointer-state transforms it is meant to police", () => {
    // If this drops to 0 the parser broke, and the real assertion below would pass vacuously.
    expect(moving.length).toBeGreaterThan(8);
  });

  it("never moves the interactive element itself on hover or press", () => {
    const offenders: string[] = [];
    for (const { selector } of moving) {
      for (const one of selector.split(",").map((s) => s.trim())) {
        if (!/:(hover|active|focus-visible)/.test(one)) continue;
        const last = subject(one);
        const subjectHasState = /:(hover|active|focus-visible)/.test(last);
        if (!subjectHasState) continue; // state sits on an ancestor; the subject is a descendant
        if (GROW_ONLY.some((re) => re.test(last))) continue;
        offenders.push(one);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the old shrinking selectors gone", () => {
    expect(css).not.toMatch(/\.press:active:not\(:disabled\)\s*\{[^}]*transform/);
    expect(css).not.toMatch(/\.btn:active:not\(:disabled\)\s*\{[^}]*transform/);
    expect(css).not.toMatch(/\.nav-item:active\s*\{[^}]*transform/);
    expect(css).not.toMatch(/\.seg-item:active\s*\{[^}]*transform/);
    expect(css).not.toMatch(/\.card-click/);
  });
});
