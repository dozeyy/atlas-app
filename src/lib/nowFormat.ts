// Small text helpers for the Now tab.

import { formatDuration } from "./usage";

/** 83 s -> "1:23", 3725 s -> "1:02:05". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "just now", "12 min ago", "2 h ago". */
export function ago(ms: number, now: number): string {
  const d = now - ms;
  return d < 45_000 ? "just now" : `${formatDuration(d)} ago`;
}
