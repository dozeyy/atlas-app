// What the Sessions list remembers between launches: how it is grouped, and which folders are
// folded. Kept in localStorage (a browser that refuses it, private mode say, just forgets).

export type Grouping = "folder" | "day";

const GROUPING_KEY = "atlas.sessions.grouping";
const FOLDED_KEY = "atlas.sessions.folded";

export function readGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === "day" ? "day" : "folder";
  } catch {
    return "folder";
  }
}

export function writeGrouping(g: Grouping): void {
  try {
    localStorage.setItem(GROUPING_KEY, g);
  } catch {
    /* forgotten */
  }
}

/** The folder keys (paths) that are folded shut. */
export function readFolded(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function writeFolded(keys: Iterable<string>): void {
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...keys]));
  } catch {
    /* forgotten */
  }
}
