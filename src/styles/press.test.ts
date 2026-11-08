import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(resolve(process.cwd(), "src/styles/index.css"), "utf8");
const tokens = readFileSync(resolve(process.cwd(), "src/styles/tokens.css"), "utf8");

function rule(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  expect(at, `rule ${selector} exists`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("press feedback keeps the whole button clickable", () => {
  const scale = Number(/--press-scale:\s*([0-9.]+)/.exec(tokens)![1]);

  it("scales the pressed element", () => {
    expect(rule(".press:active:not(:disabled)")).toContain("transform: scale(var(--press-scale))");
  });

  it("gives the pressed element an invisible hit box that undoes the shrink", () => {
    const r = rule(".press:active:not(:disabled)::after");
    expect(r).toContain('content: ""');
    expect(r).toContain("position: absolute");
    expect(r).toContain("var(--press-scale)");
    // inset: calc((1 / s - 1) * -50% - 1%)  =>  each side grows by (1/s - 1)/2 + 1% of the box
    const grow = (1 / scale - 1) / 2 + 0.01;
    const covered = (1 + 2 * grow) * scale;
    expect(covered).toBeGreaterThanOrEqual(1);
    expect(r).toMatch(/inset:\s*calc\(\(1 \/ var\(--press-scale\) - 1\) \* -50% - 1%\)/);
  });
});
