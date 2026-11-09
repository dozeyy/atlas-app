// Stand-in for the updater, for tests and screenshots in a plain browser. By default there is
// nothing newer. A test sets `available`; in the browser `?update=0.2.0` makes one appear, and
// `&progress=60` freezes the download at 60 % so the ring can be looked at (`&fail=1` makes the
// install fail once, `&notes=` sets the release notes).

import type { UpdateInfo, UpdateProgress } from "./updateTypes";

function fromUrl(): { info: UpdateInfo | null; freeze: number | null; fail: boolean } {
  try {
    const q = new URLSearchParams(window.location.search);
    const version = q.get("update");
    if (!version) return { info: null, freeze: null, fail: false };
    const p = q.get("progress");
    return {
      info: {
        version,
        notes: q.get("notes") ?? "A calmer Dashboard and a faster first open.",
        current: "0.1.0",
      },
      freeze: p === null ? null : Math.max(0, Math.min(100, Number(p))),
      fail: q.get("fail") === "1",
    };
  } catch {
    return { info: null, freeze: null, fail: false };
  }
}

const TOTAL = 40_000_000;

export class MockUpdates {
  /** The newer version the next check finds; null means this one is current. */
  available: UpdateInfo | null;
  /** Makes the next check reject with this sentence. */
  checkError: string | null = null;
  /** Makes the next install reject with this sentence. */
  installError: string | null;
  /** How long one step of the fake download takes. */
  stepMs = 250;
  /** Hold the fake download at this percent (screenshots). */
  freezeAt: number | null;
  /** How many checks and installs were asked for. */
  checks = 0;
  installs = 0;
  private listeners = new Set<(p: UpdateProgress) => void>();

  constructor() {
    const u = fromUrl();
    this.available = u.info;
    this.freezeAt = u.freeze;
    this.installError = u.fail ? "The update could not be installed." : null;
  }

  async updateCheck(): Promise<UpdateInfo | null> {
    this.checks += 1;
    if (this.checkError) throw new Error(this.checkError);
    return this.available;
  }

  async updateInstall(): Promise<void> {
    this.installs += 1;
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const pct = (i / steps) * 100;
      if (this.freezeAt !== null && pct > this.freezeAt) {
        this.emit({ downloaded: Math.round((TOTAL * this.freezeAt) / 100), total: TOTAL, installing: false });
        await new Promise<never>(() => {}); // stay here: the screenshot is of this moment
      }
      this.emit({ downloaded: Math.round((TOTAL * i) / steps), total: TOTAL, installing: false });
      await new Promise((r) => setTimeout(r, this.stepMs));
    }
    this.emit({ downloaded: TOTAL, total: TOTAL, installing: true });
    await new Promise((r) => setTimeout(r, this.stepMs));
    if (this.installError) {
      const e = this.installError;
      this.installError = null;
      throw new Error(e);
    }
    // The real app is gone by now (the installer restarts it); the stand-in just stops.
    await new Promise<never>(() => {});
  }

  async onUpdateProgress(cb: (p: UpdateProgress) => void): Promise<() => void> {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(p: UpdateProgress) {
    this.listeners.forEach((l) => l(p));
  }
}
