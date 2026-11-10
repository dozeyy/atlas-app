import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HIDE_MS, installScrollbars } from "./scrollbars";

describe("installScrollbars", () => {
  let off: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    off = installScrollbars(document);
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("marks a container while it scrolls and clears it once it is still", () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    box.dispatchEvent(new Event("scroll"));
    expect(box.hasAttribute("data-scrolling")).toBe(true);
    vi.advanceTimersByTime(HIDE_MS - 100);
    box.dispatchEvent(new Event("scroll")); // still scrolling: the timer restarts
    vi.advanceTimersByTime(HIDE_MS - 100);
    expect(box.hasAttribute("data-scrolling")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(box.hasAttribute("data-scrolling")).toBe(false);
  });

  it("cleans up on uninstall", () => {
    const box = document.createElement("div");
    document.body.appendChild(box);
    box.dispatchEvent(new Event("scroll"));
    off();
    expect(box.hasAttribute("data-scrolling")).toBe(false);
    box.dispatchEvent(new Event("scroll"));
    expect(box.hasAttribute("data-scrolling")).toBe(false);
    off = () => {};
  });
});
