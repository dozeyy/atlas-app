import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";

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
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
afterEach(() => {
  setBackend(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Settings", () => {
  it("has a section rail and the five sections, with the version at the bottom", async () => {
    mount();
    const rail = await screen.findByRole("navigation", { name: "Settings sections" });
    expect(within(rail).getAllByRole("button").map((b) => b.textContent)).toEqual(["Appearance", "Claude folder", "Your data", "History", "About"]);
    for (const name of ["Appearance", "Claude folder", "Your data", "History", "About"]) {
      expect(screen.getByRole("heading", { level: 2, name })).toBeInTheDocument();
    }
    expect(screen.getByText("Atlas on this computer")).toBeInTheDocument();
    expect(screen.getByText("Atlas never sends your data anywhere", { exact: false })).toBeInTheDocument();
  });

  it("turns Keep running when closed on and off", async () => {
    mount();
    const sw = await screen.findByRole("switch", { name: "Keep running when closed" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    await userEvent.click(sw);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").closeToTray).toBe(true));
  });

  it("steps how many versions History keeps, inside 10 to 200", async () => {
    mount();
    const group = await screen.findByRole("group", { name: "Versions kept" });
    expect(within(group).getByText("50")).toBeInTheDocument();
    await userEvent.click(within(group).getByRole("button", { name: "Keep more versions" }));
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Versions kept" })).getByText("60")).toBeInTheDocument());
    expect(JSON.parse(localStorage.getItem("atlas.mock.settings") ?? "{}").historyKeepVersions).toBe(60);
  });

  it("asks before rebuilding from scratch, and reads logs again straight away", async () => {
    const backend = mount();
    const reindex = vi.spyOn(backend, "usageReindex");
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
    expect(await screen.findByText(/Claude Code keeps conversation logs for/)).toBeInTheDocument();
  });
});
