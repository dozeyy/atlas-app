import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSE_MS, CLOSE_REDUCED_MS, useClosing } from "./useClosing";

describe("useClosing", () => {
  // The test setup runs with reduced motion on; these read the full-motion timing unless told otherwise.
  beforeEach(() => {
    vi.useFakeTimers();
    document.documentElement.classList.remove("reduced");
  });
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.classList.add("reduced");
  });

  it("closes sooner, as a fade, with reduced motion", () => {
    document.documentElement.classList.add("reduced");
    const onClose = vi.fn();
    const { result } = renderHook(() => useClosing(onClose));
    act(() => result.current.requestClose());
    act(() => vi.advanceTimersByTime(CLOSE_REDUCED_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("marks the element as leaving, then closes once the exit has played", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useClosing(onClose));
    expect(result.current.closing).toBe(false);
    act(() => result.current.requestClose());
    expect(result.current.closing).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(CLOSE_MS - 1));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is at rest again once onClose has run: a sheet kept mounted is visible and can close again", () => {
    const onClose = vi.fn();
    const { result } = renderHook(() => useClosing(onClose));
    act(() => result.current.requestClose());
    expect(result.current.closing).toBe(true);
    act(() => vi.advanceTimersByTime(CLOSE_MS));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(result.current.closing).toBe(false);
    act(() => result.current.requestClose());
    expect(result.current.closing).toBe(true);
    act(() => vi.advanceTimersByTime(CLOSE_MS));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes once however many times it is asked, and never after unmount", () => {
    const onClose = vi.fn();
    const { result, unmount } = renderHook(() => useClosing(onClose));
    act(() => {
      result.current.requestClose();
      result.current.requestClose();
    });
    act(() => vi.advanceTimersByTime(CLOSE_MS * 2));
    expect(onClose).toHaveBeenCalledTimes(1);

    const later = vi.fn();
    const second = renderHook(() => useClosing(later));
    act(() => second.result.current.requestClose());
    second.unmount();
    unmount();
    act(() => vi.advanceTimersByTime(CLOSE_MS * 2));
    expect(later).not.toHaveBeenCalled();
  });
});
