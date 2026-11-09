import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../App";
import { AtlasProvider } from "../state/AtlasProvider";
import { setBackend } from "../lib/ipc";
import { MockBackend } from "../lib/mock";
import { mockSetupSnapshot } from "../lib/setup-mock";
import { reloadSetup, resetSetupStore } from "../state/setupStore";
import { CELEBRATE_MS, CHECKLIST_DONE_KEY } from "../components/setup/TopSlot";
import { resetToasts } from "../state/toastStore";
import type { SetupSnapshot } from "../lib/setup-types";

// CodeMirror needs real layout; the viewer and editor are checked in the running app instead.
// The editor stand-in is a textarea that reports edits the same way.
vi.mock("../lib/codemirror", () => ({
  mountViewer: async (el: HTMLElement, text: string) => {
    const pre = document.createElement("pre");
    pre.textContent = text;
    pre.setAttribute("data-testid", "source");
    el.appendChild(pre);
    return { destroy: () => pre.remove() };
  },
  mountEditor: async (el: HTMLElement, text: string, _lang: string, opts: { label: string; onChange: (t: string) => void }) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("aria-label", opts.label);
    ta.addEventListener("input", () => opts.onChange(ta.value));
    el.appendChild(ta);
    return {
      focus: () => ta.focus(),
      markLine: () => {},
      setText: (t: string) => {
        ta.value = t;
        opts.onChange(t);
      },
      destroy: () => ta.remove(),
    };
  },
}));

const SECRET = "mock-secret-value-0000";

class Backend extends MockBackend {
  snapshot: (() => Promise<SetupSnapshot>) | null = null;
  reveals = 0;
  async setupSnapshot(w?: boolean): Promise<SetupSnapshot> {
    return this.snapshot ? this.snapshot() : super.setupSnapshot(w);
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
  await userEvent.click(screen.getByRole("button", { name: "Toolkit" }));
}

async function openTile(label: string) {
  await userEvent.click(await screen.findByRole("button", { name: new RegExp(`^${label}, \\d+$`) }));
  return screen.findByRole("heading", { level: 2, name: label });
}

async function openTilesReady() {
  await screen.findByRole("button", { name: /^Skills, \d+$/ });
}

let backend: Backend;
beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  resetSetupStore();
  resetToasts();
  backend = new Backend();
});
afterEach(() => {
  vi.useRealTimers();
  resetSetupStore();
  resetToasts();
});

describe("Setup page: main view", () => {
  it("shows placeholders only while the first scan runs, then the tiles with no checklist once setup is complete", async () => {
    let done!: (s: SetupSnapshot) => void;
    backend.snapshot = () => new Promise((r) => (done = r));
    await open(backend);
    expect(screen.getByRole("status", { name: "Reading your toolkit" })).toBeInTheDocument();
    expect(screen.queryByText("No toolkit found here")).not.toBeInTheDocument();

    await act(async () => done(await mockSetupSnapshot(false)));
    expect(screen.queryByRole("status", { name: "Reading your toolkit" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Types of things in your toolkit" })).toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Toolkit progress" })).not.toBeInTheDocument();
  });

  it("has no summary card, no Read only chip and no Live tag anywhere", async () => {
    await open(backend);
    await screen.findByRole("list", { name: "Types of things in your toolkit" });
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/Read only/);
    expect(text).not.toMatch(/\bLive\b/);
    expect(text).not.toMatch(/Coming soon/i);
    expect(text).not.toMatch(/things set up across/);
  });

  it("has no Recently changed or Worth a look section, only the tiles", async () => {
    await open(backend);
    await screen.findByRole("list", { name: "Types of things in your toolkit" });
    expect(screen.queryByRole("heading", { name: "Recently changed" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Worth a look" })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Recently changed|Worth a look/);
  });

  it("never lets a pressable clip its own box (that is what made edge clicks miss)", async () => {
    // A press shrinks the element; content-visibility / overflow clipping on the element itself would
    // also clip the invisible hit box that keeps its edges clickable. jsdom has no layout, so check the contract.
    await open(backend);
    await screen.findByRole("list", { name: "Types of things in your toolkit" });
    const bad = (root: ParentNode) =>
      [...root.querySelectorAll<HTMLElement>(".press")].filter((e) => /content-visibility|overflow-hidden|\btruncate\b/.test(e.className)).map((e) => e.getAttribute("aria-label") ?? e.textContent);
    expect(bad(document)).toEqual([]);
    await userEvent.click(await screen.findByRole("button", { name: /^More, \d+$/ }));
    await screen.findByRole("heading", { level: 2, name: "More" });
    expect(bad(document)).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Back to Toolkit" }));
    await userEvent.click(await screen.findByRole("button", { name: /^Skills, \d+$/ }));
    await screen.findByRole("heading", { level: 2, name: "Skills" });
    expect(bad(document)).toEqual([]);
  });

  it("lays the types out as twelve equal tiles with their counts", async () => {
    await open(backend);
    const list = await screen.findByRole("list", { name: "Types of things in your toolkit" });
    const tiles = within(list).getAllByRole("button");
    expect(tiles).toHaveLength(12);
    expect(new Set(tiles.map((t) => t.className.match(/h-\[\d+px\]/)?.[0])).size).toBe(1);
    expect(within(list).getByRole("button", { name: /^Skills, \d+$/ })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: /^More, \d+$/ })).toBeInTheDocument();
  });

  it("is already full when opened, because loading starts before the page does", async () => {
    const { startSetup } = await import("../state/setupStore");
    setBackend(backend);
    startSetup();
    await act(async () => {
      await Promise.resolve();
    });
    render(
      <AtlasProvider>
        <App />
      </AtlasProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Toolkit" }));
    expect(screen.queryByRole("status", { name: "Reading your toolkit" })).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Types of things in your toolkit" })).toBeInTheDocument();
  });

  it("explains a failed scan and tries again", async () => {
    let calls = 0;
    backend.snapshot = async () => {
      calls += 1;
      if (calls === 1) throw new Error("The Claude folder could not be read.");
      return mockSetupSnapshot(false);
    };
    await open(backend);
    expect(await screen.findByText("Atlas could not read your toolkit")).toBeInTheDocument();
    expect(screen.getByText("The Claude folder could not be read.")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("list", { name: "Types of things in your toolkit" })).toBeInTheDocument();
  });

  it("says so when there is nothing in the folder", async () => {
    backend.snapshot = async () => ({ ...(await mockSetupSnapshot(false)), items: [], projects: [], root: { ...(await mockSetupSnapshot(false)).root, dirExists: false } });
    await open(backend);
    expect(await screen.findByText("No toolkit found here")).toBeInTheDocument();
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
    await openTile("Skills");
    await screen.findByText("commit-helper");
    const next = await mockSetupSnapshot(false);
    next.items = next.items.filter((i) => i.name !== "commit-helper");
    backend.snapshot = async () => next;
    const { reloadSetup } = await import("../state/setupStore");
    await act(async () => reloadSetup());
    await waitFor(() => expect(screen.queryByText("commit-helper")).not.toBeInTheDocument());
  });
});

describe("Setup page: a collection", () => {
  it("opens a tile as its own view with a way back that returns focus to the tile", async () => {
    await open(backend);
    await openTile("Skills");
    expect(screen.getByText("commit-helper")).toBeInTheDocument();
    expect(screen.queryByText("code-reviewer")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar", { name: "Toolkit progress" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Back to Toolkit" }));
    const tile = await screen.findByRole("button", { name: /^Skills, \d+$/ });
    expect(screen.getByRole("list", { name: "Types of things in your toolkit" })).toBeInTheDocument();
    await waitFor(() => expect(tile).toHaveFocus());
  });

  it("searches as you type and can be cleared", async () => {
    await open(backend);
    await openTile("Skills");
    await userEvent.type(screen.getByRole("searchbox", { name: "Search skills" }), "commit");
    await waitFor(() => expect(screen.queryByText("deep-research")).not.toBeInTheDocument());
    expect(screen.getByText("commit-helper")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "zzzz");
    expect(await screen.findByText("Nothing matches")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(await screen.findByText("deep-research")).toBeInTheDocument();
  });

  it("narrows by where things live: All, Global, then one project", async () => {
    await open(backend);
    await openTile("Skills");
    // The scope, project and show/hide options live behind one Filters button.
    await userEvent.click(screen.getByRole("button", { name: "Filters" }));
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
    // The button says how many options are changed, and Reset puts them back.
    expect(screen.getByRole("button", { name: "Filters, 2 changed" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(await screen.findByText("commit-helper")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Filters" })).toBeInTheDocument();
  });

  it("walks the cards with the arrow keys and stops at both ends", async () => {
    await open(backend);
    await openTile("Skills");
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
});

describe("Setup page: detail", () => {
  it("opens the detail view on click and closes it with Escape, returning focus", async () => {
    await open(backend);
    await openTile("Skills");
    const card = await screen.findByRole("button", { name: /skill commit-helper/ });
    card.focus();
    await userEvent.click(card);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { level: 2, name: "commit-helper" })).toBeInTheDocument();
    expect(within(dialog).getByText("references/style.md")).toBeInTheDocument();
    expect(await within(dialog).findByTestId("source")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(card).toHaveFocus();
  });

  it("shows which item wins when two define the same thing", async () => {
    await open(backend);
    await openTile("Skills");
    const winner = (await screen.findAllByRole("button", { name: /skill shared-skill, Global/ }))[0]!;
    await userEvent.click(winner);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Also defined elsewhere")).toBeInTheDocument();
    expect(within(dialog).getByText("Overrides Project · atlas")).toBeInTheDocument();
  });

  it("shows the agent's model and tools and a rendered preview of the text", async () => {
    await open(backend);
    await openTile("Agents");
    await userEvent.click(await screen.findByRole("button", { name: /agent code-reviewer/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Model")).toBeInTheDocument();
    expect(within(dialog).getByText("Tools")).toBeInTheDocument();
    expect(within(dialog).getByText("Preview")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("never puts a secret on the page until you ask, shows one value, and hides it again", async () => {
    await open(backend);
    await openTile("MCP servers");
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
    await openTile("MCP servers");
    await userEvent.click(await screen.findByRole("button", { name: /MCP server github/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("button", { name: "Show value of GITHUB_TOKEN" }));
    expect(await within(dialog).findByText(SECRET)).toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime(10_100);
    });
    expect(document.body.textContent).not.toContain(SECRET);
  });
});

describe("Setup page: delete", () => {
  it("asks first, names what goes away and promises a backup; Cancel changes nothing", async () => {
    await open(backend);
    await openTile("Skills");
    await userEvent.click(await screen.findByRole("button", { name: "Delete deep-research" }));
    const ask = await screen.findByRole("alertdialog", { name: "Delete deep-research?" });
    expect(within(ask).getByText(/whole folder/)).toBeInTheDocument();
    expect(within(ask).getByText(/Atlas keeps a backup/)).toBeInTheDocument();
    await userEvent.click(within(ask).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByText("deep-research")).toBeInTheDocument();
  });

  it("deletes for real, offers Undo, and Undo puts it back", async () => {
    await open(backend);
    await openTile("Skills");
    await userEvent.click(await screen.findByRole("button", { name: "Delete deep-research" }));
    const ask = await screen.findByRole("alertdialog");
    await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /skill deep-research/ })).not.toBeInTheDocument());
    const toast = await screen.findByText("Deleted deep-research.");
    expect(toast).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Put deep-research back exactly as it was.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /skill deep-research/ })).toBeInTheDocument();
  });

  it("shows an error and leaves everything alone when the delete fails", async () => {
    backend.setupDelete = async () => {
      throw new Error("Atlas could not make the backup, so nothing was deleted.");
    };
    await open(backend);
    await openTile("Skills");
    await userEvent.click(await screen.findByRole("button", { name: "Delete deep-research" }));
    const ask = await screen.findByRole("alertdialog");
    await userEvent.click(within(ask).getByRole("button", { name: "Delete" }));
    expect(await within(ask).findByText(/could not make the backup/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /skill deep-research/ })).toBeInTheDocument();
  });

  it("shows why plugin and synced items cannot be deleted instead of an X", async () => {
    await open(backend);
    await openTile("Skills");
    expect(screen.queryByRole("button", { name: "Delete anthropic-skills:docx" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete helpers:triage" })).not.toBeInTheDocument();
    const lock = screen.getByRole("button", { name: /^anthropic-skills:docx is locked\./ });
    await userEvent.click(lock);
    expect(await screen.findAllByText("Synced from your claude.ai account. Manage it there.")).not.toHaveLength(0);
  });

  it("keeps the X reachable from the keyboard", async () => {
    await open(backend);
    await openTile("Skills");
    const x = await screen.findByRole("button", { name: "Delete deep-research" });
    x.focus();
    expect(x).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("alertdialog", { name: "Delete deep-research?" })).toBeInTheDocument();
  });
});

describe("Setup page: edit", () => {
  async function openEditor(tile: string, card: RegExp) {
    await open(backend);
    await openTile(tile);
    await userEvent.click(await screen.findByRole("button", { name: card }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    const ta = await within(dialog).findByRole("textbox", { name: /^Editing / });
    return { dialog, ta: ta as HTMLTextAreaElement };
  }

  it("keeps Save off until something changes, then saves with a backup toast", async () => {
    const { dialog, ta } = await openEditor("Skills", /skill deep-research/);
    const save = within(dialog).getByRole("button", { name: /^Save/ });
    await waitFor(() => expect(within(dialog).getByText("Looks good.")).toBeInTheDocument());
    expect(save).toBeDisabled();

    fireEvent.input(ta, { target: { value: ta.value + "\nOne more line.\n" } });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await screen.findByText(/Saved deep-research\. The old version is backed up\./)).toBeInTheDocument();
  });

  it("disables Save and says what is wrong, with the line, while the text is invalid", async () => {
    await open(backend);
    await openTile("MCP servers");
    await userEvent.click(await screen.findByRole("button", { name: /MCP server docs/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    // a server with secrets asks before showing the text
    await userEvent.click(await within(dialog).findByRole("button", { name: "Show secrets and edit" }));
    const box = (await within(dialog).findByRole("textbox", { name: /^Editing / })) as HTMLTextAreaElement;
    fireEvent.input(box, { target: { value: "{ not json" } });
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent(/\S/);
    expect(within(dialog).getByRole("button", { name: /^Save/ })).toBeDisabled();

    fireEvent.input(box, { target: { value: '{ "command": "node" }' } });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Save/ })).toBeEnabled());
  });

  it("rejects a skill whose name no longer matches its folder", async () => {
    const { dialog, ta } = await openEditor("Skills", /skill deep-research/);
    fireEvent.input(ta, { target: { value: "---\nname: something-else\ndescription: x\n---\nBody\n" } });
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/deep-research/);
    expect(within(dialog).getByRole("button", { name: /^Save/ })).toBeDisabled();
  });

  it("asks before throwing away edits, from Cancel, Close and Escape", async () => {
    const { dialog, ta } = await openEditor("Skills", /skill deep-research/);
    fireEvent.input(ta, { target: { value: ta.value + "\nunsaved" } });

    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    const ask = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: /^Editing / })).toHaveValue(ta.value);

    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    const ask2 = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await userEvent.click(within(ask2).getByRole("button", { name: "Discard" }));
    expect(screen.queryByRole("textbox", { name: /^Editing / })).not.toBeInTheDocument();
  });

  it("does not ask when nothing was changed", async () => {
    const { dialog } = await openEditor("Skills", /skill deep-research/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: /^Editing / })).not.toBeInTheDocument();
  });

  it("saves with Ctrl+S semantics through the same path (Save button label shows the shortcut)", async () => {
    const { dialog } = await openEditor("Skills", /skill deep-research/);
    expect(within(dialog).getByRole("button", { name: /^Save/ })).toHaveAttribute("title", expect.stringContaining("Ctrl S"));
  });

  it("notices the file changed on disk and lets you keep, reload or replace", async () => {
    const { dialog, ta } = await openEditor("Skills", /skill deep-research/);
    const id = (await backend.setupSnapshot()).items.find((i) => i.name === "deep-research")!.id;
    backend.world.touch(id, "---\nname: deep-research\ndescription: changed elsewhere\n---\nNew body\n");

    fireEvent.input(ta, { target: { value: ta.value + "\nmine" } });
    const save = within(dialog).getByRole("button", { name: /^Save/ });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    const ask = await screen.findByRole("alertdialog", { name: "This file changed on your computer" });
    await userEvent.click(within(ask).getByRole("button", { name: "Load the new version" }));
    const box = (await within(dialog).findByRole("textbox", { name: /^Editing / })) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toContain("changed elsewhere"));
  });

  it("holds back a file with secrets until you choose to show them", async () => {
    await open(backend);
    await openTile("MCP servers");
    await userEvent.click(await screen.findByRole("button", { name: /MCP server github/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    expect(await within(dialog).findByText(/holds secret values/)).toBeInTheDocument();
    expect(within(dialog).queryByRole("textbox", { name: /^Editing / })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain(SECRET);
    await userEvent.click(within(dialog).getByRole("button", { name: "Show secrets and edit" }));
    expect(await within(dialog).findByRole("textbox", { name: /^Editing / })).toBeInTheDocument();
    expect(within(dialog).getByText("Secret values are showing while you edit.")).toBeInTheDocument();
  });
});

describe("Setup page: a skill's files and actions", () => {
  async function openSkill(card: RegExp) {
    await open(backend);
    await openTile("Skills");
    await userEvent.click(await screen.findByRole("button", { name: card }));
    return screen.findByRole("dialog");
  }
  async function edit(dialog: HTMLElement) {
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit" }));
    return (await within(dialog).findByRole("textbox", { name: /^Editing / })) as HTMLTextAreaElement;
  }

  it("stays in the editor after saving and says it saved", async () => {
    const dialog = await openSkill(/skill deep-research/);
    const ta = await edit(dialog);
    fireEvent.input(ta, { target: { value: ta.value + "\nOne more line.\n" } });
    const save = within(dialog).getByRole("button", { name: /^Save/ });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);
    expect(await within(dialog).findByText("Saved. The old version is backed up.")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: /^Editing / })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Save/ })).toBeDisabled());
  });

  it("shows the description as a field that edits the file's header", async () => {
    const dialog = await openSkill(/skill deep-research/);
    const ta = await edit(dialog);
    const name = within(dialog).getByLabelText("Name");
    expect(name).toBeDisabled();
    const desc = within(dialog).getByLabelText("Description");
    expect(desc).toHaveValue("Research a topic across sources and write it up.");
    fireEvent.change(desc, { target: { value: "Find sources fast" } });
    await waitFor(() => expect(ta.value).toContain("description: Find sources fast\n"));
    expect(ta.value).toContain("name: deep-research\n");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Save/ })).toBeEnabled());
  });

  it("switches between a skill's files and asks before dropping edits", async () => {
    const dialog = await openSkill(/skill commit-helper/);
    const ta = await edit(dialog);
    const tabs = within(dialog).getByRole("tablist", { name: "Files in this skill" });
    const [main, other] = within(tabs).getAllByRole("tab");
    expect(main).toHaveTextContent("SKILL.md");
    expect(other).toHaveTextContent("references/style.md");

    fireEvent.input(ta, { target: { value: ta.value + "\nunsaved" } });
    await userEvent.click(other!);
    const ask = await screen.findByRole("alertdialog", { name: "Discard your changes?" });
    await userEvent.click(within(ask).getByRole("button", { name: "Keep editing" }));
    expect(main).toHaveAttribute("aria-selected", "true");

    await userEvent.click(other!);
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Discard" }));
    const second = await within(dialog).findByRole("textbox", { name: "Editing commit-helper references/style.md" });
    expect(second).toBeInTheDocument();
    // The header fields belong to SKILL.md only.
    expect(within(dialog).queryByLabelText("Description")).not.toBeInTheDocument();
  });

  it("opens a supporting file straight from the list of files", async () => {
    const dialog = await openSkill(/skill commit-helper/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Edit references/style.md" }));
    expect(await within(dialog).findByRole("textbox", { name: "Editing commit-helper references/style.md" })).toBeInTheDocument();
  });

  it("shows the file in its folder and opens it in the default editor", async () => {
    const dialog = await openSkill(/skill deep-research/);
    const id = (await backend.setupSnapshot()).items.find((i) => i.name === "deep-research")!.id;
    await userEvent.click(within(dialog).getByRole("button", { name: "Show in folder" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Open in editor" }));
    expect(backend.opened).toEqual([
      { id, file: undefined, open: false },
      { id, file: undefined, open: true },
    ]);
  });

  it("duplicates a skill under a new name and refuses one that exists", async () => {
    const dialog = await openSkill(/skill deep-research/);
    await userEvent.click(within(dialog).getByRole("button", { name: "Duplicate" }));
    const ask = await screen.findByRole("dialog", { name: "Duplicate skill" });
    const box = within(ask).getByLabelText("Name of the copy");
    expect(box).toHaveValue("deep-research-copy");

    fireEvent.change(box, { target: { value: "commit-helper" } });
    expect(within(ask).getByText("You already have a skill with that name.")).toBeInTheDocument();
    expect(within(ask).getByRole("button", { name: "Duplicate" })).toBeDisabled();

    fireEvent.change(box, { target: { value: "deep-research-copy" } });
    await userEvent.click(within(ask).getByRole("button", { name: "Duplicate" }));
    expect(await screen.findByText("Made deep-research-copy as a copy of deep-research.")).toBeInTheDocument();
    expect((await backend.setupSnapshot()).items.some((i) => i.name === "deep-research-copy")).toBe(true);
  });
});

describe("Setup page: checklist and create", () => {
  it("is not on the page at all once everything is in place", async () => {
    await open(backend);
    await openTilesReady();
    expect(screen.queryByRole("progressbar", { name: "Toolkit progress" })).not.toBeInTheDocument();
    expect(screen.queryByText(/your toolkit/i)).not.toBeInTheDocument();
    expect(localStorage.getItem(CHECKLIST_DONE_KEY)).toBe("1");
  });

  it("celebrates once when the last step lands, then folds away", async () => {
    const snap = await mockSetupSnapshot(false);
    const full = snap.items;
    let current = { ...snap, items: full.filter((i) => i.kind !== "agent") };
    backend.snapshot = async () => current;
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await open(backend);
    expect(await screen.findByRole("heading", { name: "Finish your toolkit" })).toBeInTheDocument();
    current = { ...snap, items: full };
    act(() => reloadSetup());
    expect(await screen.findByRole("heading", { name: "Your toolkit is complete" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(CELEBRATE_MS + 200);
    });
    await waitFor(() => expect(screen.queryByRole("progressbar", { name: "Toolkit progress" })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Skills, \d+$/ })).toBeInTheDocument();
    expect(localStorage.getItem(CHECKLIST_DONE_KEY)).toBe("1");
  });

  it("does not celebrate a second time, and the card returns when a step becomes undone", async () => {
    const snap = await mockSetupSnapshot(false);
    const full = snap.items;
    let current = { ...snap, items: full };
    backend.snapshot = async () => current;
    await open(backend);
    await openTilesReady();
    expect(screen.queryByRole("progressbar", { name: "Toolkit progress" })).not.toBeInTheDocument();

    current = { ...snap, items: full.filter((i) => i.kind !== "agent") };
    act(() => reloadSetup());
    expect(await screen.findByRole("heading", { name: "Finish your toolkit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add an agent: Add your first agent" })).toBeInTheDocument();

    current = { ...snap, items: full };
    act(() => reloadSetup());
    await waitFor(() => expect(screen.queryByRole("progressbar", { name: "Toolkit progress" })).not.toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Your toolkit is complete" })).not.toBeInTheDocument();
  });

  it("keeps the Claude folder off the Setup page", async () => {
    await open(backend);
    await openTilesReady();
    expect(document.body.textContent).not.toContain("C:/Users/you/.claude");
    expect(screen.queryByText(/open folder/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open folder/i })).not.toBeInTheDocument();
  });

  it("does not print the folder on the empty state either", async () => {
    const snap = await mockSetupSnapshot(false);
    snap.items = [];
    snap.root = { ...snap.root, dirExists: false };
    backend.snapshot = async () => snap;
    await open(backend);
    expect(await screen.findByText("No toolkit found here")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("C:/Users/you/.claude");
    expect(screen.getByText(/choose it in Settings/)).toBeInTheDocument();
  });

  it("lists what is still to do with a button each, and counts progress", async () => {
    const snap = await mockSetupSnapshot(false);
    snap.items = snap.items.filter((i) => !(i.kind === "agent" || i.kind === "hook"));
    backend.snapshot = async () => snap;
    await open(backend);
    expect(await screen.findByRole("heading", { name: "Finish your toolkit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add an agent: Add your first agent" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add a hook: Set up a hook" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Make a skill/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /5 done/ }));
    expect(screen.getByText("Make your first skill")).toBeInTheDocument();
  });

  it("walks a step through name, template editor and Create", async () => {
    const snap = await mockSetupSnapshot(false);
    snap.items = snap.items.filter((i) => i.kind !== "agent");
    backend.snapshot = async () => snap;
    await open(backend);
    await userEvent.click(await screen.findByRole("button", { name: "Add an agent: Add your first agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New agent" });
    const name = within(dialog).getByRole("textbox");
    await userEvent.type(name, "triager");
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    const ta = (await within(dialog).findByRole("textbox", { name: "New agent" })) as HTMLTextAreaElement;
    expect(ta.value).toContain("triager");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: /^Create/ })).toBeEnabled());
    await userEvent.click(within(dialog).getByRole("button", { name: /^Create/ }));
    expect(await screen.findByText("Created triager.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New agent" })).not.toBeInTheDocument());
  });

  it("asks before dropping a half-written new item", async () => {
    const snap = await mockSetupSnapshot(false);
    snap.items = snap.items.filter((i) => i.kind !== "rule");
    backend.snapshot = async () => snap;
    await open(backend);
    await userEvent.click(await screen.findByRole("button", { name: /^Write a rule/ }));
    const dialog = await screen.findByRole("dialog", { name: "New rule" });
    await userEvent.type(within(dialog).getByRole("textbox"), "naming");
    await userEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    const ta = (await within(dialog).findByRole("textbox", { name: "New rule" })) as HTMLTextAreaElement;
    fireEvent.input(ta, { target: { value: ta.value + "\nmore" } });
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("alertdialog", { name: "Discard what you wrote?" })).toBeInTheDocument();
  });
});
