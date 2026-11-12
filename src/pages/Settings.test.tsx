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
    expect(within(rail).getAllByRole("button").map((b) => b.textContent)).toEqual(["Appearance", "General", "Claude folder", "Claude Code", "Your data", "History", "About"]);
    expect(screen.getByRole("heading", { level: 2, name: "Appearance" })).toBeInTheDocument();
    expect(screen.queryByText("Folder Atlas reads")).not.toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-current", "true");

    await userEvent.click(within(rail).getByRole("button", { name: "Claude folder" }));
    expect(screen.getByText("Folder Atlas reads")).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Keep running when closed" })).not.toBeInTheDocument();

    await userEvent.click(within(rail).getByRole("button", { name: "About" }));
    expect(screen.getByText("Privacy")).toHaveAttribute("title", expect.stringContaining("sends none of your sessions or files"));
    expect(screen.queryByText(/sends none of your sessions or files/)).not.toBeInTheDocument();
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
    expect(screen.getByText("Uninstall")).toHaveAttribute("title", expect.stringContaining("Your Claude Code sessions are never touched."));
    expect(screen.queryByText(/never touched/)).not.toBeInTheDocument();
  });

  it("turns Keep running when closed on and off", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "General" }));
    const sw = await screen.findByRole("switch", { name: "Keep running when closed" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").closeToTray).toBe(true));
  });

  it("keeps the finished-chat notice off until it is switched on", async () => {
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "General" }));
    const sw = await screen.findByRole("switch", { name: "Tell me when a session finishes" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(/cannot tell when a session is only waiting/)).not.toBeInTheDocument();
    await userEvent.click(sw);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").notifyOnFinish).toBe(true));
    expect(sw).toHaveAttribute("aria-checked", "true");
  });

  it("Count cache in token totals starts off, saves when switched on, and every token total is counted again at once", async () => {
    const backend = mount();
    await userEvent.click(await screen.findByRole("button", { name: "General" }));
    const sw = await screen.findByRole("switch", { name: "Count cache in token totals" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    // The one-line tip lives in the hover, not on the page.
    expect(screen.queryByText(/re-reads it on every reply/)).not.toBeInTheDocument();
    const day = { from: "2026-01-01", to: "2026-12-31" };
    const sumDays = async () => (await backend.usageTimeline({ ...day, bucket: "day" })).points.reduce((n, p) => n + p.tokens.total, 0);
    const off = await sumDays();
    const told: string[] = [];
    await backend.onUsageChanged((c) => told.push(c.reason ?? ""));
    await userEvent.click(sw);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").countCacheInTotals).toBe(true));
    expect(sw).toHaveAttribute("aria-checked", "true");
    // The pages are told to ask again, and the same days now total more (cache writes and reads are in).
    expect(told).toContain("count-cache");
    const on = await sumDays();
    expect(on).toBeGreaterThan(off);
  });

  it("Show shortcuts starts off, switches on, and the hints follow it", async () => {
    mount();
    const sw = await screen.findByRole("switch", { name: "Show shortcuts" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    // Off: an icon-only button is named with no keys. (The gear itself carries no tip while you
    // are on Settings, like Wrapped's gift on Wrapped, so the sidebar toggle stands in for it.)
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute("title", "");
    expect(screen.getByRole("button", { name: "Sidebar" })).toHaveAttribute("title", "Hide sidebar");
    await userEvent.click(sw);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").showShortcuts).toBe(true));
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: "Sidebar" })).toHaveAttribute("title", "Hide sidebar (Ctrl+B)");
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

  it("asks before rebuilding from scratch, and reads sessions again straight away", async () => {
    const backend = mount();
    const reindex = vi.spyOn(backend, "usageReindex");
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Your data" }));
    await userEvent.click(await screen.findByRole("button", { name: "Read sessions again" }));
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

  const openFolder = async () => userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude folder" }));
  const keepGroup = async () => screen.findByRole("radiogroup", { name: "Keep saved sessions" });
  const checkedOf = (g: HTMLElement) => within(g).getAllByRole("radio").filter((r) => r.getAttribute("aria-checked") === "true").map((r) => r.textContent);

  it("Keep saved sessions: a missing value reads as Claude Code's default of 30 days", async () => {
    mount();
    await openFolder();
    const g = await keepGroup();
    expect(within(g).getAllByRole("radio").map((r) => r.textContent)).toEqual(["30 days", "1 year", "Forever"]);
    expect(checkedOf(g)).toEqual(["30 days"]);
    expect(screen.getByText(/drop out of search, resume and Wrapped/)).toBeInTheDocument();
  });

  it("Keep saved sessions: 365 and Forever (3650) show as their own picks", async () => {
    mount((b) => (b.retention.days = 365));
    await openFolder();
    expect(checkedOf(await keepGroup())).toEqual(["1 year"]);
    cleanup();
    mount((b) => (b.retention.days = 3650));
    await openFolder();
    expect(checkedOf(await keepGroup())).toEqual(["Forever"]);
  });

  it("Keep saved sessions: a custom value (90) is its own selected option and is not changed on its own", async () => {
    const backend = mount((b) => (b.retention.days = 90));
    const set = vi.spyOn(backend, "retentionSet");
    await openFolder();
    const g = await keepGroup();
    expect(within(g).getAllByRole("radio").map((r) => r.textContent)).toEqual(["30 days", "90 days", "1 year", "Forever"]);
    expect(checkedOf(g)).toEqual(["90 days"]);
    expect(set).not.toHaveBeenCalled();
    expect(backend.retention.days).toBe(90);
  });

  it("Keep saved sessions: picking Forever asks for 3650 (never 0), says so, and Undo puts the old value back", async () => {
    const backend = mount();
    const set = vi.spyOn(backend, "retentionSet");
    await openFolder();
    await userEvent.click(within(await keepGroup()).getByRole("radio", { name: "Forever" }));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(3650);
    expect(backend.retention.days).toBe(3650);
    expect(await screen.findByText("Saved sessions will be kept forever (3,650 days).")).toBeInTheDocument();
    await waitFor(() => expect(checkedOf(screen.getByRole("radiogroup", { name: "Keep saved sessions" }))).toEqual(["Forever"]));

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(backend.retention.days).toBeNull());
    await waitFor(() => expect(checkedOf(screen.getByRole("radiogroup", { name: "Keep saved sessions" }))).toEqual(["30 days"]));
  });

  it("Keep saved sessions: a value Claude Code would reject selects nothing and says so; picking fixes it", async () => {
    const backend = mount((b) => {
      b.retention.days = 0;
      b.retention.invalid = true;
    });
    await openFolder();
    const g = await keepGroup();
    expect(checkedOf(g)).toEqual([]);
    expect(screen.getByText(/holds a value Claude Code won't accept/)).toBeInTheDocument();
    await userEvent.click(within(g).getByRole("radio", { name: "30 days" }));
    await waitFor(() => expect(backend.retention.days).toBe(30));
    expect(backend.retention.invalid).toBe(false);
  });

  it("Keep saved sessions: when the setting is managed it is a read-only line with the reason, no picker", async () => {
    const backend = mount((b) => {
      b.retention.days = 90;
      b.retention.locked = "Your organisation sets this, so Atlas cannot change it.";
    });
    const set = vi.spyOn(backend, "retentionSet");
    await openFolder();
    expect(await screen.findByText("Your organisation sets this, so Atlas cannot change it.")).toBeInTheDocument();
    expect(screen.getByLabelText("Keep saved sessions: 90 days")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Keep saved sessions" })).toBeNull();
    expect(set).not.toHaveBeenCalled();
  });

  it("Keep saved sessions: when managed settings say 14 the read-only line says 14 days, not what the user's file says", async () => {
    mount((b) => {
      b.retention.days = 14; // the value that wins, from the managed file (the user's own file says 365)
      b.retention.locked = "Your organization sets this to 14 days, so Atlas can't change it.";
    });
    await openFolder();
    expect(await screen.findByText("Your organization sets this to 14 days, so Atlas can't change it.")).toBeInTheDocument();
    expect(screen.getByLabelText("Keep saved sessions: 14 days")).toBeInTheDocument();
    expect(screen.queryByLabelText("Keep saved sessions: 30 days")).toBeNull();
  });

  it("Keep saved sessions: a settings file that can't be read shows Unknown, not 30 days", async () => {
    mount((b) => {
      b.retention.days = null;
      b.retention.unknown = true;
      b.retention.locked = "Your Claude Code settings file isn't valid JSON, so Atlas won't touch it.";
    });
    await openFolder();
    expect(await screen.findByText(/isn't valid JSON/)).toBeInTheDocument();
    expect(screen.getByLabelText("Keep saved sessions: Unknown")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Keep saved sessions" })).toBeNull();
  });

  it("Text size: Default and Larger, saved, and the page is told before anything else paints", async () => {
    mount();
    const group = await screen.findByRole("radiogroup", { name: "Text size" });
    expect(checkedOf(group)).toEqual(["Default"]);
    expect(document.documentElement.dataset.text).toBeUndefined();
    await userEvent.click(within(group).getByRole("radio", { name: "Larger" }));
    await waitFor(() => expect(document.documentElement.dataset.text).toBe("larger"));
    expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").textSize).toBe("larger");
    await userEvent.click(within(screen.getByRole("radiogroup", { name: "Text size" })).getByRole("radio", { name: "Default" }));
    await waitFor(() => expect(document.documentElement.dataset.text).toBeUndefined());
  });

  it("Zoom: steps up and down, remembered, and Reset goes back to 100%", async () => {
    mount();
    const zoom = await screen.findByRole("group", { name: "Zoom" });
    expect(within(zoom).getByText("100%")).toBeInTheDocument();
    expect(within(zoom).getByRole("button", { name: "Reset" })).toBeDisabled();
    await userEvent.click(within(zoom).getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Zoom" })).getByText("110%")).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").zoomPercent).toBe(110);
    expect(document.documentElement.style.getPropertyValue("--zoom")).toBe("1.1");
    await userEvent.click(within(screen.getByRole("group", { name: "Zoom" })).getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Zoom" })).getByText("100%")).toBeInTheDocument());
    expect(document.documentElement.style.getPropertyValue("--zoom")).toBe("1");
  });

  it("Claude Code section is one switch, on by default, and the state is read back each time", async () => {
    mount();
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    const sw = await screen.findByRole("switch", { name: "Let Claude Code use Atlas" });
    expect(sw).toBeChecked();
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    await userEvent.click(sw);
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Let Claude Code use Atlas" })).not.toBeChecked();
    await userEvent.click(screen.getByRole("switch", { name: "Let Claude Code use Atlas" }));
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Let Claude Code use Atlas" })).toBeChecked();
    expect(screen.getByText("No network access")).toBeInTheDocument();
  });

  it("Claude Code section says when Claude Code is not found", async () => {
    mount((b) => {
      b.mcpStatus = async () => ({ state: "notConnected", command: null, server: "C:/x/atlas-mcp.exe", cliFound: false, configReadable: true, sandbox: false });
    });
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText("Claude Code not found")).toBeInTheDocument();
  });

  it("the switch saves its choice once, inside the connect command, not from the page too", async () => {
    const b = mount();
    const save = vi.spyOn(b, "updateSettings");
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    await userEvent.click(await screen.findByRole("switch", { name: "Let Claude Code use Atlas" }));
    expect(await screen.findByText("Off")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Let Claude Code use Atlas" })).not.toBeChecked();
  });

  it("another program named atlas shows honestly: switch off and disabled, and nothing is ever disconnected", async () => {
    const b = mount((m) => {
      m.mcpStatus = async () => ({ state: "foreign", command: "npx", server: "C:/x/atlas-mcp.exe", cliFound: true, configReadable: true, sandbox: false });
    });
    const off = vi.spyOn(b, "mcpDisconnect");
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    const sw = await screen.findByRole("switch", { name: "Let Claude Code use Atlas" });
    expect(await screen.findByText(/different program named "atlas"/)).toBeInTheDocument();
    expect(sw).not.toBeChecked();
    expect(sw).toBeDisabled();
    expect(screen.queryByText(/Atlas fixes this when it starts/)).toBeNull();
    await userEvent.click(sw);
    expect(off).not.toHaveBeenCalled();
  });

  it("a stale registration to another copy is shown whether the switch is on or off", async () => {
    const moved = { state: "moved", command: "C:/old/atlas-mcp.exe", server: "C:/x/atlas-mcp.exe", cliFound: true, configReadable: true, sandbox: false } as const;
    mount((m) => {
      m.mcpStatus = async () => moved;
    });
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText(/Registered to a different copy of Atlas/)).toBeInTheDocument();
    cleanup();
    // Switched off earlier (or the disconnect failed): the card must not say a plain "Off".
    localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: "settings", mcpAutoConnect: false }));
    const b = new MockBackend();
    b.mcpStatus = async () => moved;
    setBackend(b);
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText(/still registered with Claude Code/)).toBeInTheDocument();
    expect(screen.queryByText("Off")).toBeNull();
  });

  it("Claude Code section cannot change while Sandbox mode is on", async () => {
    mount((b) => {
      b.mcpStatus = async () => ({ state: "notConnected", command: null, server: "C:/x/atlas-mcp.exe", cliFound: true, configReadable: true, sandbox: true });
    });
    await userEvent.click(within(await screen.findByRole("navigation", { name: "Settings sections" })).getByRole("button", { name: "Claude Code" }));
    expect(await screen.findByText(/Turn Sandbox mode off/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Let Claude Code use Atlas" })).toBeDisabled();
  });
});
