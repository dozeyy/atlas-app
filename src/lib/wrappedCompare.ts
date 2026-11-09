// The fun line under a Wrapped slide's big number: "About 16 Encyclopaedia Britannicas." Each
// metric has a short ladder of well-known things, small to huge; the picker takes the rung the
// real number is closest to (never below 90% of a rung), and the math is done here from the real
// number. Nothing is invented: every rung's source fact is in its `fact` line (also the hover).
// If a figure is too small for the smallest rung, or zero, there is no comparison, not a stretch.

import { compact } from "./usage";

/** Stated conversion, an estimate: tokens to words. (Also used by the novels slide.) */
export const WORDS_PER_TOKEN = 0.75;

export interface Rung {
  /** The size of one of the thing, in the ladder's unit. */
  size: number;
  /** "one Great Gatsby": used when the number is about one of it. */
  one: string;
  /** "copies of The Great Gatsby": used after a count. */
  many: string;
  /** Where the size comes from, for the hover. */
  fact: string;
}

export interface Ladder {
  /** What `size` is measured in ("words", "days"). */
  unit: string;
  /** Ascending by size. */
  rungs: Rung[];
  /** Said in the hover after the numbers, when the amount itself is an estimate. */
  note?: string;
}

export type LadderId = "words" | "days" | "hours" | "count" | "crew";

export const LADDERS: Record<LadderId, Ladder> = {
  // Book and library sizes, in words. Every size is an "about": editions differ a little.
  words: {
    unit: "words",
    note: "Words are estimated from tokens at 0.75 words per token.",
    rungs: [
      // Lincoln's Gettysburg Address: about 270 words (272 in the Bliss copy).
      { size: 272, one: "one Gettysburg Address", many: "Gettysburg Addresses", fact: "The Gettysburg Address is about 270 words." },
      // The Great Gatsby (Fitzgerald, 1925): about 47,000 words.
      { size: 47_000, one: "one copy of Gatsby", many: "copies of Gatsby", fact: "The Great Gatsby is about 47,000 words." },
      // Moby-Dick (Melville, 1851): roughly 210,000 words, depending on the edition.
      { size: 210_000, one: "one copy of Moby-Dick", many: "copies of Moby-Dick", fact: "Moby-Dick is about 210,000 words." },
      // The seven Harry Potter books together: 1,084,170 words, the figure the publisher and fans quote.
      { size: 1_084_170, one: "one Harry Potter box set", many: "Harry Potter box sets", fact: "All seven Harry Potter books are about 1.08M words." },
      // The 2010 print Encyclopaedia Britannica (32 volumes): about 40 million words.
      { size: 40_000_000, one: "one Encyclopaedia Britannica", many: "Encyclopaedia Britannicas", fact: "The 32-volume Encyclopaedia Britannica is about 40M words." },
      // English Wikipedia: over 4 billion words (a floor; it grows every day).
      { size: 4_000_000_000, one: "one English Wikipedia", many: "English Wikipedias", fact: "English Wikipedia is over 4 billion words." },
    ],
  },
  // Spans of days with a fixed, well-known length.
  days: {
    unit: "days",
    rungs: [
      // Apollo 11, launch to splashdown, 16 to 24 July 1969: 8 days, 3 hours, 18 minutes.
      { size: 8, one: "one Apollo 11 moon trip", many: "Apollo 11 moon trips", fact: "Apollo 11 took 8 days from launch to splashdown." },
      // A lunar month (new moon to new moon): 29.5 days.
      { size: 29.5, one: "one lunar month", many: "lunar months", fact: "A lunar month, new moon to new moon, is 29.5 days." },
      // Mercury goes round the Sun once in 88 Earth days.
      { size: 88, one: "one year on Mercury", many: "years on Mercury", fact: "A year on Mercury is 88 Earth days." },
      // Venus turns once on its axis in 243 Earth days.
      { size: 243, one: "one full spin of Venus", many: "full spins of Venus", fact: "Venus takes 243 Earth days to spin once." },
      // The Empire State Building went up in 410 days (March 1930 to May 1931).
      { size: 410, one: "one Empire State build", many: "Empire State builds", fact: "The Empire State Building took 410 days to build." },
      // The Eiffel Tower took 2 years, 2 months and about 5 days (1887 to 1889): about 790 days.
      { size: 790, one: "one Eiffel Tower build", many: "Eiffel Tower builds", fact: "The Eiffel Tower took about 790 days to build." },
    ],
  },
  hours: {
    unit: "hours",
    rungs: [
      // A soccer match is two 45-minute halves.
      { size: 1.5, one: "one soccer match", many: "soccer matches", fact: "A soccer match is 90 minutes of play." },
      // New York to London is a flight of about 7 hours.
      { size: 7, one: "one flight to London", many: "flights to London", fact: "New York to London is a flight of about 7 hours." },
      // A full-time work week is 40 hours.
      { size: 40, one: "one full-time work week", many: "full-time work weeks", fact: "A full-time work week is 40 hours." },
      // Apollo 11 lasted 195 hours (8 days, 3 hours, 18 minutes).
      { size: 195, one: "one whole Apollo 11 moon trip", many: "Apollo 11 moon trips", fact: "Apollo 11 took about 195 hours." },
      // A full-time work year is 40 hours x 52 weeks = 2,080 hours.
      { size: 2080, one: "one full-time work year", many: "full-time work years", fact: "A full-time work year is 2,080 hours." },
      // A year is 365.25 days x 24 hours = 8,766 hours.
      { size: 8766, one: "one year nonstop", many: "years nonstop", fact: "A year is 8,766 hours." },
    ],
  },
  // How many times something happened, against things that come in a known number.
  count: {
    unit: "uses",
    rungs: [
      { size: 12, one: "one dozen doughnuts", many: "dozen doughnuts", fact: "A dozen is 12." },
      { size: 52, one: "one deck of cards", many: "decks of cards", fact: "A standard deck has 52 cards." },
      { size: 88, one: "one piano keyboard", many: "piano keyboards", fact: "A standard piano has 88 keys." },
      { size: 10_000, one: "one day of 10,000 steps", many: "days of 10,000 steps", fact: "The popular daily goal is 10,000 steps." },
      { size: 100_000, one: "one head of hair", many: "heads of hair", fact: "A human head has about 100,000 hairs." },
    ],
  },
  // A crowd of helpers, against teams and bodies of a known size.
  crew: {
    unit: "helpers",
    rungs: [
      { size: 5, one: "one basketball team", many: "basketball teams", fact: "A basketball team puts 5 players on the court." },
      { size: 11, one: "one soccer team", many: "soccer teams", fact: "A soccer team has 11 players on the pitch." },
      { size: 53, one: "one NFL roster", many: "NFL rosters", fact: "An NFL team's active roster is 53 players." },
      { size: 100, one: "the whole US Senate", many: "US Senates", fact: "The US Senate has 100 members." },
      { size: 435, one: "the whole US House", many: "US Houses", fact: "The US House has 435 voting members." },
    ],
  },
};

/** A rung counts only when the amount is at least this share of it ("nearly one" is fair, "a third" is not). */
export const MIN_SHARE = 0.9;
/** The longest comparison line, in characters: it has to stay on one line at the smallest window. */
export const MAX_LINE = 46;
/** Under this many of a thing it reads as "one of it". */
export const ONE_BELOW = 1.15;

/**
 * The rung the amount is closest to, on a log scale, among the rungs it reaches (at least
 * `minShare` of them, 0.9 by default; 1 for an "at least" line). With the rungs ascending that is
 * the biggest one it reaches. Null when the
 * amount is zero, not a number, or too small for the smallest rung.
 */
export function pickRung(ladder: Ladder, amount: number, minShare = MIN_SHARE): { rung: Rung; ratio: number } | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  let best: { rung: Rung; ratio: number } | null = null;
  let bestGap = Infinity;
  for (const rung of ladder.rungs) {
    const ratio = amount / rung.size;
    if (ratio < minShare) continue;
    const gap = Math.abs(Math.log(ratio));
    if (gap <= bestGap) {
      best = { rung, ratio };
      bestGap = gap;
    }
  }
  return best;
}

/**
 * "2.4", "16", "590", "12k": at most two significant digits, so it reads as an "about". With
 * `down` it rounds toward zero instead, so a line that says "at least" never shows more than there is.
 */
export function countText(ratio: number, down = false): string {
  if (ratio < 10) {
    const r = down ? Math.floor(ratio * 10 + 1e-9) / 10 : Math.round(ratio * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  let two = Number(ratio.toPrecision(2));
  if (down) {
    const unit = 10 ** (Math.floor(Math.log10(ratio)) - 1);
    two = Math.floor(ratio / unit + 1e-9) * unit;
  }
  return two >= 1000 ? compact(two) : String(two);
}

export interface Comparison {
  /** The one line under the number. */
  text: string;
  /** The source fact and the math, for the hover. */
  hint: string;
}

export interface CompareWords {
  /** Starts the sentence: "About", "That one day is about". */
  lead: string;
  /** Ends it, before the full stop: " ago". */
  tail?: string;
  /**
   * The lead says "at least" or "enough to fill": the amount must reach the whole rung (not 90% of
   * it) and the count is rounded down, so the sentence is literally true.
   */
  atLeast?: boolean;
}

/** Build the comparison for an amount in the ladder's own unit; null when none fits. */
export function compare(id: LadderId, amount: number, words: CompareWords, used?: Set<string>): Comparison | null {
  // A thing is compared once per Wrapped: the rungs already spoken for are out of the running.
  const full = LADDERS[id];
  const ladder = used ? { ...full, rungs: full.rungs.filter((r) => !used.has(r.one)) } : full;
  const hit = pickRung(ladder, amount, words.atLeast ? 1 : MIN_SHARE);
  if (!hit) return null;
  const { rung, ratio } = hit;
  const n = countText(ratio, words.atLeast);
  const say = (lead: string, tail: string) => (ratio < ONE_BELOW ? `${lead} ${rung.one}${tail}.` : `${lead} ${n} ${rung.many}${tail}.`);
  // The line must fit on one line of the slide. A long lead gives way to the short one of the same
  // meaning ("About", or "At least" for a floor); if that is still too long there is no line.
  let text = say(words.lead, words.tail ?? "");
  if (text.length > MAX_LINE) text = say(words.atLeast ? "At least" : "About", words.tail ?? "");
  if (text.length > MAX_LINE) return null;
  used?.add(rung.one);
  const math = `${compact(amount)} ${ladder.unit} / ${compact(rung.size)} = ${words.atLeast ? "at least " : ratio < ONE_BELOW ? "about " : ""}${ratio < ONE_BELOW ? "1" : n}.`;
  return { text, hint: [rung.fact, math, ladder.note].filter(Boolean).join(" ") };
}

/** Tokens against the book ladder (tokens become words at the stated estimate). */
export function compareTokens(tokens: number, words: CompareWords, used?: Set<string>): Comparison | null {
  return compare("words", tokens * WORDS_PER_TOKEN, words, used);
}
