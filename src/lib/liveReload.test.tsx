import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useLiveReload } from "./useUsage";
import { setBackend } from "./ipc";

let changed: (() => void)[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  changed = [];
  setBackend({
    onUsageChanged: async (cb: () => void) => {
      changed.push(cb);
      return () => {};
    },
    onUsageStatus: async () => () => {},
  } as never);
});
afterEach(() => {
  vi.useRealTimers();
  setBackend(null);
});

const fire = () => act(() => void changed.forEach((cb) => cb()));
const wait = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

describe("useLiveReload", () => {
  it("by default waits for a quiet moment (a burst is one reload)", async () => {
    const reload = vi.fn();
    renderHook(() => useLiveReload(reload));
    await wait(0);
    fire();
    await wait(200);
    fire();
    await wait(200);
    expect(reload).not.toHaveBeenCalled();
    await wait(100);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledWith(true);
  });

  it("with `every`, a chat that never goes quiet still reloads only once per window", async () => {
    const reload = vi.fn();
    renderHook(() => useLiveReload(reload, 5000));
    await wait(0);
    // A live chat: an event every second for 12 seconds.
    for (let i = 0; i < 12; i++) {
      fire();
      await wait(1000);
    }
    // Reloads at 5 s and 10 s: at most one per 5 s, never starved.
    expect(reload).toHaveBeenCalledTimes(2);
    await wait(5000);
    expect(reload).toHaveBeenCalledTimes(3);
    // Quiet again: nothing more.
    await wait(10_000);
    expect(reload).toHaveBeenCalledTimes(3);
  });
});
