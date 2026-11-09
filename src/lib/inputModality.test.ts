import { afterEach, describe, expect, it } from "vitest";
import { installInputModality, isWalkKey } from "./inputModality";

describe("input modality", () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    delete document.documentElement.dataset.input;
  });

  it("starts as pointer, so focus handed back by code draws nothing", () => {
    off = installInputModality();
    expect(document.documentElement.dataset.input).toBe("pointer");
  });

  it("Tab and the arrows turn the keyboard ring on, a press turns it off", () => {
    off = installInputModality();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(document.documentElement.dataset.input).toBe("keyboard");
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    expect(document.documentElement.dataset.input).toBe("pointer");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.documentElement.dataset.input).toBe("keyboard");
  });

  it("shortcuts and typing do not count as walking", () => {
    off = installInputModality();
    expect(isWalkKey({ key: "k", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(isWalkKey({ key: "Tab", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(isWalkKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(document.documentElement.dataset.input).toBe("pointer");
  });
});
