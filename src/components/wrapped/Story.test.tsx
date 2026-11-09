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
    // WebView2 can report :focus-visible as true after a key event even on a clicked button; the
    // story must not rely on it, so say the engine claims keyboard focus and it still advances.
    vi.spyOn(button, "matches").mockImplementation((q: string) => q === ":focus-visible");
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

  it("leaves Space alone on a button you reached with Tab", () => {
    mount();
    const button = screen.getByRole("button", { name: "Minimize" });
    fireEvent.keyDown(button, { key: "Tab" });
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    expect(position()).toBe("1 of 4");
  });

  it("swallows Space again once the mouse touches the page after a Tab", async () => {
    mount();
    const button = screen.getByRole("button", { name: "Minimize" });
    fireEvent.keyDown(button, { key: "Tab" });
    await userEvent.click(button);
    expect(fireEvent.keyDown(button, { key: " " })).toBe(false);
    expect(position()).toBe("2 of 4");
  });

  it("moves one slide per press: held keys that repeat are swallowed, not stepped", () => {
    mount();
    const body = document.body;
    expect(fireEvent.keyDown(body, { key: " " })).toBe(false);
    expect(position()).toBe("2 of 4");
    for (let n = 0; n < 5; n++) expect(fireEvent.keyDown(body, { key: " ", repeat: true })).toBe(false);
    for (let n = 0; n < 5; n++) fireEvent.keyDown(body, { key: "ArrowRight", repeat: true });
    expect(position()).toBe("2 of 4");
    fireEvent.keyUp(body, { key: " " });
    fireEvent.keyDown(body, { key: "ArrowRight" });
    expect(position()).toBe("3 of 4");
    fireEvent.keyDown(body, { key: "ArrowLeft", repeat: true });
    expect(position()).toBe("3 of 4");
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
