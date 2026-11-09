import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "sessions" }));
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => setBackend(null));

describe("Sessions page frame", () => {
  it("is one window tall: the pick-up card sits above a list that scrolls on its own", async () => {
    setBackend(new MockBackend());
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    const pane = await screen.findByTestId("sessions-scroll");
    // The page itself is the fixed frame; the list is its own scroll pane.
    expect(pane.className).toMatch(/overflow-y-auto/);
    expect(pane.className).toMatch(/min-h-0/);
    expect(pane.closest(".h-full")).not.toBeNull();
    // The card is outside the scrolling pane, so it stays put.
    const card = screen.getByRole("region", { name: "Pick up where you left off" });
    expect(pane.contains(card)).toBe(false);
    expect(within(pane).getAllByRole("button").length).toBeGreaterThan(0);
  });
});
