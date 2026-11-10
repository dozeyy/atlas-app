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

/**
 * Model ids grouped under the name people see. Several ids can share one name (a dated id and the
 * plain one, a provider's wrapped id, a context suffix), and a list that shows the name must not
 * show it twice: each name comes back once, in the order it first appeared, with every id behind it.
 */
export function modelChoices(ids: string[]): { label: string; models: string[] }[] {
  const byName = new Map<string, string[]>();
  for (const id of ids) {
    const name = modelLabel(id);
    const list = byName.get(name);
    if (!list) byName.set(name, [id]);
    else if (!list.includes(id)) list.push(id);
  }
  return [...byName].map(([label, models]) => ({ label, models }));
}

export interface ModelRow {
  model: string;
  tokens: Tokens;
  cost: Cost;
  known?: boolean;
  efforts?: EffortUse[];
}

/**
 * Usage rows with one row per model NAME: rows whose ids read as the same model are added
 * together (tokens, cost, effort replies), so a table never has two "Sonnet 4.5" lines. `models`
 * keeps every id that went in; the row is priced only when every part of it was.
 */
export function mergeModelRows(rows: ModelRow[]): (Required<Pick<ModelRow, "model" | "tokens" | "cost" | "known" | "efforts">> & { label: string; models: string[] })[] {
  const priced = (r: ModelRow) => (r.known === undefined ? r.cost.usd !== null : r.known);
  return modelChoices(rows.map((r) => r.model)).map(({ label, models }) => {
    const parts = rows.filter((r) => modelLabel(r.model) === label);
    const tokens = { ...parts[0].tokens };
    for (const p of parts.slice(1)) for (const k of Object.keys(tokens) as (keyof Tokens)[]) tokens[k] += p.tokens[k];
    const anyUsd = parts.some((p) => p.cost.usd !== null);
    const efforts = new Map<string, number>();
    for (const p of parts) for (const e of p.efforts ?? []) efforts.set(e.effort, (efforts.get(e.effort) ?? 0) + e.replies);
    return {
      model: models[0],
      label,
      models,
      tokens,
      cost: {
        usd: anyUsd ? parts.reduce((a, p) => a + (p.cost.usd ?? 0), 0) : null,
        complete: parts.every((p) => p.cost.complete),
        unpricedTokens: parts.reduce((a, p) => a + p.cost.unpricedTokens, 0),
      },
      known: parts.every(priced),
      efforts: [...efforts].map(([effort, replies]) => ({ effort, replies })).sort((a, b) => b.replies - a.replies),
    };
  });
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

// ---- the time of day and the day, said one way on every page --------------------

const clocks = new Map<string, boolean>();

/**
 * Does this computer show the time on a 24 hour clock? Asked of the system's own formatter once
 * (1 pm reads "13" or it does not; nothing is forced either way). A test passes a locale.
 */
export function uses24Hour(locale?: string): boolean {
  const key = locale ?? "";
  let v = clocks.get(key);
  if (v === undefined) {
    try {
      v = new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", numberingSystem: "latn" }).format(new Date(2020, 0, 1, 13, 0)).includes("13");
    } catch {
      v = false;
    }
    clocks.set(key, v);
  }
  return v;
}

/**
 * The time of day, the one way the app writes it: "4:42 PM" where the computer uses a 12 hour
 * clock, "16:42" where it uses 24. Every clock time on every page comes from here (a running
 * clock, "2:06", is a length of time and is `clock` in nowFormat).
 */
export function clockTime(ms: number, opts: { seconds?: boolean; locale?: string } = {}): string {
  const d = new Date(ms);
  const h = d.getHours();
  const tail = `:${pad(d.getMinutes())}${opts.seconds ? `:${pad(d.getSeconds())}` : ""}`;
  return uses24Hour(opts.locale) ? `${pad(h)}${tail}` : `${h % 12 || 12}${tail} ${h < 12 ? "AM" : "PM"}`;
}

/** An hour of the day on its own, on a chart's axis or as a figure: "2 PM" or "14:00". */
export function hourName(hour: number, locale?: string): string {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  return uses24Hour(locale) ? `${pad(h)}:00` : `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 3", with the year when it is not this one ("Nov 3, 2025"). */
export function shortDate(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base}, ${d.getFullYear()}`;
}

/**
 * The day, the one way the app says it: "Today", "Yesterday", then the date ("Nov 3"). A heading
 * that stands over a day's rows asks for `weekdays`: the rest of the week is then "Wednesday".
 */
export function dayWord(ms: number, now = Date.now(), weekdays = false): string {
  const d = new Date(ms);
  const day = localDay(d);
  const today = localDay(new Date(now));
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  if (weekdays && day < today && day >= addDays(today, -6)) return WEEKDAYS[d.getDay()];
  return shortDate(ms, now);
}

/** Short axis label for a bucket start. */
export function axisLabel(start: string, bucket: Bucket, locale?: string): string {
  if (bucket === "hour") return hourName(Number(start.slice(11, 13)), locale);
  const d = parseDay(start.slice(0, 10));
  if (bucket === "month") return d.toLocaleDateString(EN, { month: "short", year: "2-digit" });
  return d.toLocaleDateString(EN, { month: "short", day: "numeric" });
}

/** Full tooltip heading for a bucket start. */
export function bucketTitle(start: string, bucket: Bucket, locale?: string): string {
  if (bucket === "hour") {
    const h = Number(start.slice(11, 13));
    return `${parseDay(start.slice(0, 10)).toLocaleDateString(EN, { month: "short", day: "numeric" })}, ${hourName(h, locale)} to ${hourName(h + 1, locale)}`;
  }
  const d = parseDay(start.slice(0, 10));
  if (bucket === "week") return `Week of ${d.toLocaleDateString(EN, { month: "short", day: "numeric" })}`;
  if (bucket === "month") return d.toLocaleDateString(EN, { month: "long", year: "numeric" });
  return d.toLocaleDateString(EN, { weekday: "short", month: "short", day: "numeric" });
}

/** The local day and time of a message, a run or a change: "Today, 4:42 PM", "Nov 8, 14:05". */
export function formatWhen(ms: number, now = Date.now(), locale?: string): string {
  return `${dayWord(ms, now)}, ${clockTime(ms, { locale })}`;
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
