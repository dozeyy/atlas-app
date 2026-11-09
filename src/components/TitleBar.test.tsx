import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend, mockInfo } from "../lib/mock";
import { SessionLine } from "./usage/SessionList";
import type { SessionRow } from "../lib/types";

function mount(platform: "windows" | "macos" | "linux", showShortcuts = false) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ showShortcuts }));
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

  it("Windows: a mouse click does not leave a caption button holding keyboard focus", async () => {
    const backend = mount("windows");
    const act = vi.spyOn(backend, "windowControl");
    const min = screen.getByRole("button", { name: "Minimize" });
    await userEvent.click(min);
    expect(act).toHaveBeenCalledWith("minimize");
    expect(document.activeElement).not.toBe(min);
    // Tab still reaches it, and the keyboard press still works.
    min.focus();
    await userEvent.keyboard("{Enter}");
    expect(act).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(min);
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

describe("Wrapped's gift", () => {
  it("is an icon-only button in the title bar row, outside the main list, that opens Wrapped and shows it selected", async () => {
    mount("windows", true);
    const gift = screen.getByRole("button", { name: "Wrapped" });
    expect(gift.closest("header.titlebar")).not.toBeNull();
    expect(gift.closest("nav")).toBeNull();
    expect(gift).toHaveTextContent("");
    expect(gift).not.toHaveAttribute("data-tauri-drag-region");
    expect(gift.getAttribute("title")).toMatch(/^Wrapped \((Ctrl|Cmd)\+7\)$/);
    expect(gift).not.toHaveAttribute("aria-current");
    await userEvent.click(gift);
    expect(screen.getByRole("heading", { level: 1, name: "Wrapped" })).toBeInTheDocument();
    expect(gift).toHaveAttribute("aria-current", "page");
    // Already there: no hover tip left to hang over the page the click opened.
    expect(gift.getAttribute("title") ?? "").toBe("");
    expect(gift.getAttribute("data-tip") ?? "").toBe("");
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

  it("has a big bold title, one never-wrapping meta line in order, and nothing boxed or iconed", () => {
    render(
      <ul>
        <SessionLine row={row} onOpen={() => {}} />
      </ul>,
    );
    const btn = screen.getByRole("button");
    // No leading tile, no row icon, no chip or pill anywhere in the row.
    expect(btn.querySelector("svg, img, .chip, [class*='rounded'], [class*='border']")).toBeNull();
    const title = screen.getByText("Tidy the invoice rounding");
    expect(title.className).toMatch(/text-lead/);
    expect(title.className).toMatch(/font-bold/);
    const meta = btn.querySelector(".truncate.text-caption") as HTMLElement;
    expect(meta).not.toBeNull();
    // Will's order (2026-11-08): project, tokens, helpers, when. The dollar estimate lives in the tokens hover.
    // (The dollar estimate also reaches screen readers as hidden text right after the tokens.)
    expect(meta.textContent).toMatch(/^pixel-garden\u00b7117k tokens(, about \$0\.56 at API prices, estimated)?\u00b72 helpers\u00b7.+\d\d:\d\d$/);
    expect(meta.querySelector("[title]")?.getAttribute("title")).toMatch(/About \$0\.56 at API prices\. An estimate/);
    // The helper count is colored text and nothing else.
    expect(screen.getByText("2 helpers").className).toMatch(/text-accent-text/);
  });

  it("adds a one-line snippet with the matched words heavier, only when given one", () => {
    const { rerender } = render(
      <ul>
        <SessionLine row={row} onOpen={() => {}} />
      </ul>,
    );
    expect(screen.queryByText(/backoff/)).toBeNull();
    rerender(
      <ul>
        <SessionLine
          row={row}
          onOpen={() => {}}
          snippet={[
            { text: "the ", hit: false },
            { text: "backoff", hit: true },
            { text: " counter never resets", hit: false },
          ]}
        />
      </ul>,
    );
    const hit = screen.getByText("backoff");
    expect(hit.className).toMatch(/font-semibold/);
    expect(hit.className).not.toMatch(/bg-|rounded|border/);
    expect(hit.parentElement?.className).toMatch(/truncate/);
  });
});
