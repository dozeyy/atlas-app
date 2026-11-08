import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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

describe("Wrapped", () => {
  it("opens on the cover and the slide cards, said honestly about how far back it goes", async () => {
    mount();
    expect(await screen.findByRole("button", { name: "Play the story" })).toBeInTheDocument();
    expect(screen.getByText("tokens so far")).toBeInTheDocument();
    expect(screen.getAllByText(/Claude Code clears its logs after \d+ days/).length).toBeGreaterThan(0);
    const cards = screen.getAllByRole("button", { name: /Open the story here/ });
    expect(cards.length).toBeGreaterThan(2);
    expect(screen.queryByText(/Live/)).not.toBeInTheDocument();
  });

  it("plays the story with the keyboard and closes on Escape", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Play the story" }));
    const story = await screen.findByRole("dialog", { name: "Your story" });
    expect(within(story).getByText(/^1 of \d+$/)).toBeInTheDocument();
    await userEvent.keyboard("{ArrowRight}");
    expect(within(story).getByText(/^2 of \d+$/)).toBeInTheDocument();
    await userEvent.keyboard("{ArrowLeft}");
    expect(within(story).getByText(/^1 of \d+$/)).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Your story" })).not.toBeInTheDocument());
  });

  it("opens the story at the card you picked, and ends with Done", async () => {
    mount();
    const cards = await screen.findAllByRole("button", { name: /Open the story here/ });
    await userEvent.click(cards[1]);
    const story = await screen.findByRole("dialog", { name: "Your story" });
    expect(within(story).getByText(/^2 of \d+$/)).toBeInTheDocument();
    const total = Number(/of (\d+)/.exec(within(story).getByText(/^2 of \d+$/).textContent ?? "")?.[1]);
    await userEvent.click(within(story).getByRole("button", { name: new RegExp(`Slide ${total} of ${total}`) }));
    expect(within(story).getByRole("button", { name: "Replay" })).toBeInTheDocument();
    await userEvent.click(within(story).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Your story" })).not.toBeInTheDocument());
  });
});
