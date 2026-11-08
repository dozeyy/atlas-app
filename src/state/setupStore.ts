// The Setup data, loaded before anyone opens the page.
//
// A tiny external store (no provider needed): main.tsx calls `startSetup()` right
// after the first render, so by the time Will clicks Setup the snapshot is already
// here. A change on disk (event from Rust) or a different Claude folder reloads it.
// The snapshot never contains file bodies or secret values.

import { useSyncExternalStore } from "react";
import { getBackend } from "../lib/ipc";
import type { SetupSnapshot } from "../lib/setup-types";

export type SetupStatus = "idle" | "loading" | "ready" | "error";

export interface SetupState {
  status: SetupStatus;
  snapshot: SetupSnapshot | null;
  error: string | null;
  includeWorktrees: boolean;
  /** Bumps on every successful load; lets open detail views know to re-read. */
  loads: number;
}

const INITIAL: SetupState = { status: "idle", snapshot: null, error: null, includeWorktrees: false, loads: 0 };

let state: SetupState = INITIAL;
let started = false;
let seq = 0;
let inflight = false;
let again = false;
let lastConfigKey = "";
const subs = new Set<() => void>();
const offs: Array<() => void> = [];

function set(next: Partial<SetupState>) {
  state = { ...state, ...next };
  for (const s of subs) s();
}

function message(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return m || "Atlas could not read your Claude folder.";
}

async function load(): Promise<void> {
  // One request at a time; a change that arrives meanwhile triggers one more.
  if (inflight) {
    again = true;
    return;
  }
  inflight = true;
  const mine = ++seq;
  if (!state.snapshot) set({ status: "loading", error: null });
  try {
    const snap = await getBackend().setupSnapshot(state.includeWorktrees);
    if (mine === seq) set({ status: "ready", snapshot: snap, error: null, loads: state.loads + 1 });
  } catch (e) {
    if (mine === seq) set({ status: state.snapshot ? "ready" : "error", error: message(e) });
  } finally {
    inflight = false;
    if (again) {
      again = false;
      void load();
    }
  }
}

/** Begin loading (idempotent). Called once from main.tsx; the page calls it too, harmlessly. */
export function startSetup(): void {
  if (started) return;
  started = true;
  const backend = getBackend();
  void load();
  backend
    .onSetupChanged(() => void load())
    .then((off) => offs.push(off))
    .catch(() => {});
  backend
    .onInfo((info) => {
      // The sandbox copy finishing, or a new folder chosen, changes what is being read.
      const key = `${info.config?.dir ?? ""}|${info.sandbox.state}`;
      if (lastConfigKey && key !== lastConfigKey) void load();
      lastConfigKey = key;
    })
    .then((off) => offs.push(off))
    .catch(() => {});
  lastConfigKey = `${backend.boot().config?.dir ?? ""}|${backend.boot().sandbox.state}`;
}

export function reloadSetup(): void {
  void load();
}

export function setIncludeWorktrees(v: boolean): void {
  if (state.includeWorktrees === v) return;
  set({ includeWorktrees: v });
  void load();
}

/** Tests: forget everything and detach listeners. */
export function resetSetupStore(): void {
  for (const off of offs.splice(0)) off();
  seq += 1;
  inflight = false;
  again = false;
  started = false;
  lastConfigKey = "";
  state = INITIAL;
  for (const s of subs) s();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => state;

export function useSetup(): SetupState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
