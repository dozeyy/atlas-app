// Small messages at the bottom of the window ("Deleted X. Undo"). A tiny external
// store like setupStore: no provider, the host component just subscribes.

import { useSyncExternalStore } from "react";

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "success" | "error";
  action?: ToastAction;
}

export interface ToastInput {
  message: string;
  tone?: Toast["tone"];
  action?: ToastAction;
  /** How long it stays, in ms. Errors and toasts with an action stay longer. */
  ms?: number;
}

let toasts: Toast[] = [];
let next = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const subs = new Set<() => void>();

function emit() {
  for (const s of subs) s();
}

export function dismissToast(id: number): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  if (toasts.some((x) => x.id === id)) {
    toasts = toasts.filter((x) => x.id !== id);
    emit();
  }
}

export function pushToast(input: ToastInput): number {
  const id = next++;
  const tone = input.tone ?? "info";
  const toast: Toast = { id, message: input.message, tone, action: input.action };
  // At most three at once: the oldest goes first.
  const keep = toasts.slice(-2);
  for (const gone of toasts.slice(0, toasts.length - keep.length)) dismissToast(gone.id);
  toasts = [...keep, toast];
  const ms = input.ms ?? (input.action ? 12_000 : tone === "error" ? 8_000 : 4_000);
  timers.set(
    id,
    setTimeout(() => dismissToast(id), ms),
  );
  emit();
  return id;
}

/** Tests: forget every toast. */
export function resetToasts(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  toasts = [];
  emit();
}

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => subs.delete(cb);
}

const snapshot = () => toasts;

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
