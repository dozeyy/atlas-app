import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend, mockInfo } from "../lib/mock";
import { SessionLine } from "./usage/SessionList";
import type { SessionRow } from "../lib/types";

function mount(platform: "windows" | "macos" | "linux") {
  const backend = new MockBackend();
  vi.spyOn(backend, "boot").mockReturnValue(mockInfo({}, platform));
  setBackend(backend);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
  return backend;
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  setBackend(null);
  vi.restoreAllMocks();
});

describe("title bar row", () => {
  it("Windows: a drag row with three caption buttons that act on the window", async () => {
    const backend = mount("windows");
    const act = vi.spyOn(backend, "windowControl");
    const bar = document.querySelector("header.titlebar");
    expect(bar).toHaveAttribute("data-tauri-drag-region");
    await userEvent.click(screen.getByRole("button", { name: "Minimize" }));
    await userEvent.click(screen.getByRole("button", { name: "Maximize" }));
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(act.mock.calls.map((c) => c[0])).toEqual(["minimize", "toggle-maximize", "close"]);
  });

  it("Windows: the middle button turns into Restore while the window is maximized", async () => {
    const backend = new MockBackend();
    vi.spyOn(backend, "boot").mockReturnValue(mockInfo({}, "windows"));
    vi.spyOn(backend, "windowMaximized").mockResolvedValue(true);
    setBackend(backend);
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Restore" })).toBeInTheDocument());
  });

  it("macOS keeps its traffic lights: the row is there, with no caption buttons of ours", () => {
    mount("macos");
    expect(document.querySelector("header.titlebar")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Minimize" })).not.toBeInTheDocument();
  });

  it("Linux keeps its own frame: the row has the menu and toggle but no caption buttons", () => {
    mount("linux");
    expect(document.querySelector("header.titlebar")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Menu" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("has no Atlas label or logo at the top left; the menu button is there instead", () => {
    mount("windows");
    const left = document.querySelector(".titlebar-left") as HTMLElement;
    expect(left.querySelector("img")).toBeNull();
    expect(document.querySelector("aside")?.textContent).not.toMatch(/^Atlas/);
    expect(screen.getByRole("button", { name: "Menu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sidebar" })).toBeInTheDocument();
  });
});

describe("session row", () => {
  const row = {
    sessionId: "s1",
    title: "Tidy the invoice rounding",
    name: "Tidy the invoice rounding",
    projectName: "pixel-garden",
    startedAt: Date.UTC(2026, 10, 6, 1, 11),
    durationMs: 129 * 60_000,
    models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-sonnet-5-0"],
    agentCount: 2,
    missing: false,
    cost: { usd: 0.56, complete: true, unpricedTokens: 0 },
    tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 117000, webSearch: 0, webFetch: 0 },
  } as unknown as SessionRow;

  it("has no leading tile, one never-wrapping meta line, and models folded into one run", () => {
    render(
      <ul>
        <SessionLine row={row} onOpen={() => {}} />
      </ul>,
    );
    const btn = screen.getByRole("button");
    expect(btn.querySelector(".bg-accent-tint.size-10")).toBeNull();
    const meta = btn.querySelector(".truncate.text-caption") as HTMLElement;
    expect(meta).not.toBeNull();
    expect(meta.textContent).toMatch(/^pixel-garden . .+ . 2 h 9 min . Sonnet \+ Haiku$/);
    // The helpers chip stays; cost and tokens stay on the right.
    expect(screen.getByText("2 helpers")).toBeInTheDocument();
    expect(screen.getByText("117k tokens")).toBeInTheDocument();
  });
});
