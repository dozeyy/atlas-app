// One-shot hand-off between pages: "open this session when Sessions appears".
// Pages are not routed by URL, so a module variable is the simplest honest carrier.

let pending: string | null = null;
let pendingProject: string | null = null;
let pendingItem: string | null = null;
const listeners = new Set<() => void>();

const wake = () => {
  for (const l of listeners) l();
};

export function openSessionNext(sessionId: string): void {
  pending = sessionId;
  wake();
}

export function peekPendingSession(): string | null {
  return pending;
}

export function clearPendingSession(): void {
  pending = null;
}

/** "Show the chats of this project when Sessions appears" (a project's key, as the filter uses). */
export function openProjectNext(projectKey: string): void {
  pendingProject = projectKey;
  pending = null;
  wake();
}

export function peekPendingProject(): string | null {
  return pendingProject;
}

export function clearPendingProject(): void {
  pendingProject = null;
}

/** "Open this item when the Toolkit appears" (a Toolkit item id). */
export function openToolkitItemNext(itemId: string): void {
  pendingItem = itemId;
  wake();
}

export function peekPendingToolkitItem(): string | null {
  return pendingItem;
}

export function clearPendingToolkitItem(): void {
  pendingItem = null;
}

/**
 * Told when a session or a project is asked for. A page that is already on screen uses this: it
 * does not mount again, so it cannot read the hand-off from its first render.
 */
export function onNavRequest(cb: () => void): () => void {
  listeners.add(cb);
  return () => void listeners.delete(cb);
}
