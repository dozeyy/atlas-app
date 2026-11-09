import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setBackend } from "./ipc";
import type { Backend } from "./ipc";
import { refreshPaletteData, resetPaletteData, subscribe } from "./usePaletteData";

interface Fake {
  backend: Backend;
  listeners: Set<() => void>;
  loads: () => number;
  fire: () => void;
  listenCalls: () => number;
}

/** Just the three calls the quick jump makes; a listener is a callback that can be taken away. */
function fakeBackend(opts: { failListen?: boolean } = {}): Fake {
  const listeners = new Set<() => void>();
  let loads = 0;
  let listenCalls = 0;
  const backend = {
    sessionsList: async () => {
      loads++;
      return { rows: [], total: 0 };
    },
    usageFilterOptions: async () => ({ projects: [] }),
    onUsageChanged: async (cb: () => void) => {
      listenCalls++;
      if (opts.failListen) throw new Error("no events yet");
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },
  } as unknown as Backend;
  return { backend, listeners, loads: () => loads, fire: () => [...listeners].forEach((l) => l()), listenCalls: () => listenCalls };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  resetPaletteData();
});
afterEach(() => {
  resetPaletteData();
  setBackend(null);
  vi.useRealTimers();
});

describe("quick jump data: the change listener", () => {
  it("listens once however often it is asked to refresh", async () => {
    const f = fakeBackend();
    setBackend(f.backend);
    await refreshPaletteData();
    await refreshPaletteData(true);
    await refreshPaletteData(true);
    await settle();
    expect(f.listenCalls()).toBe(1);
    expect(f.listeners.size).toBe(1);
  });

  it("lets go of the old backend's listener when the backend changes", async () => {
    const a = fakeBackend();
    const b = fakeBackend();
    setBackend(a.backend);
    await refreshPaletteData();
    await settle();
    expect(a.listeners.size).toBe(1);
    setBackend(b.backend);
    await refreshPaletteData();
    await settle();
    expect(a.listeners.size).toBe(0);
    expect(b.listeners.size).toBe(1);
  });

  it("drops a listener that arrives after the backend has already changed", async () => {
    const a = fakeBackend();
    const b = fakeBackend();
    setBackend(a.backend);
    const first = refreshPaletteData(); // a's listener is still being set up
    setBackend(b.backend);
    await refreshPaletteData();
    await first;
    await settle();
    expect(a.listeners.size).toBe(0);
    expect(b.listeners.size).toBe(1);
  });

  it("tries again on the next refresh when listening failed", async () => {
    const f = fakeBackend({ failListen: true });
    setBackend(f.backend);
    await refreshPaletteData();
    await settle();
    await refreshPaletteData(true);
    await settle();
    expect(f.listenCalls()).toBe(2);
  });
});

describe("quick jump data: staying fresh while it is open", () => {
  it("asks again after a change when the quick jump is open", async () => {
    const f = fakeBackend();
    setBackend(f.backend);
    const off = subscribe(() => {});
    await refreshPaletteData();
    await settle();
    expect(f.loads()).toBe(1);
    f.fire();
    f.fire();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.loads()).toBe(2); // one refresh for the burst
    off();
  });

  it("does not load in the background when the quick jump is closed, but is old at the next open", async () => {
    const f = fakeBackend();
    setBackend(f.backend);
    await refreshPaletteData();
    await settle();
    f.fire();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.loads()).toBe(1);
    // Opened a moment later: the copy is not "young", so it asks.
    await refreshPaletteData();
    expect(f.loads()).toBe(2);
  });

  it("asks once more when a change lands while it is loading", async () => {
    const f = fakeBackend();
    setBackend(f.backend);
    const off = subscribe(() => {});
    const first = refreshPaletteData();
    await settle();
    f.fire(); // during the first load
    await first;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.loads()).toBe(2);
    off();
  });
});
