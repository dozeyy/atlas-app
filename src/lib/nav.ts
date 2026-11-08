// One-shot hand-off between pages: "open this session when Sessions appears".
// Pages are not routed by URL, so a module variable is the simplest honest carrier.

let pending: string | null = null;

export function openSessionNext(sessionId: string): void {
  pending = sessionId;
}

export function peekPendingSession(): string | null {
  return pending;
}

export function clearPendingSession(): void {
  pending = null;
}
