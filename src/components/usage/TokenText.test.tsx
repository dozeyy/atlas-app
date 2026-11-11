import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TokenText } from "./TokenText";
import { TokenFigure } from "./helperKit";
import type { Cost } from "../../lib/types";

const cost: Cost = { usd: 1.5, complete: true, unpricedTokens: 0 };
const kinds = { input: 100, output: 50, cacheWrite: 30, cacheRead: 2000 };

describe("a token figure for a screen reader", () => {
  it("says the four kinds and their sum in words, since the hover table is out of reach", () => {
    render(<TokenText tokens={150} cost={cost} kinds={kinds} />);
    const text = document.querySelector(".sr-only")!.textContent!;
    expect(text).toContain("input 100, output 50, cache writes 30, cache reads 2,000, all together 2,180");
    expect(text).toContain("at API prices, estimated");
  });

  it("is a tab stop when it is the page's headline figure, so the keyboard gets the hover table", () => {
    render(<TokenFigure id="t" tokens={150} cost={cost} kinds={kinds} />);
    const fig = screen.getByText("tokens").parentElement!;
    expect(fig).toHaveAttribute("tabindex", "0");
    expect(fig.getAttribute("title")).toContain("=All together");
  });
});
