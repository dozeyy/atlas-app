// Pure helpers for showing usage: numbers, money, time, ranges. No React here.

import type { Bucket, Cost, Tokens } from "./types";
import type { EffortUse } from "./usageTypes";

const EN = "en-US";

/**
 * 1234 -> "1.2k", 12_345 -> "12k", 289_400_000 -> "289M". Three digits or fewer before the unit
 * (Will, 2026-11-08): one decimal below 10, none above, and a roll-up to the next unit before a
 * fourth digit shows ("999.6" -> "1k", "999.9k" -> "1M"). Whole numbers under 1000.
 */
export function compact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 999.5) return String(Math.round(n));
  const units: [number, string][] = [
    [1e3, "k"],
    [1e6, "M"],
    [1e9, "B"],
    [1e12, "T"],
    [1e15, "P"],
  ];
  let i = 0;
  while (i < units.length - 1 && n >= units[i + 1][0]) i++;
  for (;;) {
    const v = n / units[i][0];
    const rounded = v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
    // 999.9k rounds to 1000k: that is "1M".
    if (rounded >= 1000 && i < units.length - 1) {
      i++;
      continue;
    }
    return `${String(rounded)}${units[i][1]}`;
  }
}

export function exact(n: number): string {
  return Math.round(n).toLocaleString(EN);
}

/** Money for people: cents under $100, whole dollars above, "<$0.01" for crumbs. */
export function formatUsd(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.005) return "<$0.01";
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString(EN)}`;
}

export interface CostView {
  text: string;
  /** Some tokens had no price: the figure is a floor. */
  partial: boolean;
  /** Nothing could be priced. */
  none: boolean;
}

export function costView(c: Cost): CostView {
  if (c.usd === null) return { text: "No price", partial: false, none: true };
  const base = formatUsd(c.usd);
  return { text: c.complete ? base : `${base}+`, partial: !c.complete, none: false };
}

/**
 * The hover for a token figure (Will, 2026-11-08: tokens are what shows, the API-price dollar
 * estimate lives here). Two lines: the exact count, then the estimate, always called one.
 */
export function tokenHint(tokens: number, c: Cost): string {
  const lead = `${exact(tokens)} tokens`;
  if (c.usd === null) return tokens > 0 ? `${lead}\nNo API price for these models, so no estimate.` : lead;
  const v = costView(c);
  return c.complete
    ? `${lead}\nAbout ${v.text} at API prices. An estimate, not a bill.`
    : `${lead}\nAbout ${v.text} at API prices. Some usage has no price, so the real figure is higher.`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

/**
 * A model id as people say it, always with its full version: "claude-opus-5-5" -> "Opus 5.5",
 * "claude-fable-5-2" -> "Fable 5.2", "claude-3-5-sonnet-20241022" -> "Sonnet 3.5". Any family
 * works, so a model Atlas has never heard of still gets a name ("claude-nova-9-1" -> "Nova 9.1");
 * whether it is priced is a separate question. A cloud provider wraps the id in its own prefix
 * and suffix ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5@20250929"): the
 * model inside is named, on every page, so a raw id is never the name. Anything with no model in
 * it (`<synthetic>`) stays as it is. The plain ids follow the same rules as `model_label` in
 * `crates/core/src/usage/naming.rs`; the provider ids are named here only.
 */
export function modelLabel(raw: string): string {
  // A context suffix ("claude-opus-5-5[1m]") is the same model.
  const id = raw.trim().replace(/(.)\s*\[[^\]]*\]$/, "$1");
  const plain = plainModelLabel(id);
  if (plain) return plain;
  const inner = /claude-(?:[a-z]+-\d{1,3}(?:-\d{1,2}(?!\d))?|\d{1,3}(?:-\d{1,2}(?!\d))?-[a-z]+)(?:-\d{8})?/.exec(id);
  return (inner && plainModelLabel(inner[0])) || raw;
}

/** "claude-<family>-<version>" or "claude-<version>-<family>", with or without a date; else null. */
function plainModelLabel(id: string): string | null {
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  let m = /^claude-([a-z]+)-(\d{1,3})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  m = /^claude-(\d{1,3})(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?$/.exec(id);
  if (m) return `${cap(m[3])} ${m[1]}${m[2] ? `.${m[2]}` : ""}`;
  return null;
}

/** The most used reasoning effort, or null when no reply recorded one (never a guess). */
export function topEffort(efforts: EffortUse[] | null | undefined): string | null {
  return efforts && efforts.length > 0 ? efforts[0].effort : null;
}

/**
 * The effort mix in words: one effort is its name ("high"); a mix is each effort's share of the
 * replies that had one, most used first ("high 93%, medium 7%"). "" when none was recorded.
 */
export function effortMix(efforts: EffortUse[] | null | undefined): string {
  if (!efforts || efforts.length === 0) return "";
  if (efforts.length === 1) return efforts[0].effort;
  const total = efforts.reduce((a, e) => a + e.replies, 0) || 1;
  return efforts
    .map((e) => {
      const p = (e.replies * 100) / total;
      return `${e.effort} ${percent(p / 100)}`;
    })
    .join(", ");
}

/** "Opus 5.5 \u00b7 high", or just "Opus 5.5" when the effort is unknown. */
export function modelWithEffort(model: string, effort: string | null | undefined): string {
  const name = modelLabel(model);
  return effort ? `${name} \u00b7 ${effort}` : name;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${exact(n)} ${n === 1 ? one : many}`;
}

// ---- days and ranges ---------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** The user's local calendar day as YYYY-MM-DD. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDay(day: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12); // noon: DST never moves the date
}

export function addDays(day: string, n: number): string {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return localDay(d);
}

export type RangeKind = "today" | "30d" | "12w";

export const RANGES: { value: RangeKind; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "30d", label: "30 days" },
  { value: "12w", label: "12 weeks" },
];

export function rangeFor(kind: RangeKind, today: string): { from: string; to: string; bucket: Bucket } {
  switch (kind) {
    case "today":
      return { from: today, to: today, bucket: "hour" };
    case "12w":
      return { from: addDays(today, -83), to: today, bucket: "week" };
    default:
      return { from: addDays(today, -29), to: today, bucket: "day" };
  }
}

/** Short axis label for a bucket start. */
export function axisLabel(start: string, bucket: Bucket): string {
  if (bucket === "hour") return `${start.slice(11, 13)}:00`;
  const d = parseDay(start.slice(0, 10));
  if (bucket === "month") return d.toLocaleDateString(EN, { month: "short", year: "2-digit" });
  return d.toLocaleDateString(EN, { month: "short", day: "numeric" });
}

/** Full tooltip heading for a bucket start. */
export function bucketTitle(start: string, bucket: Bucket): string {
  if (bucket === "hour") {
    const h = Number(start.slice(11, 13));
    return `${parseDay(start.slice(0, 10)).toLocaleDateString(EN, { month: "short", day: "numeric" })}, ${pad(h)}:00-${pad((h + 1) % 24)}:00`;
  }
  const d = parseDay(start.slice(0, 10));
  if (bucket === "week") return `Week of ${d.toLocaleDateString(EN, { month: "short", day: "numeric" })}`;
  if (bucket === "month") return d.toLocaleDateString(EN, { month: "long", year: "numeric" });
  return d.toLocaleDateString(EN, { weekday: "short", month: "short", day: "numeric" });
}

/** Local date and time of a message or session start, "Nov 8, 14:05". */
export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (localDay(d) === localDay(new Date(now))) return `Today, ${time}`;
  if (localDay(d) === addDays(localDay(new Date(now)), -1)) return `Yesterday, ${time}`;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = d.toLocaleDateString(EN, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
  return `${date}, ${time}`;
}

// ---- charts ------------------------------------------------------------------

/** A round axis maximum at or above `v`: 1, 2, 2.5, 5 or 10 times a power of ten. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const step of [1, 2, 2.5, 5, 10]) {
    if (v <= step * base + 1e-12) return step * base;
  }
  return 10 * base;
}

/** Total of the four token kinds the headline counts (Q2), cache reads apart. */
export function headline(t: Tokens): number {
  return t.input + t.output + t.cacheWrite5m + t.cacheWrite1h;
}

export function share(part: number, whole: number): number {
  return whole > 0 ? part / whole : 0;
}

/** A share as people read it: a part that is there is never "0%", a part that is not the whole never "100%". */
export function percent(frac: number): string {
  if (frac <= 0) return "0%";
  if (frac < 0.01) return "<1%";
  if (frac > 0.99 && frac < 1) return ">99%";
  return `${Math.round(frac * 100)}%`;
}

/** Split an ordered list into at most `n` runs of nearly equal length. */
export function binEvenly<T>(items: T[], n: number): T[][] {
  if (items.length <= n) return items.map((i) => [i]);
  const out: T[][] = [];
  const size = items.length / n;
  for (let i = 0; i < n; i++) {
    out.push(items.slice(Math.round(i * size), Math.round((i + 1) * size)));
  }
  return out.filter((b) => b.length > 0);
}
