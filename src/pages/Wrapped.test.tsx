import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";

function mount(prep?: (b: MockBackend) => void) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "wrapped" }));
  const backend = new MockBackend();
  prep?.(backend);
  setBackend(backend);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
  return backend;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  setBackend(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const position = () => screen.getByText(/^\d+ of \d+$/).textContent ?? "";

describe("Wrapped", () => {
  it("opens on the cover, said honestly about how far back it goes", async () => {
    mount();
    expect(await screen.findByText("tokens so far")).toBeInTheDocument();
    expect(screen.getAllByText(/Claude Code clears its logs after \d+ days/).length).toBeGreaterThan(0);
    expect(position()).toMatch(/^1 of \d+$/);
    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.queryByText(/Live/)).not.toBeInTheDocument();
  });

  it("clicks through the slides with the buttons and the arrow keys", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Start" }));
    expect(position()).toMatch(/^2 of \d+$/);
    expect(screen.queryByText("tokens so far")).not.toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(position()).toMatch(/^3 of \d+$/);
    await userEvent.keyboard("{ArrowLeft}");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(position()).toMatch(/^1 of \d+$/);
    expect(screen.getByText("tokens so far")).toBeInTheDocument();
  });

  it("jumps from the progress bar, ends on Replay, and starts over", async () => {
    mount();
    await screen.findByText("tokens so far");
    const total = Number(/of (\d+)/.exec(position())?.[1]);
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`Slide ${total} of ${total}`) }));
    expect(position()).toBe(`${total} of ${total}`);
    expect(screen.queryByRole("button", { name: "Next" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Replay" }));
    expect(position()).toBe(`1 of ${total}`);
    expect(screen.getByText("tokens so far")).toBeInTheDocument();
  });
});
