import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ClockProvider } from "./clock";

beforeEach(() => document.documentElement.classList.remove("reduced"));
afterEach(() => {
  vi.unstubAllGlobals();
  // The setup runs every test with reduced motion (tests read final numbers); put it back.
  document.documentElement.classList.add("reduced");
});

function frames() {
  const queued: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => queued.push(cb));
  vi.stubGlobal("cancelAnimationFrame", () => {});
  return queued;
}

describe("the poster clock", () => {
  it("starts once per mount, whatever the lead does while the slide changes", () => {
    const queued = frames();
    // The element the clock marks while it runs: counting its data-run writes counts the starts.
    const el = document.createElement("div");
    let starts = 0;
    const set = el.setAttribute.bind(el);
    el.setAttribute = (k: string, v: string) => {
      if (k === "data-run") starts++;
      set(k, v);
    };
    const run = { current: el };
    const ui = (delay: number) => (
      <ClockProvider mood="snappy" delay={delay} runRef={run}>
        <i />
      </ClockProvider>
    );
    const { rerender } = render(ui(0));
    // The wipe sets a lead, then the lead goes back to nothing, as the slide settles.
    rerender(ui(240));
    rerender(ui(0));
    rerender(ui(240));
    rerender(ui(0));
    expect(starts).toBe(1);
    // And it is still the one loop: a single frame is queued, not one per rerender.
    expect(queued.length).toBe(1);
  });

  it("holds t at 0 for the lead it started with", () => {
    const queued = frames();
    const ts: number[] = [];
    render(
      <ClockProvider mood="snappy" delay={300} onFrame={(t) => ts.push(t)}>
        <i />
      </ClockProvider>,
    );
    queued[0](performance.now() + 50);
    expect(ts[ts.length - 1]).toBe(0);
  });
});
