import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { AtlasProvider } from "./state/AtlasProvider";
import { setBackend } from "./lib/ipc";
import { MockBackend } from "./lib/mock";

function mount() {
  setBackend(new MockBackend());
  return render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

describe("navigation", () => {
  it("lists the six sections and starts on the dashboard", () => {
    mount();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const labels = Array.from(nav.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).toEqual(["Dashboard", "Sessions", "Toolkit", "History", "Wrapped"]);
    // Settings sits at the foot of the sidebar, where the version used to be; the version lives in Settings.
    const foot = screen.getByRole("navigation", { name: "Secondary" });
    // Icon only (Will, 2026-11-08): the name is the accessible label and tooltip, not visible text.
    expect(Array.from(foot.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"))).toEqual(["Settings"]);
    expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
  });

  it("switches pages on click and shows real content, not filler", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    expect(screen.getByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
    expect(await screen.findByRole("list", { name: "Changes" })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/lorem ipsum/i);
    expect(screen.getByRole("button", { name: "History" })).toHaveAttribute("aria-current", "page");
  });

  it("jumps with Ctrl+number", async () => {
    mount();
    await userEvent.keyboard("{Control>}5{/Control}");
    expect(screen.getByRole("heading", { level: 1, name: "Wrapped" })).toBeInTheDocument();
  });

  it("remembers the last page", async () => {
    const first = mount();
    await userEvent.click(screen.getByRole("button", { name: "History" }));
    first.unmount();
    mount();
    expect(screen.getByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
  });

  it("moves focus to the page after navigating", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Toolkit" }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });
});

describe("theme", () => {
  it("pins the theme on <html> and persists it", async () => {
    const first = mount();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    first.unmount();

    mount();
    await act(async () => {});
    expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").theme).toBe("dark");
  });

  it("offers Light, Silver and Dark, and Silver pins its own look", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    const names = screen.getAllByRole("radio").map((r) => r.getAttribute("aria-label"));
    expect(names).toEqual(["Light", "Silver", "Dark"]);
    await userEvent.click(screen.getByRole("radio", { name: "Silver" }));
    expect(document.documentElement.dataset.theme).toBe("silver");
  });

  it("Match removes the pin so the OS decides, and picking a card turns it off again", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("radio", { name: "Light" }));
    expect(document.documentElement.dataset.theme).toBe("light");
    const match = screen.getByRole("switch", { name: /^Match / });
    expect(match).toHaveAttribute("aria-checked", "false");
    await userEvent.click(match);
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(match).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(match).toHaveAttribute("aria-checked", "false");
  });
});

describe("sandbox", () => {
  it("shows preparing, then ready, and never shows the real folder meanwhile", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.click(screen.getByRole("switch", { name: "Sandbox mode" }));
    expect(await screen.findByText("Making the copy...")).toBeInTheDocument();
    expect(screen.getAllByText("Preparing sandbox").length).toBeGreaterThan(0);
    expect(screen.queryByText("C:/Users/you/.claude")).not.toBeInTheDocument();
    expect(await screen.findByText(/Copied 214 files/, undefined, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText("Sandbox mode", { selector: "span" })).toBeInTheDocument();
  });
});

describe("Claude folder", () => {
  it("lives in Settings only, and Open folder asks the backend to open it", async () => {
    const backend = new MockBackend();
    const open = vi.spyOn(backend, "openConfigDir");
    setBackend(backend);
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    await screen.findByRole("button", { name: "Settings" });
    expect(screen.queryByText("Folder Atlas reads")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Toolkit" }));
    expect(screen.queryByText("Folder Atlas reads")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(await screen.findByText("Folder Atlas reads")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open folder" }));
    expect(open).toHaveBeenCalledTimes(1);
  });
});
