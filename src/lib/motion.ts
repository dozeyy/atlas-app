// Motion rules shared by the charts and numbers: reduced motion, and "once per launch".

import { useEffect, useState } from "react";

/** True when the OS asks for reduced motion (mirrored on <html class="reduced">, see theme.ts). */
export function prefersReducedMotion(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("reduced");
}

const played = new Set<string>();

/** Has `id` already played in this launch? */
export function hasPlayed(id: string): boolean {
  return played.has(id);
}

export function markPlayed(id: string): void {
  played.add(id);
}

/** Test hook: forget what has played. */
export function resetPlayed(): void {
  played.clear();
}

/**
 * Whether a chart plays its first-paint animation. Decided once when it mounts; going to
 * another page and coming back later in the launch does not replay it.
 */
export function useIntro(id: string): boolean {
  const [play] = useState(() => !played.has(id));
  useEffect(() => markPlayed(id), [id]);
  return play;
}
