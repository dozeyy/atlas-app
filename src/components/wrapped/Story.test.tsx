import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Story } from "./Story";
import { figureLabel } from "./Slide";
import type { Slide } from "../../lib/wrappedModel";

const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  tone: "plain",
  layout: "stack",
  kicker: `Kicker ${id}`,
  figure: "2026",
  line: "A line.",
  ...over,
});

const slides = [slide("a", { hint: "Where it comes from." }), slide("b"), slide("c")];
const position = () => screen.getByText(/^\d+ of \d+$/).textContent ?? "";

/** A caption button that lives outside the story, like the title bar's minimize. */
function mount(onCaption = vi.fn()) {
  render(
    <>
      <button type="button" onClick={onCaption}>
        Minimize
      </button>
      <Story cover={<div>Cover</div>} slides={slides} />
    </>,
  );
  return onCaption;
}

describe("Story keys", () => {
  it("drives only the story with Space and the arrows, and swallows Space on a clicked outside button", async () => {
    const caption = mount();
    const button = screen.getByRole("button", { name: "Minimize" });
    // A mouse click leaves focus on the button; Space must advance the story and not press it again.
    await userEvent.click(button);
    expect(caption).toHaveBeenCalledTimes(1);
    // jsdom has no focus-visible heuristic (every focused element matches), so say what a real
    // engine says after a mouse click: not keyboard-focused.
    vi.spyOn(button, "matches").mockImplementation(() => false);
    const down = fireEvent.keyDown(button, { key: " " });
    expect(down).toBe(false); // default prevented, so the button is not pressed
    expect(position()).toBe("2 of 4");
    const up = fireEvent.keyUp(button, { key: " " });
    expect(up).toBe(false);
    expect(caption).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{ArrowRight}");
    expect(position()).toBe("3 of 4");
    await userEvent.keyboard("{ArrowLeft}");
    expect(position()).toBe("2 of 4");
  });

  it("leaves Space alone on a button you reached with the keyboard", () => {
    mount();
    const button = screen.getByRole("button", { name: "Minimize" });
    const spy = vi.spyOn(button, "matches").mockImplementation((q: string) => q === ":focus-visible");
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    expect(position()).toBe("1 of 4");
    spy.mockRestore();
  });

  it("advances once, not twice, on Space with the figure's hover stop focused", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Start" }));
    const fig = document.querySelector(".wr-fig") as HTMLElement;
    expect(fig.getAttribute("aria-label")).toBe("2026. Where it comes from.");
    fig.focus();
    expect(position()).toBe("2 of 4");
    await userEvent.keyboard(" ");
    expect(position()).toBe("3 of 4");
  });

  it("ignores the keys while typing in a field", async () => {
    render(
      <>
        <input aria-label="note" />
        <Story cover={<div>Cover</div>} slides={slides} />
      </>,
    );
    await userEvent.click(screen.getByRole("textbox", { name: "note" }));
    await userEvent.keyboard(" ");
    expect(position()).toBe("1 of 4");
  });
});

describe("figureLabel", () => {
  it("says the figure, its unit and the hover", () => {
    expect(figureLabel({ figure: "851M", unit: "tokens", hint: "851,000,000 tokens in all." })).toBe("851M tokens. 851,000,000 tokens in all.");
    expect(figureLabel({ figure: "Tuesday" })).toBe("Tuesday");
  });
});
