import { describe, expect, it } from "vitest";
import { DEFAULT_ZOOM, ZOOM_LEVELS, applyDisplay, snapZoom, stepZoom, zoomKeyAction } from "./zoom";

const key = (o: Partial<Parameters<typeof zoomKeyAction>[0]>) => ({ key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, ...o });

describe("stepZoom", () => {
  it("walks the steps and stops at both ends", () => {
    expect(stepZoom(100, "in")).toBe(110);
    expect(stepZoom(100, "out")).toBe(90);
    expect(stepZoom(200, "in")).toBe(200);
    expect(stepZoom(80, "out")).toBe(80);
  });
  it("an off-step value goes to the next step in that direction", () => {
    expect(stepZoom(105, "in")).toBe(110);
    expect(stepZoom(105, "out")).toBe(100);
  });
  it("every step is reachable from 100 both ways", () => {
    let z: number = DEFAULT_ZOOM;
    for (let i = 0; i < 20; i++) z = stepZoom(z, "in");
    expect(z).toBe(ZOOM_LEVELS[ZOOM_LEVELS.length - 1]);
    for (let i = 0; i < 20; i++) z = stepZoom(z, "out");
    expect(z).toBe(ZOOM_LEVELS[0]);
  });
});

describe("snapZoom", () => {
  it("snaps to the nearest step and falls back to 100 for junk", () => {
    expect(snapZoom(127)).toBe(125);
    expect(snapZoom(1000)).toBe(200);
    expect(snapZoom(1)).toBe(80);
    expect(snapZoom(NaN)).toBe(100);
    expect(snapZoom(0)).toBe(100);
    expect(snapZoom(-30)).toBe(100);
  });
});

describe("zoomKeyAction", () => {
  it("Ctrl plus, minus and zero on Windows; Cmd on a Mac", () => {
    expect(zoomKeyAction(key({ key: "=", ctrlKey: true }), "windows")).toBe("in");
    expect(zoomKeyAction(key({ key: "+", ctrlKey: true }), "windows")).toBe("in");
    expect(zoomKeyAction(key({ key: "-", ctrlKey: true }), "windows")).toBe("out");
    expect(zoomKeyAction(key({ key: "0", ctrlKey: true }), "windows")).toBe("reset");
    expect(zoomKeyAction(key({ code: "NumpadAdd", key: "+", ctrlKey: true }), "windows")).toBe("in");
    expect(zoomKeyAction(key({ key: "=", metaKey: true }), "macos")).toBe("in");
    expect(zoomKeyAction(key({ key: "=", ctrlKey: true }), "macos")).toBeNull();
  });
  it("ignores plain keys and Alt combinations", () => {
    expect(zoomKeyAction(key({ key: "=" }), "windows")).toBeNull();
    expect(zoomKeyAction(key({ key: "-", ctrlKey: true, altKey: true }), "windows")).toBeNull();
    expect(zoomKeyAction(key({ key: "b", ctrlKey: true }), "windows")).toBeNull();
  });
});

describe("applyDisplay", () => {
  it("sets data-text for Larger only and --zoom as a fraction", () => {
    const root = document.createElement("html");
    applyDisplay({ textSize: "larger", zoomPercent: 125 }, root);
    expect(root.dataset.text).toBe("larger");
    expect(root.style.getPropertyValue("--zoom")).toBe("1.25");
    applyDisplay({ textSize: "default", zoomPercent: 100 }, root);
    expect(root.dataset.text).toBeUndefined();
    expect(root.style.getPropertyValue("--zoom")).toBe("1");
  });
});
