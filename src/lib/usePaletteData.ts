import { useEffect, useSyncExternalStore } from "react";
import { getBackend } from "./ipc";
import type { FilterOptions, SessionRow } from "./types";

/** How many of the newest chats the quick jump keeps ready. Older ones are found by typing. */
export const RECENT_CHATS = 200;
/** A copy this young is shown as it is, without asking again. */
const FRESH_MS = 20_000;

export interface PaletteData {
  sessions: SessionRow[];
  projects: FilterOptions["projects"];
}

const EMPTY: PaletteData = { sessions: [], projects: [] };

let data: PaletteData = EMPTY;
let owner: object | null = null;
let loadedAt = 0;
let inflight: Promise<void> | null = null;
let watching = false;
const subs = new Set<() => void>();

const emit = () => {
  for (const s of subs) s();
};

/** Ask for fresh lists unless the copy in hand is young. Never throws; a failure keeps the old copy. */
export function refreshPaletteData(force = false): Promise<void> {
  const backend = getBackend();
  if (owner !== backend) {
    owner = backend;
    data = EMPTY;
    loadedAt = 0;
    inflight = null;
    watching = false;
  }
  if (inflight) return inflight;
  if (!force && Date.now() - loadedAt < FRESH_MS && data !== EMPTY) return Promise.resolve();
  if (!watching) {
    watching = true;
    // New chats arrive while the app is open: the copy is old from then on.
    backend
      .onUsageChanged(() => {
        loadedAt = 0;
      })
      .catch(() => {});
  }
  inflight = Promise.all([
    backend.sessionsList({ includeMissing: true, sort: "started", dir: "desc", limit: RECENT_CHATS }),
    backend.usageFilterOptions(),
  ])
    .then(([page, options]) => {
      if (owner !== backend) return;
      data = { sessions: page.rows, projects: options.projects };
      loadedAt = Date.now();
      emit();
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function subscribe(cb: () => void): () => void {
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
