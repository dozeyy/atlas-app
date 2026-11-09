import { getBackend } from "./ipc";
import { hourTotals } from "./wrappedModel";
import type { WrappedData } from "./wrappedModel";
import { addDays, headline } from "./usage";
import type { Daily } from "./useDaily";
import type { ItemUse, Timeline } from "./usageTypes";

/** The hour-of-day picture only needs recent weeks, and an hourly query is the big one. */
const HOUR_WINDOW_DAYS = 120;
const DEFAULT_KEEP_DAYS = 30;

const quiet = <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);

function seriesTotals(t: Timeline | null, label: (key: string, name: string) => string, top = 5): { label: string; value: number }[] {
  const rows = (t?.series ?? [])
    .map((s) => ({ label: label(s.key, s.label), value: s.points.reduce((n, p) => n + headline(p.tokens), 0) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value);
  return rows.slice(0, top);
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

  const [hourly, byProject, byModel, longest, skills, agents, tools, overview] = await Promise.all([
    quiet(backend.usageTimeline({ from: hourFrom, to, bucket: "hour" }), null),
    quiet(backend.usageTimeline({ ...range, bucket: "month", groupBy: "project" }), null),
    quiet(backend.usageTimeline({ ...range, bucket: "month", groupBy: "model" }), null),
    quiet(backend.sessionsList({ ...range, sort: "duration", dir: "desc", limit: 1 }), null),
    quiet(backend.usageByItem({ kind: "skill", ...range, limit: 5 }), [] as ItemUse[]),
    quiet(backend.usageByItem({ kind: "agent", ...range, limit: 5 }), [] as ItemUse[]),
    quiet(backend.usageByItem({ kind: "tool", ...range, limit: 5 }), [] as ItemUse[]),
    quiet(backend.settingsOverview(), null),
  ]);

  const used = (l: ItemUse[]) => l.filter((i) => i.uses > 0);

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
    dayTokens,
    skills: used(skills),
    agents: used(agents),
    tools: used(tools),
    projects: seriesTotals(byProject, (_k, name) => name),
    models: seriesTotals(byModel, (key) => modelName(key), 4),
    longest: longest?.rows[0] ?? null,
    keepDays: overview?.cleanupDays ?? DEFAULT_KEEP_DAYS,
  };
}
