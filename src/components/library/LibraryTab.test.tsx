import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../App";
import { AtlasProvider } from "../../state/AtlasProvider";
import { resetSetupStore } from "../../state/setupStore";
import { installPlugin, removeItem, resetLibraryStore } from "../../state/libraryStore";
import { dismissPageToasts, resetToasts } from "../../state/toastStore";
import { closePalette } from "../../state/paletteStore";
import { setBackend } from "../../lib/ipc";
import { MockBackend } from "../../lib/mock";
import { SEED_INSTALLS } from "../../lib/mockLibrary";
import { clearPendingToolkitItem, clearPendingToolkitTab } from "../../lib/nav";
import { COMMAND_SOURCE, NO_CLI, OFFLINE } from "../../lib/library";
import { looksOffline } from "./LibraryTab";

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
      b.library.firstPage = 2;
    });
    await openLibraryTab();
    // A name that is not among the first two rows: it arrives with the rest.
    await userEvent.type(screen.getByRole("searchbox", { name: "Search plugins and skills" }), "pdf");
    expect(await row("pdf-tools")).toBeInTheDocument();
    expect(lib().calls.filter((c) => c === "catalog")).toHaveLength(1);
    expect(lib().calls.filter((c) => c === "catalog-all")).toHaveLength(1);
    // The first answer carries three rows but the whole catalog's size and per-source counts.
    const first = await lib().libraryCatalog();
    expect(first.entries).toHaveLength(2);
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
    expect(await screen.findByText('"pdfzzz"')).toBeInTheDocument();
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
    expect(await screen.findByText("Atlas could not reach the plugin catalog")).toBeInTheDocument();
    expect(screen.getByText("Check your connection and press Refresh.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("a failure that is not the network never tells anyone to check their connection (K3)", async () => {
    const why = "Claude Code's command took too long. Nothing was changed by Atlas; check the plugin list before trying again.";
    mount((b) => {
      b.library.offline = true; // nothing saved yet, so the page (not a toast) has to say it
      b.library.libraryRefresh = async () => {
        throw new Error(why);
      };
    });
    await openLibraryTab();
    expect(await screen.findByText("The Library could not load")).toBeInTheDocument();
    expect(screen.queryByText(/connection/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Atlas could not reach the plugin catalog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    // The engine's own words are one click away, never on the surface.
    expect(screen.queryByText(why)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText(why)).toBeInTheDocument();
  });

  it("a fresh Claude Code with no plugin catalogs gets a calm empty state, not an error", async () => {
    mount((b) => {
      b.library.empty = true;
      b.library.entries = [];
    });
    await openLibraryTab();
    expect(await screen.findByText("No plugin catalogs yet")).toBeInTheDocument();
    expect(screen.getByText("Claude Code has no plugin catalogs added. Add the official one to browse plugins and skills.")).toBeInTheDocument();
    expect(screen.queryByText("The Library could not load")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add the official catalog" })).toBeInTheDocument();
    // Adding from a GitHub link stays available beside it.
    expect(screen.getByRole("button", { name: "Add from GitHub" })).toBeInTheDocument();
  });

  it("Add the official catalog adds it, refreshes the list and shows the plugins", async () => {
    mount((b) => {
      b.library.empty = true;
      b.library.entries = [];
    });
    await openLibraryTab();
    await userEvent.click(await screen.findByRole("button", { name: "Add the official catalog" }));
    expect(await row("pdf-tools")).toBeInTheDocument();
    expect(lib().calls.filter((c) => c === "add-official-catalog")).toHaveLength(1);
    expect(screen.queryByText("No plugin catalogs yet")).not.toBeInTheDocument();
    expect((await lib().libraryCatalog()).marketplaces.map((m) => m.name)).toEqual(["claude-plugins-official"]);
  });

  it("with the official catalog already added and nothing listed, the empty state offers Refresh, not Add", async () => {
    mount((b) => {
      b.library.empty = true;
      b.library.entries = [];
      b.library.marketplaces = [{ name: "claude-plugins-official", source: "anthropics/claude-plugins-official", installLocation: null }];
    });
    await openLibraryTab();
    expect(await screen.findByText("No plugins listed yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Add the official catalog" })).not.toBeInTheDocument();
    const before = lib().calls.filter((c) => c === "refresh").length;
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(lib().calls.filter((c) => c === "refresh").length).toBe(before + 1));
    expect(lib().calls).not.toContain("add-official-catalog");
  });

  it("when adding the official catalog fails, the empty state stays and one toast says why", async () => {
    mount((b) => {
      b.library.empty = true;
      b.library.entries = [];
      b.library.libraryAddOfficialCatalog = async () => {
        throw new Error("Claude Code could not add that catalog.");
      };
    });
    await openLibraryTab();
    await userEvent.click(await screen.findByRole("button", { name: "Add the official catalog" }));
    expect(await screen.findByText("Claude Code could not add that catalog.")).toBeInTheDocument();
    expect(screen.getByText("No plugin catalogs yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add the official catalog" })).toBeEnabled();
  });

  it("knows the network from the rest by the reason's own words", () => {
    expect(looksOffline(OFFLINE)).toBe(true);
    expect(looksOffline("getaddrinfo ENOTFOUND api.github.com")).toBe(true);
    expect(looksOffline("Atlas could not reach GitHub. Check your connection.")).toBe(true);
    expect(looksOffline(null)).toBe(false);
    expect(looksOffline(NO_CLI)).toBe(false);
    expect(looksOffline("Claude Code's command took too long. Nothing was changed by Atlas; check the plugin list before trying again.")).toBe(false);
    expect(looksOffline("Another Atlas change is in progress. Please try again in a moment.")).toBe(false);
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
    // What Atlas leaves out is named as the reason the verdict holds (G11: "Left out", not a
    // second "Not installed" line under "nothing here runs"), and one safety line is shown.
    expect(within(dialog).getByText("Left out")).toBeInTheDocument();
    expect(within(dialog).getByText(/Atlas does not copy it, so it never runs\./)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Install 2 items" }));
    await waitFor(() => expect(lib().installed.map((r) => r.name).sort()).toEqual(["reviewer", "tidy-notes"]));
    expect(lib().calls).toContain("items:tidy-notes,reviewer");
  });

  it("removing a copied item promises only what is true: no Undo in History (K5)", async () => {
    mount();
    await openLibraryTab();
    await screen.findByRole("searchbox", { name: "Search plugins and skills" });
    const row = { kind: "item", id: "skill:tidy-notes", name: "tidy-notes", itemKind: "skill", enabled: null, version: null, path: null, repo: "owner/tools", backupId: "b-9", changed: false } as const;
    lib().installed.push({ ...row });
    await act(async () => void (await removeItem({ ...row })));
    expect(lib().calls).toContain("remove:b-9");
    expect(await screen.findByText("Removed tidy-notes. Its files are in the trash, and History keeps the last copy.")).toBeInTheDocument();
    expect(screen.queryByText(/Undo it in History/)).not.toBeInTheDocument();
  });

  it("the notice that the installed files differ from the checked ones stays when the page changes (K2)", async () => {
    mount();
    await openLibraryTab();
    await userEvent.click(await installBtn("pdf-tools"));
    await waitFor(() => expect(lib().installed).toHaveLength(1));
    expect(await screen.findByText("Installed pdf-tools.")).toBeInTheDocument();
    // A clean install's toast belongs to the Library and leaves with it.
    act(() => dismissPageToasts());
    expect(screen.queryByText("Installed pdf-tools.")).not.toBeInTheDocument();

    const keep = lib().libraryInstallPlugin.bind(lib());
    lib().libraryInstallPlugin = async (id, token) => ({ ...(await keep(id, token)), changed: true });
    const d = await lib().libraryInspectPlugin("frontend-design@anthropic-plugin-directory");
    await act(async () => void (await installPlugin("frontend-design@anthropic-plugin-directory", "frontend-design", d.token)));
    const notice = "Installed frontend-design. Its files differ from the ones Atlas checked.";
    expect(await screen.findByText(notice)).toBeInTheDocument();
    act(() => dismissPageToasts());
    expect(screen.getByText(notice)).toBeInTheDocument();
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
    // Its glyph wears the topic's family colour (review checks: sand), the same four the helper
    // avatars use; the installed one keeps the clay tile.
    expect((shelf as HTMLElement).style.getPropertyValue("--tile")).toBe("var(--chart-3)");
    expect((tile as HTMLElement).style.getPropertyValue("--tile")).toBe("var(--chart-2)");
    expect(tile).toHaveClass("lib-tile-own");
    expect(await installBtn("code-review")).toHaveClass("lib-install");

    await userEvent.click(await screen.findByRole("button", { name: "Uninstall pdf-tools" }));
    // The question is the row's own first line, so it is there at every width; Keep has the keyboard.
    const asked = (await row("pdf-tools")).querySelector("[data-row-title]")!;
    expect(asked).toHaveTextContent("Uninstall pdf-tools?");
    expect(asked.className).not.toMatch(/hidden/);
    expect(screen.getByRole("button", { name: "Keep" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Uninstall" })).toHaveClass("btn-danger-solid");
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

describe("Library tab: most installed first", () => {
  const DIR = "anthropic-plugin-directory";
  const shown = () => Array.from(document.querySelectorAll("[data-row]")).map((el) => (el.getAttribute("data-row") ?? "").replace(`@${DIR}`, ""));
  const counted = (b: MockBackend) => {
    b.library.installs = { ...SEED_INSTALLS };
  };

  it("opens most installed first, each row says how many, and plugins with no count follow in catalog order", async () => {
    mount(counted);
    await openLibraryTab();
    expect(await row("frontend-design")).toBeInTheDocument();
    const ids = shown();
    expect(ids.slice(0, 8)).toEqual(["frontend-design", "code-review", "github", "playwright", "commit-commands", "typescript-lsp", "hookify", "plugin-dev"]);
    // Then what has no count, as the catalog lists it (pdf-tools came before security-guidance there).
    expect(ids.slice(8, 11)).toEqual(["pdf-tools", "security-guidance", "feature-dev"]);
    expect(screen.getByText("429k installs")).toBeInTheDocument();
    expect(screen.getByText("12 installs")).toBeInTheDocument();
    expect(screen.getByText("429k installs")).toHaveAttribute("title", "428,976 people installed this");
  });

  it("the Sort control (the one Sessions uses) puts the catalog's own order back, and back again", async () => {
    mount(counted);
    await openLibraryTab();
    await row("frontend-design");
    await userEvent.click(screen.getByRole("button", { name: "Sort, Most installed" }));
    await userEvent.click(screen.getByRole("radio", { name: "Catalog order" }));
    // The seed's own order: frontend-design, code-review, pdf-tools, commit-commands...
    await waitFor(() => expect(shown().slice(0, 4)).toEqual(["frontend-design", "code-review", "pdf-tools", "commit-commands"]));
    // The count stays on the row whatever the order.
    expect(screen.getByText("429k installs")).toBeInTheDocument();
    expect(lib().calls.filter((c) => c === "catalog")).toHaveLength(1); // sorting asks for nothing
    await userEvent.click(screen.getByRole("button", { name: "Sort, Catalog order" }));
    await userEvent.click(screen.getByRole("radio", { name: "Most installed" }));
    await waitFor(() => expect(shown().slice(0, 3)).toEqual(["frontend-design", "code-review", "github"]));
  });

  it("offers no Sort and no counts when Claude Code's cache has none, and the order is the catalog's", async () => {
    mount();
    await openLibraryTab();
    await row("frontend-design");
    expect(screen.queryByRole("button", { name: /^Sort/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/ installs?$/)).not.toBeInTheDocument();
    expect(shown().slice(0, 3)).toEqual(["frontend-design", "code-review", "pdf-tools"]);
  });

  it("the first rows do not move when the rest of the catalog lands or the list is refreshed", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mount((b) => {
      counted(b);
      b.library.firstPage = 4;
      const all = b.library.libraryCatalogAll.bind(b.library);
      b.library.libraryCatalogAll = async () => {
        await gate;
        return all();
      };
    });
    await openLibraryTab();
    await row("frontend-design");
    const first = shown();
    expect(first).toEqual(["frontend-design", "code-review", "github", "playwright"]);
    release();
    await waitFor(() => expect(shown().length).toBeGreaterThan(4));
    expect(shown().slice(0, 4)).toEqual(first);
    await userEvent.click(screen.getByRole("button", { name: "Refresh the plugin catalog" }));
    await waitFor(() => expect(lib().calls).toContain("refresh"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh the plugin catalog" })).toBeEnabled());
    expect(shown().slice(0, 8)).toEqual(["frontend-design", "code-review", "github", "playwright", "commit-commands", "typescript-lsp", "hookify", "plugin-dev"]);
  });

  it("a choice made while only the first rows are here waits for the whole list, so nothing jumps twice", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    mount((b) => {
      counted(b);
      b.library.firstPage = 4;
      const all = b.library.libraryCatalogAll.bind(b.library);
      b.library.libraryCatalogAll = async () => {
        await gate;
        return all();
      };
    });
    await openLibraryTab();
    await row("frontend-design");
    const first = shown();
    await userEvent.click(screen.getByRole("button", { name: "Sort, Most installed" }));
    await userEvent.click(screen.getByRole("radio", { name: "Catalog order" }));
    expect(shown()).toEqual(first); // the four rows stay as they were
    release();
    await waitFor(() => expect(shown().slice(0, 4)).toEqual(["frontend-design", "code-review", "pdf-tools", "commit-commands"]));
    expect(screen.getByRole("button", { name: "Sort, Catalog order" })).toBeInTheDocument();
  });

  it("under All with something installed: it leads, then one run across marketplaces under 'More plugins'", async () => {
    mount((b) => {
      counted(b);
      b.library.installed = [{ kind: "plugin", id: `playwright@${DIR}`, name: "playwright", itemKind: "", enabled: true, version: "1.0.0", path: null, repo: "", backupId: "b1", changed: false }];
    });
    await openLibraryTab();
    await row("frontend-design");
    expect(shown().slice(0, 3)).toEqual(["playwright", "frontend-design", "code-review"]);
    expect(screen.getByText("Installed", { selector: "span.font-semibold" })).toBeInTheDocument();
    expect(screen.getByText("More plugins")).toBeInTheDocument();
  });
});
