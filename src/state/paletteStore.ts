// Whether the quick jump (Ctrl+K) is open. A tiny external store, so the shortcut in App.tsx,
// the app menu and the palette itself can all reach it without a provider.

import { useSyncExternalStore } from "react";

let open = false;
const subs = new Set<() => void>();

function set(next: boolean) {
  if (open === next) return;
  open = next;
  for (const s of subs) s();
}

export const openPalette = () => set(true);
export const closePalette = () => set(false);
export const togglePalette = () => set(!open);
export const paletteIsOpen = () => open;

function subscribe(cb: () => void): () => void {
  subs.add(cb);
  return () => void subs.delete(cb);
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, paletteIsOpen, paletteIsOpen);
}
