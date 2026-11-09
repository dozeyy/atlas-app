// What the page knows about updates, in one place so the sidebar icon and the Settings button
// agree. Nothing here installs by itself: `startInstall` runs only from a click.

import { useSyncExternalStore } from "react";
import { getBackend } from "./ipc";
import type { UpdateInfo } from "./updateTypes";

/** The first quiet check, after the first paint and the first index have had the disk. */
export const FIRST_CHECK_MS = 5_000;
/** Then once every six hours while Atlas stays open. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

export type UpdateState =
  | { kind: "none" }
  | { kind: "available"; info: UpdateInfo }
  /** `fraction` is null until the server says how big the file is. */
  | { kind: "downloading"; info: UpdateInfo; fraction: number | null }
  | { kind: "installing"; info: UpdateInfo }
  | { kind: "failed"; info: UpdateInfo; message: string };

export interface UpdateSnapshot {
  state: UpdateState;
  /** "Later": the icon stays away until the next launch. */
  dismissed: boolean;
}

let snap: UpdateSnapshot = { state: { kind: "none" }, dismissed: false };
const listeners = new Set<() => void>();

function set(next: Partial<UpdateSnapshot>) {
  snap = { ...snap, ...next };
  listeners.forEach((l) => l());
}

export function useUpdate(): UpdateSnapshot {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => snap,
  );
}

/** Tests start each case from nothing. */
export function resetUpdateStore() {
  snap = { state: { kind: "none" }, dismissed: false };
  listeners.forEach((l) => l());
}

const busy = (s: UpdateState) => s.kind === "downloading" || s.kind === "installing";

export type CheckOutcome = { outcome: "available"; info: UpdateInfo } | { outcome: "latest" } | { outcome: "failed"; message: string };

/**
 * Ask whether a newer version exists. The quiet checks (`manual: false`) never complain and never
 * bring back an icon the person sent away; the Settings button (`manual: true`) answers every time.
 */
export async function checkForUpdate({ manual }: { manual: boolean }): Promise<CheckOutcome> {
  if (busy(snap.state)) {
    const s = snap.state as { info: UpdateInfo };
    return { outcome: "available", info: s.info };
  }
  try {
    const info = await getBackend().updateCheck();
    if (busy(snap.state)) return { outcome: "available", info: (snap.state as { info: UpdateInfo }).info };
    if (!info) {
      set({ state: { kind: "none" } });
      return { outcome: "latest" };
    }
    // A failed install keeps its message until the next try; a fresh find otherwise resets.
    const keep = snap.state.kind === "failed" && snap.state.info.version === info.version;
    set({ state: keep ? snap.state : { kind: "available", info }, dismissed: manual ? false : snap.dismissed });
    return { outcome: "available", info };
  } catch (e) {
    return { outcome: "failed", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Hide the icon until the next launch. */
export function dismissUpdate() {
  set({ dismissed: true });
}

/** Download, verify and install the update that was found. On success the app is replaced and
 *  this never comes back; on failure the icon stays with one plain line and a retry. */
export async function startInstall(): Promise<void> {
  const s = snap.state;
  if (s.kind !== "available" && s.kind !== "failed") return;
  const { info } = s;
  const backend = getBackend();
  set({ state: { kind: "downloading", info, fraction: null } });
  let off: (() => void) | undefined;
  try {
    off = await backend.onUpdateProgress((p) => {
      if (snap.state.kind !== "downloading" && snap.state.kind !== "installing") return;
      if (p.installing) set({ state: { kind: "installing", info } });
      else set({ state: { kind: "downloading", info, fraction: p.total ? Math.min(1, p.downloaded / p.total) : null } });
    });
    await backend.updateInstall();
  } catch (e) {
    set({ state: { kind: "failed", info, message: e instanceof Error ? e.message : String(e) } });
  } finally {
    off?.();
  }
}
