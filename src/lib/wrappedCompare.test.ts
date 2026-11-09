import { describe, expect, it } from "vitest";
import { compare, compareTokens, countText, LADDERS, MAX_LINE, MIN_SHARE, ONE_BELOW, pickRung, WORDS_PER_TOKEN } from "./wrappedCompare";
import type { LadderId } from "./wrappedCompare";

const ids = Object.keys(LADDERS) as LadderId[];

describe("the ladders", () => {
  it("each have 3 to 8 rungs, ascending, with a source fact apiece", () => {
    for (const id of ids) {
      const { rungs } = LADDERS[id];
      expect(rungs.length, id).toBeGreaterThanOrEqual(3);
      expect(rungs.length, id).toBeLessThanOrEqual(8);
      for (let i = 1; i < rungs.length; i++) expect(rungs[i].size, id).toBeGreaterThan(rungs[i - 1].size);
      for (const r of rungs) {
        expect(r.fact.length, `${id} ${r.one}`).toBeGreaterThan(10);
        expect(`${r.one} ${r.many} ${r.fact}`, id).toMatch(/^[\x20-\x7e]+$/);
        expect(r.size, id).toBeGreaterThan(0);
      }
    }
  });
});

describe("the Wrapped sources", () => {
  it("hold only ASCII, so no curly quote or dash can reach a slide", () => {
    const files = import.meta.glob(["./wrapped*.ts", "../components/wrapped/*.tsx", "../pages/Wrapped.tsx"], { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(5);
    for (const [name, text] of Object.entries(files)) {
      if (/\.test\./.test(name)) continue;
      // eslint-disable-next-line no-control-regex
      expect(text, name).toMatch(/^[\x00-\x7f]*$/);
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
    expect(pickRung(LADDERS.count, Number.MAX_VALUE)?.rung.size).toBe(100_000);
  });

  it("takes each call's own minimum share: 1 reaches only whole rungs", () => {
    const crew = LADDERS.crew;
    // 10 helpers is 0.91 of a soccer team: close enough for "about", not for "at least".
    expect(pickRung(crew, 10)?.rung.size).toBe(11);
    expect(pickRung(crew, 10, 1)?.rung.size).toBe(5);
    expect(pickRung(crew, 11, 1)?.rung.size).toBe(11);
    expect(pickRung(crew, 11 - 1e-6, 1)?.rung.size).toBe(5);
    // Under the smallest whole rung there is nothing at all.
    expect(pickRung(crew, 4.99, 1)).toBeNull();
    expect(pickRung(crew, 4.6)?.rung.size).toBe(5);
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

  it("rounds toward zero for an 'at least' line, so it never shows more than there is", () => {
    expect(countText(1.96)).toBe("2");
    expect(countText(1.96, true)).toBe("1.9");
    expect(countText(1.94, true)).toBe("1.9");
    expect(countText(2, true)).toBe("2");
    expect(countText(3, true)).toBe("3");
    expect(countText(19.9, true)).toBe("19");
    expect(countText(1999, true)).toBe("1.9k");
    expect(countText(361.5, true)).toBe("360");
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
    expect(compare("days", 600, { lead: "That was about" })?.text).toBe("That was about 1.5 Empire State builds.");
    expect(compare("days", 600, { lead: "That was about", tail: " ago" })?.text).toBe("That was about 1.5 Empire State builds ago.");
  });

  it("uses ONE_BELOW as the line between 'one' and a count", () => {
    const at = (k: number) => compare("hours", 40 * k, { lead: "About" })?.text;
    expect(at(1)).toBe("About one full-time work week.");
    expect(at(ONE_BELOW - 0.01)).toBe("About one full-time work week.");
    expect(at(ONE_BELOW + 0.01)).toBe("About 1.2 full-time work weeks.");
  });

  it("keeps 'at least' and 'fill' leads literally true", () => {
    const fill = (n: number) => compare("crew", n, { lead: "Enough helpers to fill", atLeast: true })?.text;
    // 10 helpers do not fill a team of 11; 95 do not make a Senate of 100.
    expect(fill(10)).toBe("Enough helpers to fill 2 basketball teams.");
    expect(fill(11)).toBe("Enough helpers to fill one soccer team.");
    expect(fill(95)).toBe("Enough helpers to fill 1.7 NFL rosters.");
    expect(fill(99.9)).not.toContain("Senate");
    expect(fill(100)).toBe("Enough helpers to fill the whole US Senate.");
    expect(fill(4)).toBeUndefined();
    // Without the flag the same 10 may still read as "about one soccer team".
    expect(compare("crew", 10, { lead: "About" })?.text).toBe("About one soccer team.");
    // 6.4 hours is not a whole New York to London flight.
    const t = compare("hours", 6.4, { lead: "At least", atLeast: true })!;
    expect(t.text).toBe("At least 4.2 soccer matches.");
    expect(t.hint).toContain("= at least 4.2.");
    expect(compare("hours", 7, { lead: "At least", atLeast: true })?.text).toBe("At least one flight to London.");
  });

  it("always fits one line: a long lead gives way to the short one, and a line that still does not fit is dropped", () => {
    const longLead = "Your skill uses add up to a number that is about";
    for (const id of ids) {
      for (const r of LADDERS[id].rungs) {
        for (const k of [1, 1.3, 2.4, 37, 1234]) {
          const c = compare(id, r.size * k, { lead: longLead });
          if (c) expect(c.text.length, c.text).toBeLessThanOrEqual(MAX_LINE);
          const f = compare(id, r.size * k, { lead: longLead, atLeast: true });
          if (f) expect(f.text.length, f.text).toBeLessThanOrEqual(MAX_LINE);
        }
      }
    }
    const c = compare("days", 600, { lead: "Your active days add up to about" })!;
    expect(c.text).toBe("About 1.5 Empire State builds.");
    // A floor keeps saying it is a floor.
    expect(compare("hours", 8, { lead: "Your long chats alone run at least, honestly", atLeast: true })?.text).toBe("At least one flight to London.");
  });

  it("has a rung for a small count, so a few uses still get a line", () => {
    expect(compare("count", 12, { lead: "That is about" })?.text).toBe("That is about one dozen doughnuts.");
    expect(compare("count", 6, { lead: "That is about" })).toBeNull();
  });

  it("never says a use a day, or any unit that does not read as a sentence", () => {
    for (const r of LADDERS.count.rungs) {
      expect(r.one + r.many).not.toMatch(/a use a|use an hour|of a use/);
    }
    expect(compare("count", 24, { lead: "That is about" })?.text).toBe("That is about 2 dozen doughnuts.");
  });

  it("uses each comparison once per Wrapped: a rung already spoken for is skipped", () => {
    const used = new Set<string>();
    const first = compare("words", 1_000_000, { lead: "About" }, used);
    expect(first).not.toBeNull();
    expect(used.size).toBe(1);
    const again = compare("words", 1_000_000, { lead: "About" }, used);
    // The same amount falls to a different rung, or to nothing, but never the same line.
    expect(again?.text).not.toBe(first?.text);
    const spoken = [...used];
    expect(new Set(spoken).size).toBe(spoken.length);
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
