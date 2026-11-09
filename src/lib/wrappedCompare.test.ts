import { describe, expect, it } from "vitest";
import { compare, compareTokens, countText, LADDERS, MIN_SHARE, ONE_BELOW, pickRung, WORDS_PER_TOKEN } from "./wrappedCompare";
import type { LadderId } from "./wrappedCompare";

const ids = Object.keys(LADDERS) as LadderId[];

describe("the ladders", () => {
  it("each have 3 to 6 rungs, ascending, with a source fact apiece", () => {
    for (const id of ids) {
      const { rungs } = LADDERS[id];
      expect(rungs.length, id).toBeGreaterThanOrEqual(3);
      expect(rungs.length, id).toBeLessThanOrEqual(6);
      for (let i = 1; i < rungs.length; i++) expect(rungs[i].size, id).toBeGreaterThan(rungs[i - 1].size);
      for (const r of rungs) {
        expect(r.fact.length, `${id} ${r.one}`).toBeGreaterThan(10);
        expect(`${r.one} ${r.many} ${r.fact}`, id).toMatch(/^[\x20-\x7e]+$/);
        expect(r.size, id).toBeGreaterThan(0);
      }
    }
  });
});

describe("pickRung", () => {
  const days = LADDERS.days;

  it("takes the rung the amount is closest to", () => {
    expect(pickRung(days, 8)?.rung.size).toBe(8);
    expect(pickRung(days, 30)?.rung.size).toBe(29.5);
    // 80 is 0.91 of 88 and 2.7 times 29.5: the nearer one, 88, wins.
    expect(pickRung(days, 80)?.rung.size).toBe(88);
    // 70 days is 2.4 times a lunar month and 0.8 of Mercury's year: Mercury is out of reach (under 0.9).
    expect(pickRung(days, 70)?.rung.size).toBe(29.5);
    expect(pickRung(days, 70)?.ratio).toBeCloseTo(70 / 29.5, 5);
  });

  it("never rounds a rung up: under 90 percent of it does not count as that rung", () => {
    expect(pickRung(days, 88 * (MIN_SHARE - 0.01))?.rung.size).toBe(29.5);
    expect(pickRung(days, 88 * MIN_SHARE + 0.001)?.rung.size).toBe(88);
  });

  it("is null for zero, negative and not-a-number amounts", () => {
    expect(pickRung(days, 0)).toBeNull();
    expect(pickRung(days, -5)).toBeNull();
    expect(pickRung(days, Number.NaN)).toBeNull();
    expect(pickRung(days, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("is null under the smallest rung, not a stretch", () => {
    expect(pickRung(days, 7)).toBeNull();
    expect(pickRung(days, 8 * MIN_SHARE - 0.001)).toBeNull();
  });

  it("settles on the biggest rung for a huge amount, with the real ratio", () => {
    const hit = pickRung(LADDERS.words, 1e15)!;
    expect(hit.rung.size).toBe(4_000_000_000);
    expect(hit.ratio).toBeCloseTo(1e15 / 4e9, 3);
    expect(pickRung(LADDERS.count, Number.MAX_VALUE)?.rung.size).toBe(2_500_000);
  });

  it("reaches only the rungs the amount is near, on a two-rung ladder", () => {
    const l = { unit: "x", rungs: [{ size: 1, one: "a", many: "as", fact: "fact a one" }, { size: 4, one: "b", many: "bs", fact: "fact b four" }] };
    // 2 is twice 1 and half of 4: but 2 is under 0.9 of 4, so only the first counts.
    expect(pickRung(l, 2)?.rung.size).toBe(1);
    // 4 is exactly the second rung.
    expect(pickRung(l, 4)?.rung.size).toBe(4);
  });
});

describe("countText", () => {
  it("keeps one decimal under ten and two significant digits above", () => {
    expect(countText(1.2)).toBe("1.2");
    expect(countText(2)).toBe("2");
    expect(countText(9.96)).toBe("10");
    expect(countText(16.4)).toBe("16");
    expect(countText(361.5)).toBe("360");
    expect(countText(12_345)).toBe("12k");
  });
});

describe("compare", () => {
  it("does the math from the real number and shows it in the hint", () => {
    // 36.2M words is 33 times the 1.08M-word Harry Potter series and 0.9 of Britannica's 40M.
    const c = compare("words", 36_200_000, { lead: "About" });
    expect(c).not.toBeNull();
    // The log-nearest of the rungs it reaches is Britannica.
    expect(c!.text).toBe("About one Encyclopaedia Britannica.");
    expect(c!.hint).toContain("32-volume Encyclopaedia Britannica is about 40M words");
    expect(c!.hint).toContain("36M words / 40M = about 1.");
    expect(c!.hint).toContain(`${WORDS_PER_TOKEN} words per token`);
  });

  it("says a count when the amount is well past one", () => {
    // 80 days against Mercury's 88-day year is just under one; 600 days is 1.5 Empire State builds.
    expect(compare("days", 80, { lead: "That was about" })?.text).toBe("That was about one year on Mercury.");
    expect(compare("days", 600, { lead: "That was about" })?.text).toBe("That was about 1.5 times the Empire State Building's build time.");
    expect(compare("days", 600, { lead: "That was about", tail: " ago" })?.text).toBe("That was about 1.5 times the Empire State Building's build time ago.");
  });

  it("uses ONE_BELOW as the line between 'one' and a count", () => {
    const at = (k: number) => compare("hours", 40 * k, { lead: "About" })?.text;
    expect(at(1)).toBe("About one full-time work week.");
    expect(at(ONE_BELOW - 0.01)).toBe("About one full-time work week.");
    expect(at(ONE_BELOW + 0.01)).toBe("About 1.2 full-time work weeks.");
  });

  it("is null when there is nothing true to say", () => {
    expect(compare("words", 0, { lead: "About" })).toBeNull();
    expect(compare("days", 1, { lead: "About" })).toBeNull();
    expect(compare("crew", 3, { lead: "About" })).toBeNull();
  });

  it("converts tokens to words before comparing", () => {
    // 1,000 tokens is 750 words: 2.8 Gettysburg Addresses (272 words).
    expect(compareTokens(1000, { lead: "About" })?.text).toBe("About 2.8 Gettysburg Addresses.");
    expect(compareTokens(0, { lead: "About" })).toBeNull();
    // 100 tokens is 75 words, under the smallest rung.
    expect(compareTokens(100, { lead: "About" })).toBeNull();
  });

  it("stays one ASCII sentence for every rung of every ladder", () => {
    for (const id of ids) {
      for (const r of LADDERS[id].rungs) {
        for (const k of [1, 2.4, 37, 1234]) {
          const c = compare(id, r.size * k, { lead: "About" })!;
          expect(c.text, `${id} ${r.one} x${k}`).toMatch(/^About [\x20-\x7e]+\.$/);
          expect(c.text, c.text).not.toMatch(/\.\s/);
          expect(c.hint).not.toContain("$");
        }
      }
    }
  });
});
