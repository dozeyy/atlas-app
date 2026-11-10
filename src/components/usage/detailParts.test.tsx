import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAMP_SETTLE_MS, ClampList, ClampText } from "./detailParts";

const LONG = "Read every file that the export button touches and report back. ".repeat(12).trim();

/** jsdom lays nothing out, so the heights a real window would report are stood in here. */
function heights(scroll: number, client: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => scroll });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => client });
}

afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
});

describe("ClampText", () => {
  it("cuts long text to a few lines, keeps all of it in the page, and shows the rest when asked", async () => {
    heights(240, 60);
    const { container } = render(<ClampText text={LONG} />);
    const p = container.querySelector("p")!;
    expect(p).toHaveTextContent(LONG);
    expect(p.classList.contains("clamp-lines")).toBe(true);
    const more = screen.getByRole("button", { name: "Show all" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(more);
    expect(p.classList.contains("clamp-lines")).toBe(false);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(less);
    expect(p.classList.contains("clamp-lines")).toBe(true);
  });

  it("offers no button when nothing is cut", () => {
    heights(40, 40);
    render(<ClampText text="Short ask." />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("ClampList", () => {
  /** A stand-in size watcher that counts itself and can be fired by hand. */
  class FakeRO {
    static all: FakeRO[] = [];
    watched: Element[] = [];
    constructor(public cb: () => void) {
      FakeRO.all.push(this);
    }
    observe(el: Element) {
      this.watched.push(el);
    }
    disconnect() {
      this.watched = [];
    }
  }
  const real = globalThis.ResizeObserver;
  beforeEach(() => {
    FakeRO.all = [];
    globalThis.ResizeObserver = FakeRO as unknown as typeof ResizeObserver;
    vi.useFakeTimers();
  });
  afterEach(() => {
    globalThis.ResizeObserver = real;
    vi.useRealTimers();
    delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  });

  it("a text on its own watches itself; three hundred in a list share the list's one watcher", () => {
    heights(40, 40);
    const alone = render(<ClampText text={LONG} />);
    expect(FakeRO.all).toHaveLength(1);
    alone.unmount();
    FakeRO.all = [];

    render(
      <ClampList>
        {Array.from({ length: 300 }, (_, i) => (
          <li key={i}>
            <ClampText text={LONG} lines={6} />
          </li>
        ))}
      </ClampList>,
    );
    expect(FakeRO.all).toHaveLength(1);
    expect(FakeRO.all[0].watched).toHaveLength(1);
    expect(FakeRO.all[0].watched[0].tagName).toBe("OL");
  });

  it("measures again once the list's width has settled, not on every frame and not for a height change", () => {
    let reads = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => (reads++, 40) });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 40 });
    let width = 600;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => width });
    render(
      <ClampList>
        {Array.from({ length: 10 }, (_, i) => (
          <li key={i}>
            <ClampText text={LONG} lines={6} />
          </li>
        ))}
      </ClampList>,
    );
    const ro = FakeRO.all[0];
    expect(reads).toBe(10);

    // A height-only change (more rows loaded): the watcher fires, nothing is measured.
    act(() => ro.cb());
    act(() => void vi.advanceTimersByTime(CLAMP_SETTLE_MS + 10));
    expect(reads).toBe(10);

    // A drag: many frames of new widths, then it stops. One pass, after it settles.
    for (const w of [590, 570, 540, 500]) {
      width = w;
      act(() => ro.cb());
      act(() => void vi.advanceTimersByTime(16));
    }
    expect(reads).toBe(10);
    act(() => void vi.advanceTimersByTime(CLAMP_SETTLE_MS + 10));
    expect(reads).toBe(20);

    // The cut is found at the new width.
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 240 });
    width = 300;
    act(() => ro.cb());
    act(() => void vi.advanceTimersByTime(CLAMP_SETTLE_MS + 10));
    expect(screen.getAllByRole("button", { name: "Show all" })).toHaveLength(10);
  });
});
