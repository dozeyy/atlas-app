import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { isCollapsed } from "../lib/useSidebar";
import { invalidateDaily } from "../lib/useDaily";
import { localDay } from "../lib/usage";

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
    // The name only: the keys join it when Settings > Show shortcuts is on.
    expect(sessions).toHaveAttribute("title", "Sessions");
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

  it("Settings is not in the sidebar (it is the gear in the title bar row); no streak chip either", () => {
    mount(false);
    expect(within(side()).queryByRole("button", { name: "Settings" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" }).closest("header.titlebar")).not.toBeNull();
    expect(within(side()).queryByText(/day streak/)).not.toBeInTheDocument();
  });

  it("On a roll counts a week with a two-day gap as 2 (two empty days in the middle)", async () => {
    // Made-up figures, newest first: today and yesterday used, then two empty days -> 2, not 3.
    const back = [18_000_000, 2_000_000, 0, 0, 7_500_000, 30_000_000, 44_000_000];
    const b = new MockBackend();
    const real = b.usageTimeline.bind(b);
    b.usageTimeline = async (a) => {
      if (a.bucket !== "day" || a.groupBy) return real(a);
      const t = await real(a);
      const today = localDay(new Date());
      const points = t.points.map((p) => {
        const ago = Math.round((Date.parse(`${today}T12:00:00`) - Date.parse(`${p.start}T12:00:00`)) / 86_400_000);
        const v = ago < back.length ? back[ago] : 0;
        return { ...p, tokens: { ...p.tokens, input: v, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, total: v } };
      });
      return { ...t, points };
    };
    invalidateDaily();
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    setBackend(b);
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    const roll = await screen.findByRole("region", { name: "On a roll" });
    await waitFor(() => expect(within(roll).getByText("2")).toHaveClass("d-stat"));
    invalidateDaily();
  });

  it("isCollapsed: auto follows the width, an explicit choice wins", () => {
    expect(isCollapsed("auto", true)).toBe(true);
    expect(isCollapsed("auto", false)).toBe(false);
    expect(isCollapsed("expanded", true)).toBe(false);
    expect(isCollapsed("collapsed", false)).toBe(true);
  });
});
