import { getBackend } from "./ipc";
import { hourTotals } from "./wrappedModel";
import type { WrappedData } from "./wrappedModel";
import { addDays, headline } from "./usage";
import type { Daily } from "./useDaily";
import type { ItemUse, Timeline } from "./usageTypes";

/** The hour-of-day picture only needs recent weeks, and an hourly query is the big one. */
const HOUR_WINDOW_DAYS = 120;

const quiet = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

const WORDS = /[A-Za-z0-9]+/g;

/** Longest hint, in words: it has to fit under a name in a small tile. */
const HINT_WORDS = 2;

/** The words of a folder key, minus the folder's own name at the end; null when the key does not end in it. */
function parentWords(key: string, label: string): string[] | null {
  const own = (label.match(WORDS) ?? []).map((w) => w.toLowerCase());
  const words = key.match(WORDS) ?? [];
  if (own.length === 0 || words.length <= own.length) return null;
  const tail = words.slice(words.length - own.length);
  return tail.every((w, i) => w.toLowerCase() === own[i]) ? words.slice(0, words.length - own.length) : null;
}

/**
 * Two projects can share a folder name (the same name under two parents). A legend that says
 * "Origin Client" twice cannot be read, so a colliding row gets a `hint`: the words of its folder
 * path that set it apart (the key is the project's path with every symbol turned into a dash). Only
 * the words that differ count: what every colliding path shares at the start or the end is left out.
 * `label` becomes "Name (hint)"; `name` and the bare label stay readable for a headline.
 * When there are no words that differ (one path is the other's parent), the name's folder is not at
 * the end of its key (a non-ASCII name, a renamed project), or the hints cannot be told apart, the
 * rows are counted instead: "Name (1)", "Name (2)".
 */
export function uniqueLabels<T extends { key: string; label: string }>(rows: T[]): (T & { hint?: string })[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.label, [...(groups.get(r.label) ?? []), r]);
  const out = new Map<T, { label: string; hint: string }>();
  for (const [label, group] of groups) {
    if (group.length < 2) continue;
    const parents = group.map((r) => parentWords(r.key, label));
    const hints = differing(parents);
    group.forEach((r, i) => {
      const hint = hints ? hints[i] : String(i + 1);
      out.set(r, { label: `${label} (${hint})`, hint });
    });
  }
  return rows.map((r) => (out.has(r) ? { ...r, ...out.get(r)! } : r));
}

/** Per path, the words that set it apart from the others; null when that is not possible. */
function differing(parents: (string[] | null)[]): string[] | null {
  if (parents.some((p) => p === null)) return null;
  const ps = parents as string[][];
  const lower = ps.map((p) => p.map((w) => w.toLowerCase()));
  const shortest = Math.min(...ps.map((p) => p.length));
  let head = 0;
  while (head < shortest && lower.every((p) => p[head] === lower[0][head])) head++;
  let tail = 0;
  while (tail < shortest - head && lower.every((p) => p[p.length - 1 - tail] === lower[0][lower[0].length - 1 - tail])) tail++;
  const hints = ps.map((p) => p.slice(head, p.length - tail).slice(-HINT_WORDS).join(" "));
  const distinct = new Set(hints.map((h) => h.toLowerCase())).size === hints.length;
  return distinct && hints.every((h) => h.length > 0) ? hints : null;
}

function seriesTotals(
  t: Timeline | null,
  label: (key: string, name: string) => string,
  top = 5,
  byFolder = false,
): { label: string; value: number; name: string; hint?: string }[] {
  const rows = (t?.series ?? [])
    .map((s) => ({ key: s.key, label: label(s.key, s.label), name: label(s.key, s.label), value: s.points.reduce((n, p) => n + headline(p.tokens), 0) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const shown = rows.slice(0, top);
  const out: { label: string; value: number; name: string; hint?: string }[] = byFolder ? uniqueLabels(shown) : shown;
  return out.map(({ label: l, value, name, hint }) => ({ label: l, value, name, ...(hint ? { hint } : {}) }));
}
/**
 * A model's plain name for the story. The app's namer knows "claude-<family>-<version>"; a cloud
 * provider wraps that id in its own prefix and suffix ("us.anthropic.claude-sonnet-4-5-20250929-v1:0",
 * "claude-sonnet-4-5@20250929"). The model inside is named, so the raw id never lands on a slide.
 * An id with no model in it stays as it is (the slide then wraps and cuts it like any long name).
 */
export function storyModelName(id: string, name: (id: string) => string): string {
  const plain = name(id);
  if (plain !== id) return plain;
  const inner = /claude-(?:[a-z]+-\d{1,3}(?:-\d{1,2}(?!\d))?|\d{1,3}(?:-\d{1,2}(?!\d))?-[a-z]+)(?:-\d{8})?/.exec(id);
  if (!inner) return id;
  const named = name(inner[0]);
  return named === inner[0] ? id : named;
}

/**
 * Everything the story needs, from the same queries the other screens use. Returns null when there
 * is no usage at all. A part that fails is left out; the story is built from what is there.
 */
export async function loadWrapped(daily: Daily, nameModel: (id: string) => string): Promise<WrappedData | null> {
  const modelName = (id: string) => storyModelName(id, nameModel);
  const backend = getBackend();
  const firstIdx = daily.tokens.findIndex((v) => v > 0);
  if (firstIdx < 0) return null;
  const from = daily.days[firstIdx];
  const to = daily.today;
  const spanDays = daily.days.length - firstIdx;
  const dayTokens = daily.tokens.slice(firstIdx);
  const points = daily.points.slice(firstIdx);

  let tokens = 0;
  let activeDays = 0;
  let busy = -1;
  for (let i = 0; i < dayTokens.length; i++) {
    const v = dayTokens[i];
    if (v <= 0) continue;
    activeDays++;
    tokens += v;
    if (busy < 0 || v > dayTokens[busy]) busy = i;
  }

  const hourFrom = addDays(to, -(HOUR_WINDOW_DAYS - 1)) > from ? addDays(to, -(HOUR_WINDOW_DAYS - 1)) : from;
  const range = { from, to };

  // Chats that are gone from disk are left out of every list here, the same as the habits count.
  const present = { ...range, includeMissing: false };
  const [hourly, byProject, byModel, longest, habits, skills, agents, tools] = await Promise.all([
    quiet(backend.usageTimeline({ from: hourFrom, to, bucket: "hour" }), null),
    quiet(backend.usageTimeline({ ...range, bucket: "month", groupBy: "project" }), null),
    quiet(backend.usageTimeline({ ...range, bucket: "month", groupBy: "model" }), null),
    quiet(backend.sessionsList({ ...present, sort: "duration", dir: "desc", limit: 1 }), null),
    quiet(backend.usageWrappedHabits(range), null),
    // Every skill, so the Toolsmith rule can count all uses; the story shows the top five.
    quiet(backend.usageByItem({ kind: "skill", ...range, limit: 500 }), [] as ItemUse[]),
    quiet(backend.usageByItem({ kind: "agent", ...range, limit: 5 }), [] as ItemUse[]),
    quiet(backend.usageByItem({ kind: "tool", ...range, limit: 5 }), [] as ItemUse[]),
  ]);

  const used = (l: ItemUse[]) => l.filter((i) => i.uses > 0);
  const usedSkills = used(skills);

  return {
    from,
    to,
    spanDays,
    activeDays,
    tokens,
    sessions: longest?.total ?? points.reduce((n, p) => n + p.sessions, 0),
    busiest: busy >= 0 ? { day: daily.days[firstIdx + busy], tokens: dayTokens[busy], sessions: points[busy].sessions } : null,
    streak: daily.streak,
    longestStreak: daily.longest,
    hours: hourly ? hourTotals(hourly.points) : new Array<number>(24).fill(0),
    hoursDays: Math.min(spanDays, HOUR_WINDOW_DAYS),
    dayTokens,
    skills: usedSkills.slice(0, 5),
    agents: used(agents),
    tools: used(tools),
    skillUses: usedSkills.reduce((n, s) => n + s.uses, 0),
    projects: seriesTotals(byProject, (_k, name) => name, 5, true),
    models: seriesTotals(byModel, (key) => modelName(key), 4),
    longest: longest?.rows[0] ?? null,
    biggest: habits?.biggest ?? null,
    habits,
  };
}
