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

/**
 * Two projects can share a folder name (the same name under two parents). A legend that says
 * "Origin Client" twice cannot be read, so a colliding label gets the short part of its folder key
 * that sets it apart: the key is the project's path with every symbol turned into a dash, so what is
 * left once the shared start of the path and the folder's own name are cut is its parent.
 * Without a usable parent it falls back to a count, "(2)".
 */
export function uniqueLabels<T extends { key: string; label: string }>(rows: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(r.label, [...(groups.get(r.label) ?? []), r]);
  const out = new Map<T, string>();
  for (const [label, group] of groups) {
    if (group.length < 2) continue;
    const own = (label.match(WORDS) ?? []).map((w) => w.toLowerCase());
    const parents = group.map((r) => {
      const words = r.key.match(WORDS) ?? [];
      const tail = words.slice(words.length - own.length).map((w) => w.toLowerCase());
      return own.length > 0 && words.length > own.length && tail.every((w, i) => w === own[i]) ? words.slice(0, words.length - own.length) : words;
    });
    let shared = 0;
    while (parents.every((p) => p.length > shared + 1 && p[shared] === parents[0][shared])) shared++;
    const hints = parents.map((p) => p.slice(shared).slice(-2).join(" "));
    const distinct = new Set(hints).size === hints.length && hints.every((h) => h.length > 0);
    group.forEach((r, i) => out.set(r, `${label} (${distinct ? hints[i] : i + 1})`));
  }
  return rows.map((r) => (out.has(r) ? { ...r, label: out.get(r)! } : r));
}

function seriesTotals(t: Timeline | null, label: (key: string, name: string) => string, top = 5, byFolder = false): { label: string; value: number; name: string }[] {
  const rows = (t?.series ?? [])
    .map((s) => ({ key: s.key, label: label(s.key, s.label), name: label(s.key, s.label), value: s.points.reduce((n, p) => n + headline(p.tokens), 0) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  const shown = rows.slice(0, top);
  return (byFolder ? uniqueLabels(shown) : shown).map(({ label: l, value, name }) => ({ label: l, value, name }));
}

/**
 * Everything the story needs, from the same queries the other screens use. Returns null when there
 * is no usage at all. A part that fails is left out; the story is built from what is there.
 */
export async function loadWrapped(daily: Daily, modelName: (id: string) => string): Promise<WrappedData | null> {
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
  const [hourly, byProject, byModel, longest, first, habits, skills, agents, tools, overview] = await Promise.all([
    quiet(backend.usageTimeline({ from: hourFrom, to, bucket: "hour" }), null),
    quiet(backend.usageTimeline({ ...range, bucket: "month", groupBy: "project" }), null),
    quiet(backend.usageTimeline({ ...range, bucket: "month", groupBy: "model" }), null),
    quiet(backend.sessionsList({ ...present, sort: "duration", dir: "desc", limit: 1 }), null),
    quiet(backend.sessionsList({ ...present, sort: "started", dir: "asc", limit: 1 }), null),
    quiet(backend.usageWrappedHabits(range), null),
    // Every skill, so the Toolsmith rule can count all uses; the story shows the top five.
    quiet(backend.usageByItem({ kind: "skill", ...range, limit: 500 }), [] as ItemUse[]),
    quiet(backend.usageByItem({ kind: "agent", ...range, limit: 5 }), [] as ItemUse[]),
    quiet(backend.usageByItem({ kind: "tool", ...range, limit: 5 }), [] as ItemUse[]),
    quiet(backend.settingsOverview(), null),
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
    first: first?.rows[0] ?? null,
    habits,
    keepDays: overview?.cleanupDays ?? null,
  };
}
