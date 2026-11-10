import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ClampText } from "./detailParts";

const LONG = "Read every file that the export button touches and report back. ".repeat(12).trim();

/** jsdom lays nothing out, so the heights a real window would report are stood in here. */
function heights(scroll: number, client: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scroll });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => client });
}

afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

describe("ClampText", () => {
  it("cuts long text to a few lines, keeps all of it in the page, and shows the rest when asked", async () => {
    heights(240, 60);
    const { container } = render(<ClampText text={LONG} />);
    const p = container.querySelector("p")!;
    expect(p).toHaveTextContent(LONG);
    expect(p.classList.contains("clamp-lines")).toBe(true);
    const more = screen.getByRole("button", { name: "Show all" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(p.classList.contains("clamp-lines")).toBe(false);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(less);
    expect(p.classList.contains("clamp-lines")).toBe(true);
  });

  it("offers no button when nothing is cut", () => {
    heights(40, 40);
    render(<ClampText text="Short ask." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
