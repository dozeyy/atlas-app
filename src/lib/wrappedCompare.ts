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
      { size: 47_000, one: "one copy of The Great Gatsby", many: "copies of The Great Gatsby", fact: "The Great Gatsby is about 47,000 words." },
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
      { size: 410, one: "the Empire State Building's whole build time", many: "times the Empire State Building's build time", fact: "The Empire State Building took 410 days to build." },
      // The Eiffel Tower took 2 years, 2 months and about 5 days (1887 to 1889): about 790 days.
      { size: 790, one: "the Eiffel Tower's whole build time", many: "times the Eiffel Tower's build time", fact: "The Eiffel Tower took about 790 days to build." },
    ],
  },
  hours: {
    unit: "hours",
    rungs: [
      // A soccer match is two 45-minute halves.
      { size: 1.5, one: "one soccer match", many: "soccer matches", fact: "A soccer match is 90 minutes of play." },
      // New York to London is a flight of about 7 hours.
      { size: 7, one: "one flight from New York to London", many: "flights from New York to London", fact: "New York to London is a flight of about 7 hours." },
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
  // How many times something happened, against things that have a known count.
  count: {
    unit: "uses",
    rungs: [
      { size: 52, one: "one deck of cards", many: "decks of cards", fact: "A deck has 52 cards." },
      { size: 88, one: "one piano keyboard", many: "piano keyboards", fact: "A piano has 88 keys." },
      { size: 206, one: "one human skeleton's worth of bones", many: "skeletons' worth of bones", fact: "An adult human has 206 bones." },
      // The Eiffel Tower has 1,665 steps from the ground to the top.
      { size: 1665, one: "one climb of the Eiffel Tower's steps", many: "climbs of the Eiffel Tower's steps", fact: "The Eiffel Tower has 1,665 steps to the top." },
      // Eiffel's own count: 18,038 pieces of wrought iron, held by about 2.5 million rivets.
      { size: 18_038, one: "one Eiffel Tower of iron parts", many: "Eiffel Towers of iron parts", fact: "The Eiffel Tower is 18,038 iron pieces." },
      { size: 2_500_000, one: "one Eiffel Tower of rivets", many: "Eiffel Towers of rivets", fact: "The Eiffel Tower is held by about 2.5 million rivets." },
    ],
  },
  // A crowd of helpers, against teams and bodies of a known size.
  crew: {
    unit: "helpers",
    rungs: [
      { size: 5, one: "one basketball team on the court", many: "basketball teams on the court", fact: "A basketball team puts 5 players on the court." },
      { size: 11, one: "one soccer team", many: "soccer teams", fact: "A soccer team has 11 players on the pitch." },
      { size: 53, one: "one NFL roster", many: "NFL rosters", fact: "An NFL team's active roster is 53 players." },
      { size: 100, one: "the whole US Senate", many: "US Senates", fact: "The US Senate has 100 members." },
      { size: 435, one: "the whole US House of Representatives", many: "US Houses of Representatives", fact: "The US House has 435 voting members." },
    ],
  },
};

/** A rung counts only when the amount is at least this share of it ("nearly one" is fair, "a third" is not). */
export const MIN_SHARE = 0.9;
/** Under this many of a thing it reads as "one of it". */
export const ONE_BELOW = 1.15;

/**
 * The rung the amount is closest to, on a log scale, among the rungs it reaches (at least
 * MIN_SHARE of them). With the rungs ascending that is the biggest one it reaches. Null when the
 * amount is zero, not a number, or too small for the smallest rung.
 */
export function pickRung(ladder: Ladder, amount: number): { rung: Rung; ratio: number } | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  let best: { rung: Rung; ratio: number } | null = null;
  let bestGap = Infinity;
  for (const rung of ladder.rungs) {
    const ratio = amount / rung.size;
    if (ratio < MIN_SHARE) continue;
    const gap = Math.abs(Math.log(ratio));
    if (gap <= bestGap) {
      best = { rung, ratio };
      bestGap = gap;
    }
  }
  return best;
}

/** "2.4", "16", "590", "12k": at most two significant digits, so it reads as an "about". */
export function countText(ratio: number): string {
  if (ratio < 10) {
    const r = Math.round(ratio * 10) / 10;
    return Number.isInteger(r) ? String(r) : r.toFixed(1);
  }
  const two = Number(ratio.toPrecision(2));
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
}

/** Build the comparison for an amount in the ladder's own unit; null when none fits. */
export function compare(id: LadderId, amount: number, words: CompareWords): Comparison | null {
  const ladder = LADDERS[id];
  const hit = pickRung(ladder, amount);
  if (!hit) return null;
  const { rung, ratio } = hit;
  const tail = words.tail ?? "";
  const n = countText(ratio);
  const text = ratio < ONE_BELOW ? `${words.lead} ${rung.one}${tail}.` : `${words.lead} ${n} ${rung.many}${tail}.`;
  const math = `${compact(amount)} ${ladder.unit} / ${compact(rung.size)} = ${ratio < ONE_BELOW ? "about 1" : n}.`;
  return { text, hint: [rung.fact, math, ladder.note].filter(Boolean).join(" ") };
}

/** Tokens against the book ladder (tokens become words at the stated estimate). */
export function compareTokens(tokens: number, words: CompareWords): Comparison | null {
  return compare("words", tokens * WORDS_PER_TOKEN, words);
}
