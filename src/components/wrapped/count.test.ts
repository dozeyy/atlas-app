import { describe, expect, it } from "vitest";
import { countCells, formatCount, parseCount } from "./count";

describe("parseCount and formatCount", () => {
  it("reads compact figures, commas and decimals, and nothing else", () => {
    expect(parseCount("851M")).toEqual({
      n: 851,
      decimals: 0,
      commas: false,
      suffix: "M",
    });
    expect(parseCount("12.3k")).toEqual({
      n: 12.3,
      decimals: 1,
      commas: false,
      suffix: "k",
    });
    expect(parseCount("1,234")).toEqual({
      n: 1234,
      decimals: 0,
      commas: true,
      suffix: "",
    });
    for (const s of ["Jul 26", "10 d 15 h", "Tuesday", "0", "", "9 pm"])
      expect(parseCount(s)).toBeNull();
    for (const s of ["2026", "1999", "2099"])
      expect(parseCount(s), s).toBeNull();
    expect(parseCount("2,026")).not.toBeNull();
    expect(parseCount("2026k")).not.toBeNull();
    expect(parseCount("2300")).not.toBeNull();
  });
  it("formats every step like the final figure", () => {
    const p = parseCount("12.3k")!;
    expect(formatCount(0, p)).toBe("0.0k");
    expect(formatCount(6.149, p)).toBe("6.1k");
    expect(formatCount(1234, parseCount("1,234")!)).toBe("1,234");
  });
});

describe("countCells", () => {
  it("is the final text, cell for cell, at the end", () => {
    expect(countCells("851M", 1)).toEqual(["8", "5", "1", "M"]);
    expect(countCells("Tuesday", 0.2)).toEqual(Array.from("Tuesday"));
  });
  it("keeps the suffix and the last digits in place while the leading digits fill in", () => {
    const mid = countCells("851M", 0.2);
    expect(mid).toHaveLength(4);
    expect(mid[3]).toBe("M");
    expect(mid.join("")).toMatch(/^\s*\d+M$/);
    expect(countCells("851M", 0)).toEqual(["", "", "0", "M"]);
  });
  it("always has as many cells as the final text and never shows more than the final", () => {
    for (const text of ["851M", "1,234", "12.3k", "73"]) {
      for (let k = 0; k <= 1; k += 0.05) {
        const c = countCells(text, k);
        expect(c).toHaveLength(Array.from(text).length);
        expect(c.join("").length).toBeLessThanOrEqual(text.length);
      }
    }
  });
});
