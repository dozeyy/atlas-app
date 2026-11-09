// Stand-in for the Now engine in a plain browser and in tests. It holds one snapshot and
// pushes it to listeners when `push` is called, the way the Rust engine's event does.
// All data here is invented.

import { EMPTY_NOW } from "./nowTypes";
import type { NowFinished, NowSnapshot } from "./nowTypes";

type Unlisten = () => void;

export class MockNow {
  private snap: NowSnapshot = EMPTY_NOW;
  private listeners = new Set<(s: NowSnapshot) => void>();
  private finishedListeners = new Set<(f: NowFinished) => void>();

  constructor() {
    // Dev server only: lets a person (or a screenshot script) drive the page by hand.
    if (import.meta.env.DEV && typeof window !== "undefined") {
      (window as unknown as { __atlasNow?: MockNow }).__atlasNow = this;
    }
  }

  /** Test and demo hook: make this the current snapshot and tell the page. */
  push(next: NowSnapshot): void {
    this.snap = next;
    for (const l of this.listeners) l(next);
  }

  /** Test and demo hook: a chat just stopped. */
  finish(f: NowFinished): void {
    for (const l of this.finishedListeners) l(f);
  }

  nowSnapshot = async (): Promise<NowSnapshot> => this.snap;

  onNowUpdate = async (cb: (s: NowSnapshot) => void): Promise<Unlisten> => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  onNowFinished = async (cb: (f: NowFinished) => void): Promise<Unlisten> => {
    this.finishedListeners.add(cb);
    return () => {
      this.finishedListeners.delete(cb);
    };
  };
}
