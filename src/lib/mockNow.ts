// Stand-in for the Now engine in a plain browser and in tests. It holds one snapshot and
// pushes it to listeners when `push` is called, the way the Rust engine's event does.
// All data here is invented.

import { EMPTY_NOW } from "./nowTypes";
import type { NowSnapshot } from "./nowTypes";

type Unlisten = () => void;

export class MockNow {
  private snap: NowSnapshot = EMPTY_NOW;
  private listeners = new Set<(s: NowSnapshot) => void>();

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

  nowSnapshot = async (): Promise<NowSnapshot> => this.snap;

  onNowUpdate = async (cb: (s: NowSnapshot) => void): Promise<Unlisten> => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };
}
