import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../App";
import { AtlasProvider } from "../../state/AtlasProvider";
import { resetSetupStore } from "../../state/setupStore";
import { resetLibraryStore } from "../../state/libraryStore";
import { resetToasts } from "../../state/toastStore";
import { closePalette } from "../../state/paletteStore";
import { setBackend } from "../../lib/ipc";
import { MockBackend } from "../../lib/mock";
import { clearPendingToolkitItem, clearPendingToolkitTab } from "../../lib/nav";
import { COMMAND_SOURCE, NO_CLI, OFFLINE } from "../../lib/library";

// CodeMirror needs real layout; the read-only viewer is checked in the running app.
vi.mock("../../lib/codemirror", () => ({
  mountViewer: async (el: HTMLElement, text: string) => {
    const pre = document.createElement("pre");
    pre.textContent = text;
    el.appendChild(pre);
    return { destroy: () => pre.remove() };
  },
  mountEditor: async () => ({ focus: () => {}, markLine: () => {}, destroy: () => {} }),
}));

let backend: MockBackend;
const lib = () => backend.library;

function mount(setup?: (b: MockBackend) => void, view = "setup") {
  localStorage.setItem("atlas.mock.settings", JSON.stringify({ lastView: view }));
  backend = new MockBackend();
  backend.library.delay = 0;
  setup?.(backend);
  setBackend(backend);
  render(
    <AtlasProvider>
      <App />
    </AtlasProvider>,
  );
}

const openLibraryTab = async () => {
  await userEvent.click(await screen.findByRole("radio", { name: "Library" }));
  await screen.findByRole("searchbox", { name: "Search plugins and skills" });
};
const row = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}\\.`) });
const installBtn = (name: string) => screen.findByRole("button", { name: `Install ${name}` });

beforeEach(() => {
  localStorage.clear();
  resetSetupStore();
  resetLibraryStore();
  resetToasts();
  clearPendingToolkitItem();
  clearPendingToolkitTab();
});
afterEach(() => {
  closePalette();
  resetLibraryStore();
  resetToasts();
  setBackend(null);
});

describe("Library tab: opening", () => {
  it("makes no Library request until the tab is opened, then loads the saved catalog once and reports the first rows", async () => {
    mount();
    await screen.findByRole("radio", { name: "Your setup" });
    expect(lib().calls).toEqual([]);
    await openLibraryTab();
    expect(await row("frontend-design")).toBeInTheDocument();
    expect(lib().calls.filter((c) => c === "catalog")).toHaveLength(1);
    expect(lib().calls).not.toContain("refresh"); // a copy 20 minutes old is not stale
    await waitFor(() => expect(lib().perf).toHaveLength(1));
  });

  it("paints the first page at once, counts the whole catalog, and filters over all of it once the rest arrives", async () => {
    mount((b) => {
      b.library.firstPage = 3;
    });
    await openLibraryTab();
    // A name that is not among the first three alphabetically: it arrives with the rest.
    await userEvent.type(screen.getByRole("searchbox", { name: "Search plugins and skills" }), "pdf");
    expect(await row("pdf-tools")).toBeInTheDocument();
    expect(lib().calls.filter((c) => c === "catalog")).toHaveLength(1);
    expect(lib().calls.filter((c) => c === "catalog-all")).toHaveLength(1);
    // The first answer carries three rows but the whole catalog's size and per-source counts.
    const first = await lib().libraryCatalog();
    expect(first.entries).toHaveLength(3);
    expect(first.partial).toBe(true);
    expect(first.total).toBe(lib().entries.length);
    expect(Object.values(first.counts).reduce((a, b) => a + b, 0)).toBe(first.total);
  });

  it("remembers the tab, and Left and Right switch tabs from the tab row", async () => {
    mount();
    await openLibraryTab();
    expect(localStorage.getItem("atlas.toolkit.tab")).toBe("library");
    const mine = screen.getByRole("radio", { name: "Your setup" });
    mine.focus();
    // The row is Your setup, Library, Team: Right from Library is Team, and Right again wraps to Your setup.
    await userEvent.keyboard("{ArrowRight}{ArrowRight}");
    expect(await screen.findByRole("radio", { name: "Your setup" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowRight}");
    expect(await screen.findByRole("radio", { name: "Library" })).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowLeft}");
    expect(await screen.findByRole("radio", { name: "Your setup" })).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("searchbox", { name: "Search plugins and skills" })).not.toBeInTheDocument();
  });

  it("filters as you type, and says so when nothing matches", async () => {
    mount();
    await openLibraryTab();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search plugins and skills" }), "pdf");
    expect(await row("pdf-tools")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^code-review\./ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox", { name: "Search plugins and skills" }), "zzz");
    expect(await screen.findByText("Nothing matches pdfzzz")).toBeInTheDocument();
    // The dead end offers the way out: one press brings the list back and leaves the caret in the box.
    await userEvent.click(screen.getByText("Clear search"));
    expect(await row("pdf-tools")).toBeInTheDocument();
    const box = screen.getByRole("searchbox", { name: "Search plugins and skills" });
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
  });

  it("says what to do when the catalog cannot be reached", async () => {
    mount((b) => {
      b.library.offline = true;
    });
    await openLibraryTab();
    expect(await screen.findByText(OFFLINE)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});

describe("Library tab: installing (D20, D24, D19 words)", () => {
  it("installs from the row in one click once the plugin has been checked and found clean", async () => {
    mount();
    await openLibraryTab();
    // Opening the plugin is what checks it.
    await userEvent.click(await row("pdf-tools"));
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findByText("Text only. Nothing here runs on its own.");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const inspects = lib().calls.filter((c) => c.startsWith("inspect:")).length;

    await userEvent.click(await installBtn("pdf-tools"));
    await waitFor(() => expect(lib().installed.map((r) => r.id)).toEqual(["pdf-tools@anthropic-plugin-directory"]));
    expect(lib().calls.filter((c) => c.startsWith("install:"))).toEqual(["install:pdf-tools@anthropic-plugin-directory"]);
    expect(lib().calls.filter((c) => c.startsWith("inspect:")).length).toBe(inspects); // no second look
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("a plugin that was not checked yet is checked by the row's Install and installed at once when clean", async () => {
    mount();
    await openLibraryTab();
    await userEvent.click(await installBtn("code-review"));
    await waitFor(() => expect(lib().installed).toHaveLength(1));
    const calls = lib().calls;
    expect(calls.findIndex((c) => c.startsWith("inspect:"))).toBeLessThan(calls.findIndex((c) => c.startsWith("install:")));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); // 1 click, no sheet
  });

  it("a plugin that follows a branch, not one exact version, is never installed from the row in one click", async () => {
    mount((b) => {
      b.library.entries = b.library.entries.map((e) => (e.name === "code-review" ? { ...e, source: { kind: "github" as const, repo: "example/code-review", sha: null, path: null } } : e));
    });
    await openLibraryTab();
    await userEvent.click(await installBtn("code-review"));
    // The row checked it (clean), but then opened the sheet and said why instead of installing.
    const sheet = await screen.findByRole("dialog");
    await within(sheet).findByText(/follows a branch, not one exact version/);
    expect(lib().installed).toHaveLength(0);
    expect(lib().calls.some((c) => c.startsWith("install:"))).toBe(false);
    // Focus is on what must be read, not on Install: Enter does not install it.
    const install = within(sheet).getByRole("button", { name: "Install" });
    expect(install).not.toHaveFocus();
    expect(within(sheet).getByLabelText("What Atlas found")).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(lib().installed).toHaveLength(0);
    // The second click is the sheet's own Install.
    await userEvent.click(install);
    await waitFor(() => expect(lib().installed.map((r) => r.id)).toEqual(["code-review@anthropic-plugin-directory"]));
  });

  it("a flagged plugin always takes the second, deliberate click in the sheet, after its flags", async () => {
    mount((b) => {
      b.library.flagged = true;
    });
    await openLibraryTab();
    await userEvent.click(await installBtn("pdf-tools"));
    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("Runs commands on your computer when it is used.")).toBeInTheDocument();
    expect(within(sheet).getByText("Can reach the internet.")).toBeInTheDocument();
    // Focus starts on the findings, so the deliberate second click is not one Enter away.
    expect(within(sheet).getByLabelText("What Atlas found")).toHaveFocus();
    expect(within(sheet).getByRole("button", { name: "Install" })).not.toHaveFocus();
    // Back on the list, the row's Install still does not install by itself.
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await userEvent.click(await installBtn("pdf-tools"));
    await screen.findByRole("dialog");
    expect(lib().calls.some((c) => c.startsWith("install:"))).toBe(false);
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(lib().installed).toHaveLength(1));
  });

  it("a plugin that installs by running a command has Install disabled, with the reason", async () => {
    mount();
    await openLibraryTab();
    const button = await installBtn("ralph-loop");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", COMMAND_SOURCE);
    expect(screen.getByText(COMMAND_SOURCE)).toBeInTheDocument();
  });

  it("without Claude Code's command, the list says so once and rows keep their descriptions; a GitHub link still installs loose items", async () => {
    mount((b) => {
      b.library.cli = false;
    });
    await openLibraryTab();
    const install = await installBtn("pdf-tools");
    expect(install).toBeDisabled();
    expect(install).toHaveAttribute("title", NO_CLI); // the greyed button says why on hover
    expect(screen.getAllByText(NO_CLI)).toHaveLength(1); // once, in the notice above the list
    expect(screen.getByText("Read, merge, split and fill PDF files.")).toBeInTheDocument(); // the row still says what it is

    await userEvent.click(screen.getByRole("button", { name: "Add from GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Add from GitHub" });
    const check = within(dialog).getByRole("button", { name: "Check" });
    expect(check).toBeDisabled();
    await userEvent.type(within(dialog).getByPlaceholderText("github.com/owner/repo"), "github.com/owner/tools");
    await userEvent.click(check);
    expect(await within(dialog).findByText("You already have one called ship.")).toBeInTheDocument();
    // What Atlas does not install is named, and one safety line is shown.
    expect(within(dialog).getByText("Not installed")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Install 2 items" }));
    await waitFor(() => expect(lib().installed.map((r) => r.name).sort()).toEqual(["reviewer", "tidy-notes"]));
    expect(lib().calls).toContain("items:tidy-notes,reviewer");
  });

  it("a marketplace link lists its plugins and adds only the marketplace", async () => {
    mount();
    await openLibraryTab();
    await userEvent.click(screen.getByRole("button", { name: "Add from GitHub" }));
    const dialog = await screen.findByRole("dialog", { name: "Add from GitHub" });
    await userEvent.type(within(dialog).getByPlaceholderText("github.com/owner/repo"), "github.com/owner/my-marketplace");
    await userEvent.click(within(dialog).getByRole("button", { name: "Check" }));
    expect(await within(dialog).findByText("alpha")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add this marketplace" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(lib().calls).toContain("add-marketplace");
    expect(lib().installed).toHaveLength(0);
    expect(await row("alpha")).toBeInTheDocument();
  });
});

describe("Library tab: installed plugins", () => {
  it("shows an installed plugin with its switch and an Uninstall that asks first", async () => {
    mount();
    await openLibraryTab();
    await userEvent.click(await installBtn("pdf-tools")); // checks it, clean, installs at once
    await waitFor(() => expect(lib().installed).toHaveLength(1));
    // What you have moves to the top under its own heading; the rest sit under where they come from.
    await waitFor(() => expect(document.querySelector('[data-head="Installed"]')).toBeInTheDocument());
    expect(document.querySelector('[data-head="Claude plugin directory"]')).toBeInTheDocument();
    expect(document.querySelector("[data-row]")?.getAttribute("data-row")).toBe("pdf-tools@anthropic-plugin-directory");
    expect((await row("pdf-tools")).getAttribute("aria-label")).toMatch(/\. Installed$/);

    // The picture: what it is about (its glyph) and, on its corner, that it is installed and on.
    const tile = (await row("pdf-tools")).querySelector("[data-tile-topic]")!;
    expect(tile).toHaveAttribute("data-tile-topic", "documents");
    expect(tile).toHaveAttribute("data-tile-state", "on");
    expect(tile).toHaveAttribute("title", "Documents");
    // A plugin still on the shelf has the glyph, a quiet Install and no mark.
    const shelf = (await row("code-review")).querySelector("[data-tile-topic]")!;
    expect(shelf).toHaveAttribute("data-tile-topic", "review");
    expect(shelf).toHaveAttribute("data-tile-state", "none");
    expect(shelf.querySelector(".lib-mark")).toBeNull();
    expect(await installBtn("code-review")).toHaveClass("lib-install");

    await userEvent.click(await screen.findByRole("button", { name: "Uninstall pdf-tools" }));
    // The question is the row's own first line, so it is there at every width; Keep has the keyboard.
    const asked = (await row("pdf-tools")).querySelector("[data-row-title]")!;
    expect(asked).toHaveTextContent("Uninstall pdf-tools?");
    expect(asked.className).not.toMatch(/hidden/);
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Uninstall" })).toHaveClass("confirm-go");
    await userEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(await row("pdf-tools")).toHaveFocus();
    expect(screen.queryByText("Uninstall pdf-tools?")).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Uninstall pdf-tools" }));
    expect(screen.getByText("Uninstall pdf-tools?")).toBeInTheDocument();
    expect(lib().calls.some((c) => c.startsWith("uninstall:"))).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(lib().installed).toHaveLength(0));
    // Found in the real app: the row kept its "Uninstall?" question when the plugin came back.
    await userEvent.click(await installBtn("pdf-tools"));
    await waitFor(() => expect(lib().installed).toHaveLength(1));
    expect(await screen.findByRole("button", { name: "Uninstall pdf-tools" })).toBeInTheDocument();
    expect(screen.queryByText("Uninstall pdf-tools?")).not.toBeInTheDocument();
  });

  it("offers Undo after a removal and an install, and Undo brings the plugin back or takes it out", async () => {
    mount();
    await openLibraryTab();
    await userEvent.click(await installBtn("pdf-tools"));
    await waitFor(() => expect(lib().installed).toHaveLength(1));
    await userEvent.click(await screen.findByRole("button", { name: "Uninstall pdf-tools" }));
    await userEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    await waitFor(() => expect(lib().installed).toHaveLength(0));
    // The toast no longer sends people to History: it carries the Undo itself.
    expect(screen.queryByText(/Undo it in History/)).not.toBeInTheDocument();
    const toast = await screen.findByText("Removed pdf-tools.");
    expect(toast).toBeInTheDocument();
    const undos = await screen.findAllByRole("button", { name: "Undo" });
    await userEvent.click(undos[undos.length - 1]);
    await waitFor(() => expect(lib().installed).toHaveLength(1));
    expect(lib().calls.some((c) => c.startsWith("undo:"))).toBe(true);
  });
});

describe("Quick jump: Library", () => {
  it("Ctrl+K, 'library', Enter opens the Toolkit on the Library tab", async () => {
    mount(undefined, "dashboard");
    await screen.findByRole("button", { name: "Toolkit" });
    await userEvent.keyboard("{Control>}k{/Control}");
    await screen.findByRole("dialog", { name: "Quick jump" });
    await userEvent.keyboard("library");
    const option = await screen.findByRole("option", { name: /Library/ });
    expect(option).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{Enter}");
    expect(await screen.findByRole("searchbox", { name: "Search plugins and skills" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Library" })).toHaveAttribute("aria-checked", "true");
  });
});
