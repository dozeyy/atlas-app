import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { msToMidnight, useDayChange, useToday } from "./today";
import { fetchDaily, useDaily } from "./useDaily";
import { setBackend } from "./ipc";
import { addDays, localDay } from "./usage";
import type { Timeline } from "./types";

// Local time throughout: these dates have no zone suffix.
const at = (s: string) => new Date(s).getTime();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setBackend(null);
});

function setVisibility(state: "visible" | "hidden") {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("msToMidnight", () => {
  it("counts to the next local midnight", () => {
    expect(msToMidnight(new Date("2026-11-10T23:59:30"))).toBe(30_000);
    expect(msToMidnight(new Date("2026-11-10T00:00:00"))).toBe(24 * 3600_000);
  });
});

describe("useToday", () => {
  it("flips at local midnight with one timer, then waits for the next one", () => {
    vi.setSystemTime(at("2026-11-10T23:59:50"));
    const { result } = renderHook(() => useToday());
    expect(result.current).toBe("2026-11-10");
    expect(vi.getTimerCount()).toBe(1);

    act(() => void vi.advanceTimersByTime(9_000));
    expect(result.current).toBe("2026-11-10");
    act(() => void vi.advanceTimersByTime(1_500));
    expect(result.current).toBe("2026-11-11");

    // Re-armed for the following midnight, not left idle and not polling.
    expect(vi.getTimerCount()).toBe(1);
    act(() => void vi.advanceTimersByTime(24 * 3600_000));
    expect(result.current).toBe("2026-11-12");
  });

  it("holds no timer once nothing reads it", () => {
    vi.setSystemTime(at("2026-11-10T12:00:00"));
    const { unmount } = renderHook(() => useToday());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("catches up when the window is shown after being hidden over midnight (timers did not run)", () => {
    vi.setSystemTime(at("2026-11-10T22:00:00"));
    const { result } = renderHook(() => useToday());
    expect(result.current).toBe("2026-11-10");

    act(() => setVisibility("hidden"));
    // Asleep or hidden: the clock moves, the timer does not get to fire.
    vi.setSystemTime(at("2026-11-11T07:30:00"));
    expect(result.current).toBe("2026-11-10");
    act(() => setVisibility("visible"));
    expect(result.current).toBe("2026-11-11");
    // And the timer was set again from the real time: the next flip is the coming midnight.
    act(() => void vi.advanceTimersByTime(16 * 3600_000 + 31 * 60_000));
    expect(result.current).toBe("2026-11-12");
  });

  it("does not flip while the window is hidden, only when it is shown", () => {
    vi.setSystemTime(at("2026-11-10T22:00:00"));
    const { result } = renderHook(() => useToday());
    act(() => setVisibility("hidden"));
    vi.setSystemTime(at("2026-11-11T07:30:00"));
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current).toBe("2026-11-10");
  });

  it("the midnight timer stays quiet while the window is hidden, and showing it catches up", () => {
    vi.setSystemTime(at("2026-11-10T23:30:00"));
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useToday();
    });
    act(() => setVisibility("hidden"));
    const before = renders;

    // The timer really fires at midnight (the clock and the timer agree), with the window in the tray.
    act(() => void vi.advanceTimersByTime(31 * 60_000));
    expect(localDay(new Date())).toBe("2026-11-11");
    expect(result.current).toBe("2026-11-10");
    expect(renders).toBe(before);
    // It set itself for the following midnight rather than going idle.
    expect(vi.getTimerCount()).toBe(1);

    act(() => setVisibility("visible"));
    expect(result.current).toBe("2026-11-11");
    // Still exactly one timer, now for the next midnight.
    expect(vi.getTimerCount()).toBe(1);
    act(() => void vi.advanceTimersByTime(24 * 3600_000));
    expect(result.current).toBe("2026-11-12");
  });

  it("re-checks on focus", () => {
    vi.setSystemTime(at("2026-11-10T22:00:00"));
    const { result } = renderHook(() => useToday());
    vi.setSystemTime(at("2026-11-11T07:30:00"));
    act(() => void window.dispatchEvent(new Event("focus")));
    expect(result.current).toBe("2026-11-11");
  });

  it("does not render again when the day is the same", () => {
    vi.setSystemTime(at("2026-11-10T22:00:00"));
    let renders = 0;
    renderHook(() => {
      renders++;
      return useToday();
    });
    const before = renders;
    act(() => void window.dispatchEvent(new Event("focus")));
    act(() => setVisibility("visible"));
    expect(renders).toBe(before);
  });

  it("useDayChange fires once per new day, never on mount", () => {
    vi.setSystemTime(at("2026-11-10T23:59:59"));
    const seen: string[] = [];
    renderHook(() => useDayChange((d) => seen.push(d)));
    expect(seen).toEqual([]);
    act(() => void vi.advanceTimersByTime(2_000));
    expect(seen).toEqual(["2026-11-11"]);
  });
});

/** A usage backend where only `active` days have tokens; it records what the hook asked for. */
function fakeBackend(active: Set<string>) {
  const asked: { from: string; to: string }[] = [];
  const usageTimeline = vi.fn(async (a: { from: string; to: string }): Promise<Timeline> => {
    asked.push({ from: a.from, to: a.to });
    const points = [...active]
      .filter((d) => d >= a.from && d <= a.to)
      .sort()
      .map((d) => ({
        start: d,
        tokens: { input: 1000, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, total: 1000, webSearch: 0, webFetch: 0 },
        cost: { usd: 0.01, complete: true, unpricedTokens: 0 },
        sessions: 1,
      }));
    return { points } as unknown as Timeline;
  });
  setBackend({ usageTimeline, onUsageChanged: async () => () => {} } as never);
  return { asked, usageTimeline };
}

describe("useDaily across midnight", () => {
  it("asks again for the new day: Today and the streak move without any new usage event", async () => {
    vi.setSystemTime(at("2026-11-10T23:59:30"));
    const { asked } = fakeBackend(new Set(["2026-11-08", "2026-11-09", "2026-11-10"]));
    const { result } = renderHook(() => useDaily("/proj"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current?.today).toBe("2026-11-10");
    expect(result.current?.streak).toBe(3);
    expect(result.current?.tokens.at(-1)).toBe(1000);
    expect(asked.at(-1)?.to).toBe("2026-11-10");

    // Midnight passes. Nothing used yet today: the Today cell is a new, empty day and the streak
    // still counts up to yesterday.
    await act(async () => void (await vi.advanceTimersByTimeAsync(31_000)));
    expect(asked.at(-1)?.to).toBe("2026-11-11");
    expect(result.current?.today).toBe("2026-11-11");
    expect(result.current?.days.at(-1)).toBe("2026-11-11");
    expect(result.current?.tokens.at(-1)).toBe(0);
    expect(result.current?.tokens.at(-2)).toBe(1000);
    expect(result.current?.streak).toBe(3);

    // A day with no usage at all: the streak is over.
    await act(async () => void (await vi.advanceTimersByTimeAsync(24 * 3600_000)));
    expect(result.current?.today).toBe("2026-11-12");
    expect(result.current?.streak).toBe(0);
  });

  it("refetches when the window is shown on a later day after being hidden over midnight", async () => {
    vi.setSystemTime(at("2026-11-10T21:00:00"));
    const { asked, usageTimeline } = fakeBackend(new Set(["2026-11-09", "2026-11-10"]));
    const { result } = renderHook(() => useDaily("/proj"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(result.current?.streak).toBe(2);
    const calls = usageTimeline.mock.calls.length;

    act(() => setVisibility("hidden"));
    vi.setSystemTime(at("2026-11-11T08:15:00"));
    // Hidden: nothing is fetched behind the user's back until the window is shown.
    expect(usageTimeline.mock.calls.length).toBe(calls);
    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(asked.at(-1)?.to).toBe("2026-11-11");
    expect(result.current?.today).toBe("2026-11-11");
    expect(result.current?.tokens.at(-1)).toBe(0);
    expect(result.current?.streak).toBe(2);
  });

  it("asks for the 365 days that end on the new day", async () => {
    vi.setSystemTime(at("2026-11-10T23:59:59"));
    const { asked } = fakeBackend(new Set());
    renderHook(() => useDaily("/proj"));
    await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)));
    const last = asked.at(-1)!;
    expect(last.to).toBe(localDay(new Date()));
    expect(last.from).toBe(addDays(last.to, -364));
  });
});

describe("fetchDaily cache", () => {
  it("is asked once per day and scope, and starts over on a new day", async () => {
    vi.setSystemTime(at("2026-11-10T12:00:00"));
    const { usageTimeline } = fakeBackend(new Set(["2026-11-10"]));
    await fetchDaily("2026-11-10", "/a");
    await fetchDaily("2026-11-10", "/a");
    expect(usageTimeline).toHaveBeenCalledTimes(1);
    await fetchDaily("2026-11-10", "/b");
    expect(usageTimeline).toHaveBeenCalledTimes(2);
    await fetchDaily("2026-11-11", "/a");
    expect(usageTimeline).toHaveBeenCalledTimes(3);
    // Yesterday's answers are gone: asking for them again goes to the engine.
    await fetchDaily("2026-11-10", "/a");
    expect(usageTimeline).toHaveBeenCalledTimes(4);
  });
});

