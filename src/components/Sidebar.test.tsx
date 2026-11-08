import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { isCollapsed } from "../lib/useSidebar";

function mount(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: narrow && query.includes("max-width"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  setBackend(new MockBackend());
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  setBackend(null);
  vi.unstubAllGlobals();
});

const side = () => document.querySelector("aside") as HTMLElement;
const shell = () => document.querySelector(".app-shell") as HTMLElement;
const toggle = () => screen.getByRole("button", { name: "Sidebar" });

describe("sidebar folding", () => {
  it("is open in a wide window and folds to icons in a narrow one", () => {
    mount(false);
    expect(side()).not.toHaveClass("side-collapsed");
    expect(shell()).toHaveAttribute("data-side", "open");
    expect(toggle()).toHaveAttribute("aria-expanded", "true");
  });

  it("folds on its own below 1000 px; every icon keeps its name and a tooltip", () => {
    mount(true);
    expect(side()).toHaveClass("side-collapsed");
    expect(shell()).toHaveAttribute("data-side", "collapsed");
    const sessions = screen.getByRole("button", { name: "Sessions" });
    expect(sessions).toHaveAttribute("title", expect.stringContaining("Sessions"));
  });

  it("the title bar toggle remembers the user's choice, which beats the window width", async () => {
    mount(true);
    await userEvent.click(toggle());
    expect(side()).not.toHaveClass("side-collapsed");
    expect(localStorage.getItem("atlas.sidebar")).toBe("expanded");
    await userEvent.click(toggle());
    expect(localStorage.getItem("atlas.sidebar")).toBe("collapsed");
  });

  it("Ctrl+B does the same as the toggle", async () => {
    mount(false);
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(side()).toHaveClass("side-collapsed");
    await userEvent.keyboard("{Control>}b{/Control}");
    expect(side()).not.toHaveClass("side-collapsed");
  });

  it("a saved choice is there on the next launch", () => {
    localStorage.setItem("atlas.sidebar", "collapsed");
    mount(false);
    expect(side()).toHaveClass("side-collapsed");
  });

  it("folded, the streak chip is not shown at all", () => {
    mount(true);
    // CSS hides it (display: none); the class that does so is the fold itself.
    expect(side()).toHaveClass("side-collapsed");
  });

  it("isCollapsed: auto follows the width, an explicit choice wins", () => {
    expect(isCollapsed("auto", true)).toBe(true);
    expect(isCollapsed("auto", false)).toBe(false);
    expect(isCollapsed("expanded", true)).toBe(false);
    expect(isCollapsed("collapsed", false)).toBe(true);
  });
});
