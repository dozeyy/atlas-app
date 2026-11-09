// Unsaved edits, and the one "Discard your changes?" question every way out goes through.
// An open editor reports itself here; a sidebar click, Ctrl+1..7, the quick jump, the Wrapped
// gift and a quit all call `guardLeave` before they move away, so none of them can drop an edit
// without asking. A tiny external store so those callers need no provider.

import { useSyncExternalStore } from "react";

const editors = new Set<string>();
let asking: (() => void) | null = null;
let bypass = false;
const subs = new Set<() => void>();
const tell = () => {
  for (const s of subs) s();
};

/** An editor says whether it holds edits that are not saved. Call with `false` when it goes away. */
export function setUnsaved(who: string, on: boolean): void {
  if (editors.has(who) === on) return;
  if (on) editors.add(who);
  else editors.delete(who);
  tell();
}

export const hasUnsaved = () => editors.size > 0;

/**
 * Run `proceed` now when nothing is unsaved; otherwise ask first and run it only on Discard.
 * Whatever `proceed` itself starts (a view change inside a palette jump) is not asked a second time.
 */
export function guardLeave(proceed: () => void): void {
  if (bypass || editors.size === 0) {
    proceed();
    return;
  }
  asking = proceed;
  tell();
}

/** The user chose Discard: run what was waiting. */
export function confirmLeave(): void {
  const go = asking;
  asking = null;
  tell();
  if (!go) return;
  bypass = true;
  try {
    go();
  } finally {
    bypass = false;
  }
}

/** The user chose Keep editing. */
export function cancelLeave(): void {
  if (!asking) return;
  asking = null;
  tell();
}

const isAsking = () => asking !== null;

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

export function useLeaveQuestion(): boolean {
  return useSyncExternalStore(subscribe, isAsking, isAsking);
}

export function useAnyUnsaved(): boolean {
  return useSyncExternalStore(subscribe, hasUnsaved, hasUnsaved);
}

/** Test reset. */
export function resetUnsaved(): void {
  editors.clear();
  asking = null;
  bypass = false;
  tell();
}
