import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { resetSetupStore } from "../state/setupStore";
import { closePalette } from "../state/paletteStore";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { clearPendingProject, clearPendingSession, clearPendingToolkitItem } from "../lib/nav";

function mount(view = "dashboard", showShortcuts = false) {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: view, showShortcuts }));
  const backend = new MockBackend();
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
  resetSetupStore();
});
afterEach(() => {
  closePalette();
  clearPendingSession();
  clearPendingProject();
  clearPendingToolkitItem();
  setBackend(null);
});

const open = async () => {
  await userEvent.keyboard("{Control>}k{/Control}");
  return screen.findByRole("dialog", { name: "Quick jump" });
};
const field = () => screen.getByRole("combobox", { name: "Jump to" });
const options = () => screen.getAllByRole("option");
const selected = () => options().find((o) => o.getAttribute("aria-selected") === "true");

describe("Quick jump: opening and closing", () => {
  it("opens with Ctrl+K on the field, listing every page first; Escape closes and gives focus back", async () => {
    mount("dashboard", true);
    const before = screen.getByRole("button", { name: "Settings" });
    before.focus();
    const dlg = await open();
    expect(field()).toHaveFocus();
    const names = within(dlg)
      .getAllByRole("option")
      .map((o) => o.querySelector(".qj-title")?.textContent);
    expect(names.slice(0, 7)).toEqual(["Dashboard", "Now", "Sessions", "Toolkit", "History", "Settings", "Wrapped"]);
    expect(options()[2]).toHaveTextContent("Ctrl+3");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Quick jump" })).not.toBeInTheDocument();
    expect(before).toHaveFocus();
  });

  it("draws no key hints while Show shortcuts is off", async () => {
    mount();
    const dlg = await open();
    expect(options()[2]).not.toHaveTextContent("Ctrl+3");
    expect(options()[2]).toHaveTextContent("Page");
    expect(dlg.querySelector("kbd")).toBeNull();
  });

  it("Ctrl+K again closes it, and a press on the scrim does too", async () => {
    mount();
    await open();
    await userEvent.keyboard("{Control>}k{/Control}");
    expect(screen.queryByRole("dialog", { name: "Quick jump" })).not.toBeInTheDocument();
    await open();
    await userEvent.click(document.querySelector(".qj-scrim") as HTMLElement);
    expect(screen.queryByRole("dialog", { name: "Quick jump" })).not.toBeInTheDocument();
  });

  it("keeps the other shortcuts: Ctrl+number still jumps, and nothing leaks through while it is open", async () => {
    mount();
    await userEvent.keyboard("{Control>}6{/Control}");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    await open();
    const side = document.querySelector(".app-shell")!.getAttribute("data-side");
    await userEvent.keyboard("{Control>}b{/Control}{Control>}1{/Control}");
    expect(document.querySelector(".app-shell")!.getAttribute("data-side")).toBe(side);
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  });
});

describe("Quick jump: moving and going", () => {
  it("arrows move the pick and wrap; Home of the list is the first row", async () => {
    mount();
    await open();
    expect(selected()).toBe(options()[0]);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(selected()).toBe(options()[2]);
    expect(field()).toHaveAttribute("aria-activedescendant", options()[2]!.id);
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(selected()).toBe(options()[options().length - 1]);
    await userEvent.keyboard("{ArrowDown}");
    expect(selected()).toBe(options()[0]);
  });

  it("types a page and goes there with Enter", async () => {
    mount();
    await open();
    await userEvent.keyboard("sett");
    expect(selected()!.querySelector(".qj-title")).toHaveTextContent("Settings");
    expect(selected()!.querySelector(".qj-hit")).toHaveTextContent("Sett");
    await userEvent.keyboard("{Enter}");
    expect(screen.queryByRole("dialog", { name: "Quick jump" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
  });

  it("says so when nothing matches, and Enter then does nothing", async () => {
    mount();
    await open();
    await userEvent.keyboard("qqqqzzzz{Enter}");
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Quick jump" })).toBeInTheDocument();
  });

  it("clicking a row goes there", async () => {
    mount();
    await open();
    await userEvent.click(options()[4]!);
    expect(screen.getByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
  });
});

describe("Quick jump: chats, projects and the Toolkit", () => {
  it("finds a chat by its title and opens it", async () => {
    const backend = mount();
    const rows = (await backend.sessionsList({ limit: 20 })).rows;
    const target = rows.find((r) => r.name)!;
    await open();
    await userEvent.keyboard(target.name!);
    const hit = await screen.findAllByRole("option", { name: new RegExp(target.name!.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    expect(hit.length).toBeGreaterThan(0);
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: "Who used it" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(target.name);
  });

  it("opens a chat even when Sessions is already the page", async () => {
    const backend = mount("sessions");
    const rows = (await backend.sessionsList({ limit: 20 })).rows;
    const target = rows.find((r) => r.name)!;
    await screen.findByRole("region", { name: "Pick up where you left off" });
    await open();
    await userEvent.keyboard(target.name!);
    await screen.findAllByRole("option", { name: new RegExp(target.name!.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: "Who used it" })).toBeInTheDocument();
  });

  it("a project shows that project's chats", async () => {
    const backend = mount();
    const project = (await backend.usageFilterOptions()).projects[0]!;
    await open();
    await userEvent.keyboard(project.name);
    const row = await screen.findByRole("option", { name: new RegExp(`^${project.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Project$`) });
    await userEvent.click(row);
    expect(await screen.findByRole("button", { name: "Filter, 1 changed" })).toBeInTheDocument();
  });

  it("lists a skill from the Toolkit and goes to the Toolkit", async () => {
    const backend = mount();
    const skill = (await backend.setupSnapshot()).items.find((i) => i.kind === "skill")!;
    await open();
    await userEvent.keyboard(skill.name);
    const row = await screen.findByRole("option", { name: new RegExp(`${skill.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*Skill$`) });
    await userEvent.click(row);
    expect(screen.getByRole("heading", { level: 1, name: "Toolkit" })).toBeInTheDocument();
  });

  it("finds a chat by words inside it and shows where they are", async () => {
    const backend = mount();
    const rows = (await backend.sessionsList({ limit: 20 })).rows;
    const target = rows[5]!;
    backend.searchChats = async (q) => ({
      hits:
        q.trim() === "zqword"
          ? [
              {
                id: 1,
                sessionId: target.sessionId,
                agentId: null,
                project: target.projectPath,
                projectName: target.projectName,
                ts: Date.now(),
                role: "user" as const,
                snippet: [
                  { text: "Why does the ", hit: false },
                  { text: "zqword", hit: true },
                  { text: " keep firing?", hit: false },
                ],
              },
            ]
          : [],
      hasMore: false,
      tookMs: 1,
      index: { state: "idle", ready: true, filesDone: 1, filesTotal: 1, bytesDone: 1, bytesTotal: 1, messages: 1, dbBytes: 1, lastIndexedAt: 1, error: null },
    });
    await open();
    await userEvent.keyboard("zqword");
    const row = await screen.findByRole("option", { name: /keep firing/ });
    expect(row.querySelector(".qj-sub")).toHaveTextContent("Why does the zqword keep firing?");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("region", { name: "Who used it" })).toBeInTheDocument();
  });
});
