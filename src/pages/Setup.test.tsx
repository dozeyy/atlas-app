import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { mockSetupSnapshot } from "../lib/setup-mock";
import { resetSetupStore } from "../state/setupStore";
import type { SetupSnapshot } from "../lib/setup-types";

// CodeMirror needs real layout; the viewer is checked in the running app instead.
vi.mock("../lib/codemirror", () => ({
  mountViewer: async (el: HTMLElement, text: string) => {
    const pre = document.createElement("pre");
    pre.textContent = text;
    pre.setAttribute("data-testid", "source");
    el.appendChild(pre);
    return { destroy: () => pre.remove() };
  },
}));

const SECRET = "mock-secret-value-0000";

class Backend extends MockBackend {
  snapshot: () => Promise<SetupSnapshot> = () => mockSetupSnapshot(false);
  reveals = 0;
  async setupSnapshot(w?: boolean): Promise<SetupSnapshot> {
    return w ? mockSetupSnapshot(true) : this.snapshot();
  }
  async setupReveal(id: string, i: number): Promise<string> {
    this.reveals += 1;
    return super.setupReveal(id, i);
  }
}

async function open(b: Backend) {
  setBackend(b);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
  await userEvent.click(screen.getByRole("button", { name: "Setup" }));
}

let backend: Backend;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  resetSetupStore();
  backend = new Backend();
});
afterEach(() => {
  vi.useRealTimers();
  resetSetupStore();
});

describe("Setup page", () => {
  it("shows placeholders only while the first scan runs, then the whole setup", async () => {
    let done!: (s: SetupSnapshot) => void;
    backend.snapshot = () => new Promise((r) => (done = r));
    await open(backend);
    expect(screen.getByRole("status", { name: "Reading your Claude setup" })).toBeInTheDocument();
    expect(screen.queryByText("No Claude setup found here")).not.toBeInTheDocument();

    await act(async () => done(await mockSetupSnapshot(false)));
    expect(screen.queryByRole("status", { name: "Reading your Claude setup" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Skills" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "MCP servers" })).toBeInTheDocument();
    expect(screen.getByText("commit-helper")).toBeInTheDocument();
    expect(screen.getByText("Read only")).toBeInTheDocument();
  });

  it("is already full when opened, because loading starts before the page does", async () => {
    const { startSetup } = await import("../state/setupStore");
    setBackend(backend);
    startSetup();
    await waitFor(() => expect(backend).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
    });
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Setup" }));
    // No loading state in between: the data was fetched ahead.
    expect(screen.queryByRole("status", { name: "Reading your Claude setup" })).not.toBeInTheDocument();
    expect(screen.getByText("commit-helper")).toBeInTheDocument();
  });

  it("counts by type and by where it lives", async () => {
    await open(backend);
    const tiles = await screen.findByRole("list", { name: "Filter by type" });
    expect(within(tiles).getByRole("button", { name: /Skills/ })).toBeInTheDocument();
    expect(screen.getByText(/things set up across 2 projects/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Global \d+, Project \d+/ })).toBeInTheDocument();
  });

  it("searches as you type and can be cleared", async () => {
    await open(backend);
    await screen.findByText("commit-helper");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search your setup" }), "commit");
    await waitFor(() => expect(screen.queryByText("deep-research")).not.toBeInTheDocument());
    expect(screen.getByText("commit-helper")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "zzzz");
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(await screen.findByText("deep-research")).toBeInTheDocument();
  });

  it("filters by type from the summary tiles", async () => {
    await open(backend);
    const tiles = await screen.findByRole("list", { name: "Filter by type" });
    const mcp = within(tiles).getByRole("button", { name: /MCP servers/ });
    await userEvent.click(mcp);
    expect(mcp).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("heading", { level: 2, name: "Skills" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "MCP servers" })).toBeInTheDocument();
    await userEvent.click(mcp);
    expect(screen.getByRole("heading", { level: 2, name: "Skills" })).toBeInTheDocument();
  });

  it("narrows by where things live: All, Global, then one project", async () => {
    await open(backend);
    await screen.findByText("commit-helper");
    const scope = screen.getByLabelText("Show items from");
    const project = "Project copy of a shared skill.";
    expect(screen.getByText(project)).toBeInTheDocument();

    await userEvent.click(within(scope).getByRole("radio", { name: "Global" }));
    await waitFor(() => expect(screen.queryByText(project)).not.toBeInTheDocument());
    expect(screen.getByText("commit-helper")).toBeInTheDocument();

    await userEvent.click(within(scope).getByRole("radio", { name: "Projects" }));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Project" }), "p-atlas");
    expect(await screen.findByText(project)).toBeInTheDocument();
    expect(screen.queryByText("commit-helper")).not.toBeInTheDocument();
  });

  it("folds and unfolds a group", async () => {
    await open(backend);
    const head = (await screen.findAllByRole("button", { name: /Agents/ })).find((b) => b.hasAttribute("aria-expanded"))!;
    expect(head).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("code-reviewer")).not.toBeInTheDocument();
  });

  it("opens the detail view on click and closes it with Escape, returning focus", async () => {
    await open(backend);
    const card = await screen.findByRole("button", { name: /skill commit-helper/ });
    card.focus();
    await userEvent.click(card);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "commit-helper" })).toBeInTheDocument();
    expect(within(dialog).getByText("references/style.md")).toBeInTheDocument();
    expect(await within(dialog).findByTestId("source")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(card).toHaveFocus();
  });

  it("opens the detail view with Enter on a focused card", async () => {
    await open(backend);
    const card = await screen.findByRole("button", { name: /skill commit-helper/ });
    card.focus();
    await userEvent.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "commit-helper" })).toBeInTheDocument();
  });

  it("walks the cards with the arrow keys and stops at both ends", async () => {
    await open(backend);
    await screen.findByText("commit-helper");
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>("[data-item-card]"));
    const first = cards()[0]!;
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(cards()[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowUp}");
    expect(cards()[1]).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}{ArrowUp}{ArrowUp}");
    expect(first).toHaveFocus();
  });

  it("shows which item wins when two define the same thing, and jumps between them", async () => {
    await open(backend);
    const winner = (await screen.findAllByRole("button", { name: /skill shared-skill, Global/ }))[0];
    await userEvent.click(winner);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Also defined elsewhere")).toBeInTheDocument();
    expect(within(dialog).getByText("Overrides Project · atlas")).toBeInTheDocument();
  });

  it("never puts a secret on the page until you ask, shows one value, and hides it again", async () => {
    await open(backend);
    await userEvent.click(await screen.findByRole("button", { name: /MCP server github/ }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Hidden values");
    expect(document.body.textContent).not.toContain(SECRET);
    expect(backend.reveals).toBe(0);

    await userEvent.click(within(dialog).getByRole("button", { name: "Show value of GITHUB_TOKEN" }));
    expect(await within(dialog).findByText(SECRET)).toBeInTheDocument();
    expect(backend.reveals).toBe(1);

    await userEvent.click(within(dialog).getByRole("button", { name: "Hide" }));
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("hides a shown value by itself after ten seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open(backend);
    await userEvent.click(await screen.findByRole("button", { name: /MCP server github/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Show value of GITHUB_TOKEN" }));
    expect(await within(dialog).findByText(SECRET)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(10_100);
    });
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("explains a failed scan and tries again", async () => {
    let calls = 0;
    backend.snapshot = async () => {
      calls += 1;
      if (calls === 1) throw new Error("The Claude folder could not be read.");
      return mockSetupSnapshot(false);
    };
    await open(backend);
    expect(await screen.findByText("Atlas could not read your Claude setup")).toBeInTheDocument();
    expect(screen.getByText("The Claude folder could not be read.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("commit-helper")).toBeInTheDocument();
  });

  it("says so when there is nothing in the folder", async () => {
    backend.snapshot = async () => ({ ...(await mockSetupSnapshot(false)), items: [], projects: [] });
    await open(backend);
    expect(await screen.findByText("No Claude setup found here")).toBeInTheDocument();
  });

  it("puts projects that no longer exist in their own folded section", async () => {
    await open(backend);
    const head = await screen.findByRole("button", { name: /Projects no longer on disk/ });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("gone-srv")).not.toBeInTheDocument();
    await userEvent.click(head);
    expect(screen.getByText("gone-srv")).toBeInTheDocument();
  });

  it("reloads when the files change", async () => {
    await open(backend);
    await screen.findByText("commit-helper");
    const next = await mockSetupSnapshot(false);
    next.items = next.items.filter((i) => i.name !== "commit-helper");
    backend.snapshot = async () => next;
    const { reloadSetup } = await import("../state/setupStore");
    await act(async () => reloadSetup());
    await waitFor(() => expect(screen.queryByText("commit-helper")).not.toBeInTheDocument());
  });
});
