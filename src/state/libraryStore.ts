// The Library's data (Toolkit > Library). A tiny external store like setupStore: it survives
// switching between the two Toolkit tabs, and nothing here runs until the tab is opened the first
// time, so a Toolkit that never opens the Library makes no network request.
//
// The catalog comes from the saved copy first (no network); a copy older than six hours, or none,
// is refreshed in the background while the list is already on screen.

import { useSyncExternalStore } from "react";
import { getBackend } from "../lib/ipc";
import { errorText } from "../lib/setup-actions";
import { ALL, hasInstalls, indexEntries, isClean, orderIndexed, type Indexed, type LibraryOrder } from "../lib/library";
import type { CatalogEntry, CatalogView, InstalledRow, LibraryDetail, PluginOutcome } from "../lib/libraryTypes";
import { pushToast } from "./toastStore";

export interface LibraryState {
  status: "idle" | "loading" | "ready";
  view: CatalogView | null;
  idx: Indexed[];
  installed: InstalledRow[];
  refreshing: boolean;
  /** One sentence when there is no catalog to show (offline, first run). */
  error: string | null;
  source: string;
  query: string;
  /** The order the user picked (popular unless they chose otherwise this session). */
  order: LibraryOrder;
  /** Some plugin has an install count, so "popular" means something and the Sort control is offered. */
  counted: boolean;
  /** Plugin ids (or installed ids) being installed or removed right now. */
  busy: Record<string, "checking" | "installing" | "removing">;
  /** Bumps when a check is stored, so a row re-reads whether it can install at once. */
  checks: number;
}

const INITIAL: LibraryState = {
  status: "idle",
  view: null,
  idx: [],
  installed: [],
  refreshing: false,
  error: null,
  source: ALL,
  query: "",
  order: "popular",
  counted: false,
  busy: {},
  checks: 0,
};

let state: LibraryState = INITIAL;
let openedAt: number | null = null;
let reported = false;
let wired = false;
const cache = new Map<string, LibraryDetail>();
const subs = new Set<() => void>();
const offs: Array<() => void> = [];

function set(next: Partial<LibraryState>) {
  state = { ...state, ...next };
  for (const s of subs) s();
}

/**
 * Index the entries and put them in the chosen order, once per load (and once per choice, in
 * `setOrder`): the rows are drawn from this array as it is. With no install counts anywhere the
 * order is the catalog's own whatever was chosen.
 */
function arrange(entries: CatalogEntry[], order: LibraryOrder, partial = false): { idx: Indexed[]; counted: boolean } {
  const counted = hasInstalls(entries);
  // The first rows are only the head of the popular list: a catalog-order sort of them would be
  // re-sorted against the whole list a moment later. A chosen order waits for the whole list.
  return { idx: orderIndexed(indexEntries(entries), counted && !partial ? order : counted ? "popular" : "catalog"), counted };
}

function setView(view: CatalogView) {
  set({ view, ...arrange(view.entries, state.order, view.partial), error: null });
  if (view.partial) void loadRest(view);
}

/**
 * The first answer carries only the first rows. Once they are painted, fetch every entry and
 * index it, so the filter covers the whole catalog (a typed word waits on this, a few ms).
 * Ignored when a fresh full view replaced the page in the meantime.
 */
function loadRest(first: CatalogView): void {
  const go = () =>
    void getBackend()
      .libraryCatalogAll()
      .then((all) => {
        if (state.view !== first) return;
        const view = { ...first, entries: all.entries, partial: false };
        set({ view, ...arrange(all.entries, state.order) });
      })
      .catch(() => {
        // Keep the first rows; a refresh will bring the full list.
        if (state.view === first) void refreshLibrary();
      });
  // After the first frame with rows, not before: the first paint is the number that matters.
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(go, 0));
  else setTimeout(go, 0);
}

// ---- opening -----------------------------------------------------------------------------------

/** The tab was opened. Idempotent: the first call loads, later ones do nothing. */
export function openLibrary(): void {
  if (state.status !== "idle") return;
  openedAt = performance.now();
  set({ status: "loading" });
  const backend = getBackend();
  void Promise.all([backend.libraryCatalog(), backend.libraryInstalled()])
    .then(([view, installed]) => {
      setView(view);
      set({ status: "ready", installed });
      // A missing or old copy is refreshed in the background; the list is already on screen.
      if (view.stale || view.total === 0) void refreshLibrary();
    })
    .catch((e) => {
      // No words from the engine is not "offline": the page then says only that it could not load.
      set({ status: "ready", error: errorText(e, "") || null });
      void refreshLibrary();
    });
  if (!wired) {
    wired = true;
    // Plugins and settings change on disk (a command in a terminal): re-read what is installed.
    backend
      .onSetupChanged(() => void reloadInstalled())
      .then((off) => offs.push(off))
      .catch(() => {});
  }
}

/** Once, when the first rows are on screen: tell Rust how long the tab took (the log line). */
export function reportFirstRows(): void {
  if (reported || openedAt === null) return;
  reported = true;
  getBackend().libraryPerf(Math.round(performance.now() - openedAt));
}

export async function refreshLibrary(marketplace?: string): Promise<void> {
  if (state.refreshing) return;
  set({ refreshing: true });
  try {
    const view = await getBackend().libraryRefresh(marketplace);
    cache.clear();
    setView(view);
    await reloadInstalled();
  } catch (e) {
    const words = errorText(e, "");
    // With a list on screen the old copy stays and one toast says why; with none the page says it.
    if (state.view && state.view.total) pushToast({ message: words || "Atlas could not update the plugin list. The one on screen is the last copy.", tone: "error" });
    else set({ error: words || null });
  } finally {
    set({ refreshing: false });
  }
}

export async function reloadInstalled(): Promise<void> {
  try {
    set({ installed: await getBackend().libraryInstalled() });
  } catch {
    // the list stays as it was
  }
}

// ---- filters -----------------------------------------------------------------------------------

export function setQuery(query: string): void {
  if (state.query !== query) set({ query });
}

/** Sort the list again, from what is already loaded: no request, and nothing is read twice. */
export function setOrder(order: LibraryOrder): void {
  if (state.order === order) return;
  // Only the first rows are here: keep the choice, and `loadRest` applies it when the whole list lands.
  if (state.view?.partial) return void set({ order });
  set({ order, idx: orderIndexed(state.idx, state.counted ? order : "catalog") });
}

export function setSource(source: string): void {
  if (state.source !== source) set({ source });
}

// ---- checks ------------------------------------------------------------------------------------

export const storedCheck = (pluginId: string): LibraryDetail | undefined => cache.get(pluginId);

export function storeCheck(pluginId: string, d: LibraryDetail): void {
  cache.set(pluginId, d);
  set({ checks: state.checks + 1 });
}

export function dropCheck(pluginId: string): void {
  if (cache.delete(pluginId)) set({ checks: state.checks + 1 });
}

/** D20: this plugin has a finished check with nothing flagged (and one exact version), so its row can install at once. */
const oneClickOk = (d: LibraryDetail | undefined): d is LibraryDetail => !!d && isClean(d.inspected) && !d.confirmNote;
export const canInstallAtOnce = (pluginId: string): boolean => oneClickOk(cache.get(pluginId));

// ---- doing -------------------------------------------------------------------------------------

function mark(id: string, what: "checking" | "installing" | "removing" | null) {
  const busy = { ...state.busy };
  if (what) busy[id] = what;
  else delete busy[id];
  set({ busy });
}

/** Install a plugin whose check (token) is stored. Returns null after saying why it did not. */
export async function installPlugin(pluginId: string, name: string, token: string): Promise<PluginOutcome | null> {
  if (state.busy[pluginId]) return null;
  mark(pluginId, "installing");
  try {
    const out = await getBackend().libraryInstallPlugin(pluginId, token);
    await reloadInstalled();
    pushToast({
      message: out.changed ? `Installed ${name}. Its files differ from the ones Atlas checked.` : `Installed ${name}.`,
      tone: out.changed ? "info" : "success",
      action: { label: "Undo", onClick: async () => void (await undoPlugin(out.backupId, name)) },
      // Uninstall in the Library does the same, so a clean install need not follow onto other
      // pages. "Its files differ" is a safety notice: it stays until it is read or times out.
      leavesWithPage: !out.changed,
    });
    return out;
  } catch (e) {
    dropCheck(pluginId);
    // "...so Atlas took it out again" must be read: it stays long enough.
    pushToast({ message: errorText(e, "Atlas could not install that. Nothing changed."), tone: "error", ms: 15_000 });
    return null;
  } finally {
    mark(pluginId, null);
  }
}

/**
 * A row's Install (spec: 1 click when the check is clean). Runs the check if there is none yet; a
 * clean one installs right away (a toast with Undo), anything flagged, unreadable or not pinned to
 * one exact version comes back as "open" so the sheet shows the reasons and its Install is the second click.
 */
export async function checkThenInstall(pluginId: string, name: string): Promise<"done" | "open"> {
  if (state.busy[pluginId]) return "done";
  let d = cache.get(pluginId);
  if (!d) {
    mark(pluginId, "checking");
    try {
      d = await getBackend().libraryInspectPlugin(pluginId);
      storeCheck(pluginId, d);
    } catch {
      return "open"; // the sheet runs it again and says what went wrong
    } finally {
      mark(pluginId, null);
    }
  }
  if (!oneClickOk(d)) return "open";
  return (await installPlugin(pluginId, name, d.token)) ? "done" : "open";
}

export async function uninstallPlugin(id: string, name: string): Promise<boolean> {
  if (state.busy[id]) return false;
  mark(id, "removing");
  try {
    const backupId = await getBackend().libraryUninstallPlugin(id);
    await reloadInstalled();
    pushToast({ message: `Removed ${name}.`, tone: "success", action: { label: "Undo", onClick: async () => void (await undoPlugin(backupId, name)) } });
    return true;
  } catch (e) {
    pushToast({ message: errorText(e, "Atlas could not remove that. Nothing changed."), tone: "error" });
    return false;
  } finally {
    mark(id, null);
  }
}

/** Undo a plugin install or removal: an install is taken out, a removal comes back at the same version. */
export async function undoPlugin(backupId: string, name: string): Promise<boolean> {
  try {
    const done = await getBackend().libraryUndo(backupId);
    await reloadInstalled();
    pushToast({ message: done.did === "uninstall" ? `Took ${name} out again.` : `Put ${name} back.`, tone: "success" });
    return true;
  } catch (e) {
    pushToast({ message: errorText(e, "Atlas could not undo that. Nothing changed."), tone: "error", ms: 15_000 });
    return false;
  }
}

export async function setPluginEnabled(id: string, on: boolean): Promise<void> {
  const before = state.installed;
  set({ installed: before.map((r) => (r.id === id && r.kind === "plugin" ? { ...r, enabled: on } : r)) });
  try {
    await getBackend().librarySetEnabled(id, on);
  } catch (e) {
    set({ installed: before });
    pushToast({ message: errorText(e, "Atlas could not change that. Nothing changed."), tone: "error" });
  }
}

export async function removeItem(row: InstalledRow): Promise<boolean> {
  const key = `item:${row.backupId}`;
  if (state.busy[key]) return false;
  mark(key, "removing");
  try {
    await getBackend().libraryRemoveItem(row.backupId);
    await reloadInstalled();
    // True to what happened: the engine backs the files up and moves them to the trash. History
    // shows the last copy and can save it, but has no Undo button, so none is promised.
    pushToast({ message: `Removed ${row.name}. Its files are in the trash, and History keeps the last copy.`, tone: "success" });
    return true;
  } catch (e) {
    pushToast({ message: errorText(e, "Atlas could not remove that. Nothing changed."), tone: "error" });
    return false;
  } finally {
    mark(key, null);
  }
}

/** The empty Library's action: add the official catalog. True when it was added (the list is then on screen). */
export async function addOfficialCatalog(): Promise<boolean> {
  if (state.refreshing) return false;
  set({ refreshing: true });
  try {
    const done = await getBackend().libraryAddOfficialCatalog();
    adoptCatalog(done.catalog);
    pushToast({ message: "The official plugin catalog is ready.", tone: "success" });
    return true;
  } catch (e) {
    // The empty page stays; one toast says what went wrong.
    pushToast({ message: errorText(e, "Atlas could not add the catalog. Nothing changed."), tone: "error", ms: 15_000 });
    return false;
  } finally {
    set({ refreshing: false });
  }
}

/** A marketplace was added from a link: show its plugins now. */
export function adoptCatalog(view: CatalogView): void {
  cache.clear();
  setView(view);
  void reloadInstalled();
}

// ---- react -------------------------------------------------------------------------------------

/** Tests: forget everything and detach listeners. */
export function resetLibraryStore(): void {
  for (const off of offs.splice(0)) off();
  cache.clear();
  openedAt = null;
  reported = false;
  wired = false;
  state = INITIAL;
  for (const s of subs) s();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => state;

export function useLibrary(): LibraryState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
