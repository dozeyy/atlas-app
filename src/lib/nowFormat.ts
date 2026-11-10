// Small text helpers for the Now tab.

import type { NowChat, NowLast, NowSnapshot } from "./nowTypes";
import { formatDuration } from "./usage";
import type { Cost } from "./usageTypes";

/** The live snapshot carries a dollar estimate and a flag, not a full Cost: rebuild one for the hover. */
export function nowCost(usd: number | null, unpriced: boolean): Cost {
  return { usd, complete: !unpriced, unpricedTokens: 0 };
}

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

/** What the page shows for a snapshot: three separate groups. Finished falls back to the single last chat. */
export function groupChats(snap: NowSnapshot): { running: NowChat[]; waiting: NowChat[]; finished: NowLast[] } {
  return {
    running: snap.chats.filter((c) => c.state === "working"),
    waiting: snap.chats.filter((c) => c.state !== "working"),
    finished: snap.recent.length > 0 ? snap.recent : snap.last ? [snap.last] : [],
  };
}

/**
 * A file path split before its last part, so a tight line can drop folders and keep the file
 * name ("src/compon.../Heatmap.tsx"). Anything that is not a plain path (a command, a search,
 * a web address) is null and is cut at its end as usual.
 */
export function splitPath(target: string): { head: string; tail: string } | null {
  if (/\s/.test(target) || target.includes("://")) return null;
  const cut = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  if (cut <= 0 || cut === target.length - 1) return null;
  return { head: target.slice(0, cut), tail: target.slice(cut) };
}
