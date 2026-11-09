import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Story } from "./Story";
import { figureLabel } from "./Poster";
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

const slides = [
  slide("a", { hint: "Where it comes from." }),
  slide("b"),
  slide("c"),
];
const position = () => screen.getByText(/^\d+ of \d+$/).textContent ?? "";

/** A caption button that lives outside the story, like the title bar's minimize. */
function mount(onCaption = vi.fn()) {
  render(
    <>
      <button type="button" onClick={onCaption}>
        Minimize
      </button>
      <Story slides={slides} />
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
    // WebView2 can report :focus-visible as true after a key event even on a clicked button; the
    // story must not rely on it, so say the engine claims keyboard focus and it still advances.
    vi.spyOn(button, "matches").mockImplementation(
      (q: string) => q === ":focus-visible",
    );
    const down = fireEvent.keyDown(button, { key: " " });
    expect(down).toBe(false); // default prevented, so the button is not pressed
    expect(position()).toBe("2 of 3");
    const up = fireEvent.keyUp(button, { key: " " });
    expect(up).toBe(false);
    expect(caption).toHaveBeenCalledTimes(1);
    await userEvent.keyboard("{ArrowRight}");
    expect(position()).toBe("3 of 3");
    await userEvent.keyboard("{ArrowLeft}");
    expect(position()).toBe("2 of 3");
  });

  it("leaves Space alone on a button you reached with Tab", () => {
    mount();
    const button = screen.getByRole("button", { name: "Minimize" });
    fireEvent.keyDown(button, { key: "Tab" });
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    expect(position()).toBe("1 of 3");
  });

  it("swallows Space again once the mouse touches the page after a Tab", async () => {
    mount();
    const button = screen.getByRole("button", { name: "Minimize" });
    fireEvent.keyDown(button, { key: "Tab" });
    await userEvent.click(button);
    expect(fireEvent.keyDown(button, { key: " " })).toBe(false);
    expect(position()).toBe("2 of 3");
  });

  it("paging with the arrows never leaves a keyboard focus ring behind, but a Tab walk still does", async () => {
    mount();
    const root = document.documentElement;
    root.dataset.input = "pointer";
    const button = screen.getByRole("button", { name: "Minimize" });
    await userEvent.click(button);
    // The input-modality listener flips to keyboard on any arrow; the story hands it straight back.
    const flip = (e: KeyboardEvent) => {
      if (e.key.startsWith("Arrow")) root.dataset.input = "keyboard";
    };
    document.addEventListener("keydown", flip, true);
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(position()).toBe("2 of 3");
    await new Promise((r) => setTimeout(r, 5));
    expect(root.dataset.input).toBe("pointer");
    fireEvent.keyDown(button, { key: "Tab" });
    root.dataset.input = "keyboard";
    fireEvent.keyDown(button, { key: "ArrowRight" });
    await new Promise((r) => setTimeout(r, 5));
    expect(root.dataset.input).toBe("keyboard");
    document.removeEventListener("keydown", flip, true);
    delete root.dataset.input;
  });

  it("moves one slide per press: held keys that repeat are swallowed, not stepped", () => {
    mount();
    const body = document.body;
    expect(fireEvent.keyDown(body, { key: " " })).toBe(false);
    expect(position()).toBe("2 of 3");
    for (let n = 0; n < 5; n++)
      expect(fireEvent.keyDown(body, { key: " ", repeat: true })).toBe(false);
    for (let n = 0; n < 5; n++)
      fireEvent.keyDown(body, { key: "ArrowRight", repeat: true });
    expect(position()).toBe("2 of 3");
    fireEvent.keyUp(body, { key: " " });
    fireEvent.keyDown(body, { key: "ArrowRight" });
    expect(position()).toBe("3 of 3");
    fireEvent.keyDown(body, { key: "ArrowLeft", repeat: true });
    expect(position()).toBe("3 of 3");
  });
  it("advances once, not twice, on Space with the figure's hover stop focused", async () => {
    mount();
    const fig = document.querySelector(".pr-fig") as HTMLElement;
    expect(fig.getAttribute("aria-label")).toBe("2026. Where it comes from.");
    fig.focus();
    expect(position()).toBe("1 of 3");
    await userEvent.keyboard(" ");
    expect(position()).toBe("2 of 3");
  });

  it("leaves Space and the arrows to a focused menu item, and to any open menu", () => {
    render(
      <>
        <div role="menu">
          <button type="button" role="menuitem">
            Open file
          </button>
        </div>
        <Story slides={slides} />
      </>,
    );
    const item = screen.getByRole("menuitem", { name: "Open file" });
    // Space on an item is the item's: not swallowed, and the story does not move.
    expect(fireEvent.keyDown(item, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(item, { key: "ArrowRight" })).toBe(true);
    expect(position()).toBe("1 of 3");
    // With a menu open anywhere, the story keeps its hands off even keys aimed at the page.
    expect(fireEvent.keyDown(document.body, { key: "ArrowRight" })).toBe(true);
    expect(position()).toBe("1 of 3");
  });

  it("stays out of the way while a dialog is open", () => {
    render(
      <>
        <div role="dialog" aria-label="Settings" />
        <Story slides={slides} />
      </>,
    );
    expect(fireEvent.keyDown(document.body, { key: " " })).toBe(true);
    expect(position()).toBe("1 of 3");
  });

  it("leaves the story on Esc, unless a dialog or menu is open", () => {
    const leave = vi.fn();
    const { rerender } = render(<Story slides={slides} onLeave={leave} />);
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    expect(leave).toHaveBeenCalledTimes(1);
    rerender(
      <>
        <div role="menu" />
        <Story slides={slides} onLeave={leave} />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(leave).toHaveBeenCalledTimes(1);
    rerender(
      <>
        <div role="dialog" aria-label="x" />
        <Story slides={slides} onLeave={leave} />
      </>,
    );
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("ignores the keys while typing in a field", async () => {
    render(
      <>
        <input aria-label="note" />
        <Story slides={slides} />
      </>,
    );
    await userEvent.click(screen.getByRole("textbox", { name: "note" }));
    await userEvent.keyboard(" ");
    expect(position()).toBe("1 of 3");
  });
});

describe("figureLabel", () => {
  it("says the figure, its unit and the hover", () => {
    expect(
      figureLabel({
        figure: "851M",
        unit: "tokens",
        hint: "851,000,000 tokens in all.",
      }),
    ).toBe("851M tokens. 851,000,000 tokens in all.");
    expect(figureLabel({ figure: "Tuesday" })).toBe("Tuesday");
  });
});
