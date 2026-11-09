import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TipLayer } from "./TipLayer";
import { EDGE, GAP, place } from "../lib/tipPlace";

const view = { w: 1280, h: 800 };
const tip = { w: 160, h: 40 };
const at = (x: number, y: number) => ({ x, y });

describe("place", () => {
  it("goes below the target, centered, and never touches it", () => {
    const p = place({ left: 500, top: 100, right: 600, bottom: 130 }, tip, view, at(550, 115));
    expect(p.side).toBe("below");
    expect(p.y).toBe(130 + GAP);
    expect(p.x).toBe(550 - tip.w / 2);
  });

  it("flips above when there is no room below", () => {
    const p = place({ left: 500, top: 740, right: 600, bottom: 770 }, tip, view, at(550, 755));
    expect(p.side).toBe("above");
    expect(p.y + tip.h + GAP).toBe(740);
  });

  it("slides back inside the window at either edge and keeps the arrow on the target", () => {
    const left = place({ left: 0, top: 100, right: 20, bottom: 120 }, tip, view, at(10, 110));
    expect(left.x).toBe(EDGE);
    expect(left.caret).toBeLessThan(tip.w);
    const right = place({ left: 1260, top: 100, right: 1280, bottom: 120 }, tip, view, at(1270, 110));
    expect(right.x + tip.w).toBe(view.w - EDGE);
    expect(right.caret).toBeGreaterThan(tip.w / 2);
  });

  it("sits next to the pointer for a target as tall as the window", () => {
    const p = place({ left: 100, top: 0, right: 900, bottom: 800 }, tip, view, at(400, 300));
    expect(p.side).toBe("point");
    expect(p.x).toBeGreaterThanOrEqual(EDGE);
    expect(p.y).toBeGreaterThanOrEqual(EDGE);
    expect(p.y + tip.h).toBeLessThanOrEqual(view.h - EDGE);
  });

  it("follows the pointer along a wide target", () => {
    const p = place({ left: 100, top: 100, right: 1100, bottom: 160 }, tip, view, at(200, 130));
    expect(p.x + tip.w / 2).toBe(200);
  });
});

describe("TipLayer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function mount(extra?: React.ReactNode) {
    return render(
      <div>
        <button title={"117k tokens\nAbout $0.56 at API prices. An estimate, not a bill."}>Open</button>
        <button title="Close">
          <svg aria-hidden="true" />
        </button>
        <span data-tip="Own tip">plain</span>
        {extra}
        <TipLayer />
      </div>,
    );
  }
  const tipBox = () => document.getElementById("atlas-tip") as HTMLElement;

  it("replaces the native tooltip: waits a moment, then shows the text with a quieter second paragraph", () => {
    mount();
    const btn = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerOver(btn);
    // The browser's own box is out of the way from the first moment.
    expect(btn).not.toHaveAttribute("title");
    expect(tipBox()).not.toHaveAttribute("data-open");
    act(() => void vi.advanceTimersByTime(500));
    expect(tipBox()).toHaveAttribute("data-open");
    expect(tipBox().querySelector(".tt-head")).toHaveTextContent("117k tokens");
    expect(tipBox().querySelector(".tt-rest")).toHaveTextContent("About $0.56 at API prices. An estimate, not a bill.");
    expect(btn).toHaveAttribute("aria-describedby", "atlas-tip");
  });

  it("puts the title back when the pointer leaves, and hides", () => {
    mount();
    const btn = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerOver(btn);
    act(() => void vi.advanceTimersByTime(500));
    fireEvent.pointerOut(btn, { relatedTarget: document.body });
    expect(tipBox()).not.toHaveAttribute("data-open");
    expect(btn.getAttribute("title")).toMatch(/^117k tokens/);
    expect(btn).not.toHaveAttribute("data-tip");
    expect(btn).not.toHaveAttribute("aria-describedby");
  });

  it("does not show if the pointer leaves before the pause", () => {
    mount();
    const btn = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerOver(btn);
    fireEvent.pointerOut(btn, { relatedTarget: document.body });
    act(() => void vi.advanceTimersByTime(1000));
    expect(tipBox()).not.toHaveAttribute("data-open");
  });

  it("shows at once for keyboard focus and Esc hides it", () => {
    mount();
    const btn = screen.getByRole("button", { name: "Open" });
    act(() => btn.focus());
    expect(tipBox()).toHaveAttribute("data-open");
    fireEvent.keyDown(btn, { key: "Escape" });
    expect(tipBox()).not.toHaveAttribute("data-open");
    act(() => btn.blur());
    expect(btn.getAttribute("title")).toMatch(/^117k tokens/);
  });

  it("keeps an icon-only control's name while its title is parked", () => {
    mount();
    const close = screen.getByRole("button", { name: "Close" });
    fireEvent.pointerOver(close);
    expect(close).not.toHaveAttribute("title");
    expect(close).toHaveAttribute("aria-label", "Close");
    fireEvent.pointerOut(close, { relatedTarget: document.body });
    expect(close).toHaveAttribute("title", "Close");
    expect(close).not.toHaveAttribute("aria-label");
  });

  it("moves between neighbours without the pause, and reads titles added later", () => {
    mount();
    const a = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerOver(a);
    act(() => void vi.advanceTimersByTime(500));
    fireEvent.pointerOut(a, { relatedTarget: document.body });
    const late = document.createElement("div");
    late.setAttribute("title", "Added later");
    late.textContent = "late";
    document.body.appendChild(late);
    fireEvent.pointerOver(late);
    expect(tipBox()).toHaveAttribute("data-open");
    expect(tipBox().querySelector(".tt-head")).toHaveTextContent("Added later");
    late.remove();
  });

  it("works from data-tip alone and leaves it as it was", () => {
    mount();
    const own = screen.getByText("plain");
    fireEvent.pointerOver(own);
    act(() => void vi.advanceTimersByTime(500));
    expect(tipBox().querySelector(".tt-head")).toHaveTextContent("Own tip");
    fireEvent.pointerOut(own, { relatedTarget: document.body });
    expect(own).toHaveAttribute("data-tip", "Own tip");
    expect(own).not.toHaveAttribute("title");
  });

  it("takes a title back that the page re-sets while hovered", async () => {
    mount();
    const btn = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerOver(btn);
    act(() => void vi.advanceTimersByTime(500));
    btn.setAttribute("title", "118k tokens");
    await act(async () => {
      await Promise.resolve();
    });
    expect(btn).not.toHaveAttribute("title");
    expect(tipBox().querySelector(".tt-head")).toHaveTextContent("118k tokens");
  });

  it("is in the document once, and gives titles back when it unmounts", () => {
    const { unmount } = mount();
    const btn = screen.getByRole("button", { name: "Open" });
    fireEvent.pointerOver(btn);
    expect(document.querySelectorAll("#atlas-tip")).toHaveLength(1);
    unmount();
    expect(document.getElementById("atlas-tip")).toBeNull();
  });
});
