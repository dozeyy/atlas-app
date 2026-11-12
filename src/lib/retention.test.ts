import { describe, expect, it } from "vitest";
import { KEEP_PICKS, keepChoice, keepToast } from "./retention";

describe("keepChoice", () => {
  it("never offers 0 or anything below a day", () => {
    expect(KEEP_PICKS.every((p) => p.days >= 1)).toBe(true);
    expect(KEEP_PICKS.map((p) => p.days)).toEqual([30, 365, 3650]);
  });
  it("a missing key is the default 30 days", () => {
    const c = keepChoice(null, false);
    expect(c.value).toBe("30");
    expect(c.label).toBe("30 days");
    expect(c.options).toHaveLength(3);
  });
  it("picks map to their own label", () => {
    expect(keepChoice(365, false).label).toBe("1 year");
    expect(keepChoice(3650, false).label).toBe("Forever");
  });
  it("a custom value gets its own option, in order, and is the selected one", () => {
    const c = keepChoice(90, false);
    expect(c.value).toBe("90");
    expect(c.options.map((o) => o.label)).toEqual(["30 days", "90 days", "1 year", "Forever"]);
    expect(keepChoice(1, false).label).toBe("1 day");
  });
  it("a value Claude Code rejects selects nothing", () => {
    expect(keepChoice(0, true).value).toBe("");
    expect(keepChoice(null, true).options).toHaveLength(3);
  });
});

describe("keepChoice when the file can't be read", () => {
  it("says Unknown and selects nothing", () => {
    const c = keepChoice(null, false, true);
    expect(c.label).toBe("Unknown");
    expect(c.value).toBe("");
  });
});

describe("keepToast", () => {
  it("says what Claude Code will do", () => {
    expect(keepToast(3650)).toMatch(/forever/);
    expect(keepToast(365)).toMatch(/a year/);
    expect(keepToast(30)).toMatch(/30 days/);
  });
});
