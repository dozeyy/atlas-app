import { useEffect, useSyncExternalStore } from "react";
import { getBackend } from "./ipc";
import type { Backend } from "./ipc";
import type { FilterOptions, SessionRow } from "./types";

/** How many of the newest chats the quick jump keeps ready. Older ones are found by typing. */
export const RECENT_CHATS = 200;
/** A copy this young is shown as it is, without asking again. */
const FRESH_MS = 20_000;
/** An open quick jump waits this long after the last "usage changed" before it asks again. */
const REFRESH_DEBOUNCE_MS = 800;

export interface PaletteData {
  sessions: SessionRow[];
  projects: FilterOptions["projects"];
}

const EMPTY: PaletteData = { sessions: [], projects: [] };

let data: PaletteData = EMPTY;
let owner: Backend | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
/** Bumped by every "usage changed"; a load that started under an older value is already out of date. */
let generation = 0;
/** The backend whose change events are listened to, and the way to stop listening. */
let watching: Backend | null = null;
let watchToken: object | null = null;
let unlisten: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const subs = new Set<() => void>();

const emit = () => {
  for (const s of subs) s();
};

function stopWatching() {
  const off = unlisten;
  watching = null;
  watchToken = null;
  unlisten = null;
  off?.();
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = undefined;
}

/** After the last change settles, an open quick jump asks again; a closed one just notes it is old. */
function scheduleRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    if (subs.size > 0) void refreshPaletteData(true);
  }, REFRESH_DEBOUNCE_MS);
}

function watch(backend: Backend) {
  if (watching === backend) return;
  stopWatching();
  watching = backend;
  const token = {};
  watchToken = token;
  // New chats arrive while the app is open: the copy is old from then on.
  backend
    .onUsageChanged(() => {
      generation++;
      loadedAt = 0;
      if (subs.size > 0) scheduleRefresh();
    })
    .then((off) => {
      if (watchToken === token) unlisten = off;
      else off();
    })
    .catch(() => {
      // Not listening after all: the next refresh tries again.
      if (watchToken === token) {
        watching = null;
        watchToken = null;
      }
    });
}

/** Ask for fresh lists unless the copy in hand is young. Never throws; a failure keeps the old copy. */
export function refreshPaletteData(force = false): Promise<void> {
  const backend = getBackend();
  if (owner !== backend) {
    owner = backend;
    data = EMPTY;
    loadedAt = 0;
    inflight = null;
    stopWatching();
  }
  watch(backend);
  if (inflight) return inflight;
  if (!force && Date.now() - loadedAt < FRESH_MS && data !== EMPTY) return Promise.resolve();
  const started = generation;
  const run = Promise.all([
    backend.sessionsList({ includeMissing: true, sort: "started", dir: "desc", limit: RECENT_CHATS }),
    backend.usageFilterOptions(),
  ])
    .then(([page, options]) => {
      if (owner !== backend) return;
      data = { sessions: page.rows, projects: options.projects };
      // A change that landed while this was loading leaves the copy old, so it is asked for again.
      loadedAt = started === generation ? Date.now() : 0;
      emit();
    })
    .catch(() => {})
    .finally(() => {
      if (inflight === run) inflight = null;
      if (owner === backend && started !== generation && subs.size > 0) scheduleRefresh();
    });
  inflight = run;
  return run;
}

/** Also what the hook listens through; exported so tests can stand in for an open quick jump. */
export function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

const snapshot = () => (owner === getBackend() ? data : EMPTY);

/** The chats and projects the quick jump lists. What is in hand comes back at once; a fresh copy replaces it. */
export function usePaletteData(): PaletteData {
  const d = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    void refreshPaletteData();
  }, []);
  return d;
}

/** Tests: forget everything, including the listener. */
export function resetPaletteData(): void {
  stopWatching();
  data = EMPTY;
  owner = null;
  loadedAt = 0;
  inflight = null;
  generation = 0;
}

