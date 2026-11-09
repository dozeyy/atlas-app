import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { COUNT_BEAT, COUNT_FIRST, COUNT_STEP, figureDelay, SlideView } from "./Slide";
import { formatCount, parseCount, SPARKS, Words } from "./motion";
import { CURTAIN_LEAD, transitionFor } from "./Story";
import type { Slide } from "../../lib/wrappedModel";

const base: Slide = { id: "x", tone: "plain", kicker: "K", figure: "73", line: "One two three.", unit: "days" };

describe("parseCount and formatCount", () => {
  it("reads compact figures, commas and decimals, and nothing else", () => {
    expect(parseCount("851M")).toEqual({ n: 851, decimals: 0, commas: false, suffix: "M" });
    expect(parseCount("12.3k")).toEqual({ n: 12.3, decimals: 1, commas: false, suffix: "k" });
    expect(parseCount("1,234")).toEqual({ n: 1234, decimals: 0, commas: true, suffix: "" });
    for (const s of ["Jul 26", "10 d 15 h", "Tuesday", "0", "", "9 pm"]) expect(parseCount(s)).toBeNull();
  });
  it("formats every step like the final figure", () => {
    const p = parseCount("12.3k")!;
    expect(formatCount(0, p)).toBe("0.0k");
    expect(formatCount(6.149, p)).toBe("6.1k");
    expect(formatCount(1234, parseCount("1,234")!)).toBe("1,234");
  });
});

describe("transitionFor", () => {
  it("zooms the cover, ends behind the curtain, and never repeats back to back", () => {
    expect(transitionFor(0, 16)).toBe("zoom");
    expect(transitionFor(16, 16)).toBe("curtain");
    const seen = Array.from({ length: 15 }, (_, k) => transitionFor(k + 1, 16));
    for (let k = 1; k < seen.length; k++) expect(seen[k]).not.toBe(seen[k - 1]);
    expect(new Set(seen).size).toBeGreaterThanOrEqual(3);
    expect(CURTAIN_LEAD).toBeGreaterThan(0);
  });
});

describe("figureDelay", () => {
  it("lands at once, except the coder type (a drumroll) and the countdown (rows first)", () => {
    expect(figureDelay(base)).toBeLessThan(300);
    expect(figureDelay({ ...base, id: "type" })).toBeGreaterThan(1000);
    const rows = [1, 2, 3, 4, 5].map((n) => ({ label: `s${n}`, value: n }));
    const count = figureDelay({ ...base, chart: { kind: "countdown", rows } });
    expect(count).toBe(COUNT_FIRST + 4 * COUNT_STEP + COUNT_BEAT + 120);
  });
});

describe("Words", () => {
  it("keeps the sentence readable as text, one span per word", () => {
    const { container } = render(
      <p>
        <Words text="You have been busy." />
      </p>,
    );
    expect(container.querySelectorAll(".wr-w")).toHaveLength(4);
    expect(container.textContent).toBe("You have been busy.");
  });
});

describe("SlideView", () => {
  it("counts a plain number and slams anything else, and the figure text is whole for readers", () => {
    const { container, rerender } = render(<SlideView slide={base} index={2} />);
    expect(container.querySelector(".wr-fig")?.getAttribute("data-fx")).toBe("count");
    rerender(<SlideView slide={{ ...base, figure: "Tuesday" }} index={2} />);
    expect(container.querySelector(".wr-fig")?.getAttribute("data-fx")).toMatch(/^(slam|drop|tilt)$/);
    expect(screen.getByText("Tuesday")).toBeInTheDocument();
  });
  it("shows the drumroll only for the coder type", () => {
    const { container, rerender } = render(<SlideView slide={{ ...base, id: "type", figure: "Night Owl" }} index={14} />);
    expect(container.querySelector(".wr-drum")).not.toBeNull();
    rerender(<SlideView slide={{ ...base, figure: "Night Owl" }} index={14} />);
    expect(container.querySelector(".wr-drum")).toBeNull();
  });
  it("hands the wait to every piece through the slide's own variables", () => {
    const { container } = render(<SlideView slide={base} index={1} lead={CURTAIN_LEAD} />);
    const el = container.querySelector(".wr-slide") as HTMLElement;
    expect(el.style.getPropertyValue("--t0")).toBe(`${CURTAIN_LEAD}ms`);
    expect(el.style.getPropertyValue("--fd")).toMatch(/^\d+ms$/);
  });
  it("puts the one celebration on the card slide only", () => {
    const card = { title: "T", tokens: "1M", unit: "tokens", days: "1 active day of 1", tiles: [], range: "a to b", day: "2026-11-08" };
    const { container, rerender } = render(<SlideView slide={{ ...base, id: "card", card }} index={16} />);
    expect(container.querySelectorAll(".wr-spark")).toHaveLength(SPARKS.length);
    expect(container.querySelectorAll(".wr-ring")).toHaveLength(3);
    rerender(<SlideView slide={base} index={3} />);
    expect(container.querySelector(".wr-celebrate")).toBeNull();
  });
});

describe("the finale's sparks", () => {
  it("are fixed, spread round the card and inside the slide", () => {
    expect(SPARKS.length).toBe(16);
    expect(new Set(SPARKS.map((s) => `${s.dx},${s.dy}`)).size).toBe(16);
    for (const s of SPARKS) {
      expect(Math.abs(s.dx)).toBeLessThanOrEqual(520);
      expect(Math.abs(s.dy)).toBeLessThanOrEqual(190);
    }
  });
});
