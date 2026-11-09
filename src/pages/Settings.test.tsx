import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { resetUpdateStore } from "../lib/updateStore";

function mount(prep?: (b: MockBackend) => void) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "settings" }));
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
  resetUpdateStore();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  setBackend(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Settings", () => {
  it("shows one section at a time from the rail, so the page never scrolls", async () => {
    mount();
    const rail = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(rail).getAllByRole("button").map((b) => b.textContent)).toEqual(["Appearance", "Claude folder", "Claude Code", "Your data", "History", "About"]);
    expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByText("Folder Atlas reads")).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "true");

    await userEvent.click(within(rail).getByRole("button", { name: "Claude folder" }));
    expect(screen.getByText("Folder Atlas reads")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Keep running when closed" })).not.toBeInTheDocument();

    await userEvent.click(within(rail).getByRole("button", { name: "About" }));
    expect(screen.getByText("Privacy")).toHaveAttribute("title", expect.stringContaining("never sends your data"));
    expect(screen.queryByText(/never sends your data/)).not.toBeInTheDocument();
    expect(screen.getByText("Version")).toBeInTheDocument();
  });

  it("About shows the version and a Check for updates button that answers in plain words", async () => {
    const backend = mount();
    const rail = await screen.findByRole("navigation", { name: "Settings sections" });
    await userEvent.click(within(rail).getByRole("button", { name: "About" }));
    await userEvent.click(await screen.findByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You have the latest version.")).toBeInTheDocument();
    expect(backend.updates.checks).toBe(1);

    backend.updates.available = { version: "0.2.0", notes: "", current: "0.1.0" };
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Version 0.2.0 is ready.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update and restart" })).toBeInTheDocument();
  });

  it("About offers Uninstall Atlas only where an uninstaller sits beside it, and starts it on a click", async () => {
    // A dev run or a copy with no uninstaller: no row.
    mount();
    let rail = await screen.findByRole("navigation", { name: "Settings sections" });
    await userEvent.click(within(rail).getByRole("button", { name: "About" }));
    expect(await screen.findByText("Version")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Uninstall Atlas..." })).not.toBeInTheDocument();
    cleanup();

    const started = vi.fn(async () => {});
    mount((b) => {
      b.uninstallAvailable = async () => true;
      b.uninstallAtlas = started;
    });
    rail = await screen.findByRole("navigation", { name: "Settings sections" });
    await userEvent.click(within(rail).getByRole("button", { name: "About" }));
    await userEvent.click(await screen.findByRole("button", { name: "Uninstall Atlas..." }));
    expect(started).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Uninstall")).toHaveAttribute("title", expect.stringContaining("Your Claude Code chats are never touched."));
    expect(screen.queryByText(/never touched/)).not.toBeInTheDocument();
  });

  it("turns Keep running when closed on and off", async () => {
    mount();
    const sw = await screen.findByRole("switch", { name: "Keep running when closed" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").closeToTray).toBe(true));
  });

  it("keeps the finished-chat notice off until it is switched on", async () => {
    mount();
    const sw = await screen.findByRole("switch", { name: "Tell me when a chat finishes" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/cannot tell when a chat is only waiting/)).not.toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").notifyOnFinish).toBe(true));
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("steps how many versions History keeps, inside 10 to 200", async () => {
    mount();
    const rail = await screen.findByRole("navigation", { name: "Settings sections" });
    await userEvent.click(within(rail).getByRole("button", { name: "History" }));
    const group = await screen.findByRole("group", { name: "Versions kept" });
    expect(within(group).getByText("50")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Keep more versions" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Versions kept" })).getByText("60")).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").historyKeepVersions).toBe(60);
  });

  it("asks before rebuilding from scratch, and reads logs again straight away", async () => {
    const backend = mount();
    const reindex = vi.spyOn(backend, "usageReindex");
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Your data" }));
    await userEvent.click(await screen.findByRole("button", { name: "Read logs again" }));
    expect(reindex).toHaveBeenCalledWith("changed");

    await userEvent.click(screen.getByRole("button", { name: "Rebuild from scratch" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Rebuild from scratch?" });
    expect(reindex).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(reindex).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Rebuild from scratch" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Rebuild" }));
    expect(reindex).toHaveBeenLastCalledWith("full");
  });

  it("shows how long Claude Code keeps its logs", async () => {
    mount();
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude folder" }));
    expect(await screen.findByText(/Claude Code keeps conversation logs for/)).toBeInTheDocument();
  });

  it("Claude Code section connects and disconnects, reading the state back each time", async () => {
    mount();
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText(/Not connected\./)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByRole("button", { name: "Disconnect" })).toBeInTheDocument();
    expect(screen.getByText(/Open a new chat to use it/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.getByText("No network access")).toBeInTheDocument();
  });

  it("Claude Code section cannot connect while Sandbox mode is on", async () => {
    mount((b) => {
      b.mcpStatus = async () => ({ state: "notConnected", command: null, server: "C:/x/atlas-mcp.exe", cliFound: true, configReadable: true, sandbox: true });
    });
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText(/Turn Sandbox mode off to connect/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).toBeDisabled();
  });
});
