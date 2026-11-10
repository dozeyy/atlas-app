import type { Receipt, ReceiptFlag, ReceiptItem } from "./usageTypes";
import type { CostReport } from "./setup-types";

/**
 * Atlas says "session" everywhere (2026-11-10). The engine still writes "chat" in a few fixed
 * names it hands over ("Main chat", "All chats", "Chats in atlas"), so each of those is reworded
 * here, once, where its answer enters the app. Only the engine's own fixed phrases are touched:
 * a title, a project or a helper name that a person wrote is never changed.
 */
export const MAIN_SESSION = "Main session";

const ENGINE_MAIN = "Main chat";

function mainName<T extends string | null>(name: T): T | typeof MAIN_SESSION {
  return name === ENGINE_MAIN ? MAIN_SESSION : name;
}

/** "All chats" / "Chats in atlas" / "Chats that connect them", in the app's word. */
export function loadsInWords(loadsIn: string): string {
  return loadsIn.replace(/^All chats\b/, "All sessions").replace(/^Chats\b/, "Sessions");
}

const item = (i: ReceiptItem): ReceiptItem => (i.thread === ENGINE_MAIN ? { ...i, thread: MAIN_SESSION } : i);
/** A flag about the main thread carries its name as the label; a file or a tool is left alone. */
const flag = (f: ReceiptFlag): ReceiptFlag => (f.agentId === null && f.label === ENGINE_MAIN ? { ...f, label: MAIN_SESSION } : f);

/** A session's receipt as the engine sent it, with the main thread named the app's way. */
export function receiptWords(r: Receipt | null): Receipt | null {
  if (!r) return r;
  return {
    ...r,
    items: r.items.map(item),
    flags: r.flags.map(flag),
    threads: r.threads.map((t) => ({
      ...t,
      name: t.agentId === null ? mainName(t.name) : t.name,
      items: t.items.map(item),
      flags: t.flags.map(flag),
    })),
  };
}

/**
 * A line the engine wrote for a person to read (an error from a session action), in the app's
 * word. Only the engine's own sentence is reworded: "This chat has no project folder." A path or
 * a name inside any other message is passed through as it is.
 */
export function engineLineWords(message: string): string {
  return message.replace(/^This chat\b/, "This session");
}

/** The Toolkit's cost report with "where it loads" in the app's word. */
export function costWords(report: CostReport): CostReport {
  return { ...report, rows: report.rows.map((row) => ({ ...row, loadsIn: loadsInWords(row.loadsIn) })) };
}
