import { useEffect, useMemo, useState } from "react";
import { ArrowRight, FolderSimple, Info } from "@phosphor-icons/react";
import { Button, Card, PageTitle } from "../components/controls";
import { CountUp } from "../components/CountUp";
import { EmptyState } from "../components/EmptyState";
import { IconMotion } from "../components/IconMotion";
import { IndexProgress } from "../components/IndexProgress";
import { HeatGrid } from "../components/charts/HeatGrid";
import { Ridge } from "../components/charts/Ridge";
import { Ring } from "../components/charts/Ring";
import { Sparkline } from "../components/charts/Sparkline";
import { StackBar } from "../components/charts/StackBar";
import type { StackItem } from "../components/charts/StackBar";
import { ActivityCard } from "../components/usage/ActivityCard";

import { SessionGrid, SessionLine } from "../components/usage/SessionList";
import { Skeleton } from "../components/usage/StateBlocks";
import { useAtlas } from "../state/AtlasProvider";
import { getBackend } from "../lib/ipc";
import { openSessionNext } from "../lib/nav";
import { useDaily } from "../lib/useDaily";
import { cacheNotReady, useFetched, useLiveReload, useUsageStatus } from "../lib/useUsage";
import {
  bin,
  lastAndPrevious,
  lastDays,
  percentChange,
  shortDay,
  sumTail,
  updatedText,
  weekdayInitial,
} from "../lib/dashboardModel";
import { usualDay } from "../lib/chartPaths";
import { addDays, compact, exact, formatUsd, headline, localDay, modelLabel, plural, tokenHint } from "../lib/usage";
import type { BarDatum } from "../components/charts/Bars";
import type { Dashboard as DashboardData, Timeline, UsageStatus } from "../lib/types";

/** The current time, refreshed every `ms`, so "Updated 3 min ago" stays true. */
function useNow(ms = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function Delta({ pct }: { pct: number }) {
  const up = pct >= 0;
  return (
    <span className="chip chip-clay" title="Compared with the 7 days before. More or less use is neither good nor bad.">
      <ArrowRight size={12} weight="bold" aria-hidden="true" style={{ rotate: up ? "-45deg" : "45deg" }} />
      {`${Math.abs(pct)}% vs last week`}
    </span>
  );
}

/** Things worth knowing about how the numbers were made, only when there are any. */
function Notes({ data, status }: { data: DashboardData; status: UsageStatus | null }): string[] {
  const notes: string[] = [];
  if (data.warnings.unknownModels.length > 0) {
    notes.push(
      `No price for ${data.warnings.unknownModels.map(modelLabel).join(", ")}. Their tokens are counted, but they get no dollar estimate, so an estimate with a plus sign is higher in real life.`,
    );
  }
  if (status && status.cwAssumedRows > 0) {
    notes.push(
      `${plural(status.cwAssumedRows, "message")} did not say how long Claude kept their cache, so they are priced at the 5-minute rate (estimated).`,
    );
  }
  if (status && status.malformedLines > 0) {
    notes.push(`${plural(status.malformedLines, "line")} in your sessions could not be read and were skipped.`);
  }
  if (status && status.longLines > 0) {
    notes.push(`${plural(status.longLines, "line")} in your sessions were too long to read and were skipped.`);
  }
  if (status && status.filesMissing > 0) {
    notes.push(`${plural(status.filesMissing, "session file")} are no longer on disk. Their numbers are kept.`);
  }
  return notes;
}

/**
 * A small info mark beside "Updated": its hover holds every note about how the numbers were
 * made (no explanation sentences on the page, no page scroll). The price list itself is in
 * Settings. A price file that could not be read tints the mark and leads the hover.
 */
function AboutNumbers({ data, status }: { data: DashboardData; status: UsageStatus | null }) {
  const backend = getBackend();
  const price = useFetched(() => backend.pricingGet(), []);
  const info = price.data;
  const notes = [
    ...(info?.error ? ["The price file could not be read, so the last good prices are in use."] : []),
    `Dollar figures in hovers are estimates from a price list${info ? ` (updated ${info.table.updated})` : ""}, not a bill.`,
    ...(info?.newerSeedAvailable ? ["Atlas ships newer prices, but your edited price file was kept."] : []),
    ...Notes({ data, status }),
  ];
  return (
    <span
      tabIndex={0}
      title={notes.join("\n")}
      aria-label="About these numbers"
      role={info?.error ? "status" : undefined}
      className={`inline-flex cursor-help items-center ${info?.error ? "text-warning" : ""}`}
    >
      <Info size={14} aria-hidden="true" />
    </span>
  );
}

/**
 * The page grid. Wide: two columns, each a stack of cards. Mid (the smallest window): the same
 * cards in rows (week | today, activity | streak, then models with projects, then recent
 * sessions across). Narrow: one column in that reading order.
 */
const PAGE_GRID =
  "grid grid-cols-1 gap-4 @[600px]:grid-cols-2 @[740px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @[900px]:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]";
/** A card that runs the full width while the grid is two equal columns (600 to 739 px). */
const PAGE_WIDE = "@[600px]:col-span-2 @[740px]:col-span-1";
/** A column of the wide grid; below it the column dissolves and its cards join the page grid. */
const PAGE_COLUMN = "contents @[900px]:block @[900px]:min-w-0 @[900px]:space-y-4";

function DashboardSkeleton() {
  return (
    <div role="status" aria-label="Loading your usage">
      {/* The same grid as the page it stands in for, so nothing jumps when the numbers land. */}
      <div className={PAGE_GRID}>
        <Card className={`px-6 py-5 ${PAGE_WIDE}`}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-4 h-14 w-56 max-w-full" />
          <Skeleton className="mt-3 h-4 w-48 max-w-full" />
        </Card>
        <Card className="px-5 py-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="mt-4 size-[88px] !rounded-full" />
        </Card>
        {/* A small window shows the top row only, so the loading state stays on one screen. */}
        <Card className="hidden px-5 py-4 @[740px]:block">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-4 h-[144px] w-full" />
        </Card>
        <Card className="hidden px-5 py-4 @[600px]:block">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="mt-4 h-[120px] w-full" />
        </Card>
      </div>
      {/* No words here: during the first read the banner above the page already says what is
          happening and that it happens once. */}
    </div>
  );
}

/** Top models as one stacked bar: three named, the rest folded into "Other". */
function modelItems(data: DashboardData): StackItem[] {
  // Full names ("Opus 5.5"); a model the price list does not know says so.
  const models = data.byModel.map((m) => ({
    key: m.model,
    label: m.known ? modelLabel(m.model) : `${modelLabel(m.model)} (not priced)`,
    value: headline(m.tokens),
    title: m.model,
  }));
  // Biggest first by the number shown (the engine lists them by cost).
  models.sort((a, b) => b.value - a.value);
  const top = models.slice(0, 3);
  const rest = models.slice(3);
  const restValue = rest.reduce((s, m) => s + m.value, 0);
  // "Other" only earns a row when it is at least 1% of the whole: a row reading 0% only costs height.
  const topValue = top.reduce((s, m) => s + m.value, 0);
  const all = restValue > 0.01 * (topValue + restValue) ? [...top, { key: "other", label: "Other", value: restValue, title: rest.map((r) => r.label).join(", ") }] : top;
  const total = all.reduce((s, m) => s + m.value, 0) || 1;
  return all.map((m, i) => ({
    key: m.key,
    label: m.label,
    value: m.value,
    tone: i + 1,
    right: compact(m.value),
    share: `${Math.round((m.value / total) * 100)}%`,
    title: m.title,
  }));
}

/** The Dashboard fits a 1280x800 window without scrolling; the Sessions tab has the full list. */
/** An empty or failed Dashboard takes the page: at least a card's height, and the window's when it is taller. */
const STATE_HEIGHT = "min-h-[max(320px,calc(var(--app-h)-9rem))]";
const RECENT_SHOWN = 3;
/** The Projects card lists this many, whatever the engine sends (the rest are on the Sessions tab). */
const PROJECTS_SHOWN = 4;

export function Dashboard() {
  const { info, setView } = useAtlas();
  const backend = getBackend();
  const cfg = info.config;
  const { status, progress } = useUsageStatus();
  const dash = useFetched(() => backend.usageDashboard(), [cfg?.projectsDir ?? null]);
  useLiveReload(dash.reload);
  const daily = useDaily(cfg?.projectsDir ?? null);
  const now = useNow();

  const data = dash.data;
  const today = data?.todayDate || localDay(new Date(now));
  const projectSeries = useFetched<Timeline>(
    () => backend.usageTimeline({ from: addDays(today, -29), to: today, bucket: "day", groupBy: "project" }),
    [cfg?.projectsDir ?? null, today, data?.month.sessions ?? 0],
  );
  const firstIndex = status?.state === "indexing" && !status.firstIndexDone;
  const nothing = data !== null && data.recent.length === 0 && data.month.tokens.total === 0 && data.month.sessions === 0;
  // The banner above the page already says the engine failed and offers "Try again".
  const engineDown = status?.state === "error";

  const open = (id: string) => {
    openSessionNext(id);
    setView("sessions");
  };

  const week = useMemo(() => {
    if (!daily) return null;
    const { last, prev } = lastAndPrevious(daily.tokens, 7);
    const days = lastDays(daily.today, 7);
    const points = daily.points.slice(-7);
    const readouts: BarDatum[] = days.map((d, i) => ({
      key: d,
      value: last[i] ?? 0,
      axis: weekdayInitial(d),
      title: shortDay(d),
      valueText: last[i] ? `${compact(last[i])} tokens` : "No activity",
      detail: last[i] ? (points[i].cost.usd === null ? "No price" : `${formatUsd(points[i].cost.usd)} estimated`) : "",
    }));
    const usual = usualDay(daily.tokens.slice(-31, -1));
    return {
      readouts,
      delta: percentChange(last.reduce((s, v) => s + v, 0), prev.reduce((s, v) => s + v, 0)),
      usual,
      todayTokens: daily.tokens[daily.tokens.length - 1] ?? 0,
    };
  }, [daily]);

  const heat = useMemo(() => {
    if (!daily) return null;
    const n = 364;
    const values = daily.tokens.slice(-n);
    const pts = daily.points.slice(-n);
    const readouts = pts.map((p, i) => ({
      title: shortDay(p.start),
      valueText: values[i] > 0 ? `${compact(values[i])} tokens` : "No activity",
      detail: values[i] > 0 ? `${formatUsd(p.cost.usd ?? 0)} estimated, ${plural(p.sessions, "session")} started` : "",
    }));
    return { values, readouts };
  }, [daily]);

  // Projects: how many were active this week and a 30 day sparkline per top project.
  const projects = useMemo(() => {
    const series = projectSeries.data?.series ?? null;
    if (!data) return { rows: [], count: null as number | null };
    const byKey = new Map((series ?? []).map((s) => [s.key, s]));
    // Biggest first by the number shown (the engine lists them by cost).
    const top = [...data.topProjects].sort((a, b) => headline(b.tokens) - headline(a.tokens)).slice(0, PROJECTS_SHOWN);
    const rows = top.map((p) => {
      const s = byKey.get(p.projectKey);
      return { p, spark: s ? bin(s.points.map((pt) => headline(pt.tokens)), 10) : null };
    });
    let active = 0;
    for (const s of series ?? []) if (sumTail(s.points, 7) > 0) active++;
    return { rows, count: series ? active : null };
  }, [data, projectSeries.data]);

  const reindex = () => void backend.usageReindex("changed").catch(() => {});
  const weekTokens = data ? headline(data.week.tokens) : 0;
  const updated = updatedText(dash.at, now);

  return (
    <div className="@container">
      <PageTitle title="Dashboard" />
      {/* With nothing to show under it, a failed engine is the page's one calm message, not a band over a blank page. */}
      {!(engineDown && !data) && <IndexProgress status={status} progress={progress} onRetry={reindex} />}

      {cfg === null ? (
        <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
          {info.sandbox.state === "failed"
            ? "The sandbox copy could not be made, so nothing is shown. See Settings."
            : "Waiting for your Claude folder. Your usage appears here as soon as it is ready."}
        </p>
      ) : dash.error && !cacheNotReady(status) && !engineDown ? (
        <EmptyState
          variant="error"
          className={STATE_HEIGHT}
          title="Could not load your usage"
          reason={dash.error}
          action={{ onClick: () => dash.reload(false) }}
        />
      ) : engineDown && !data ? (
        <EmptyState
          variant="error"
          className={STATE_HEIGHT}
          title="Atlas could not read your usage"
          body="Nothing in your Claude folder was changed."
          reason={status?.error}
          action={{ onClick: reindex }}
        />
      ) : !data || (nothing && firstIndex) ? (
        <DashboardSkeleton />
      ) : nothing ? (
        <EmptyState
          seed={7}
          className={STATE_HEIGHT}
          title="No Claude Code usage found yet"
          body="Use Claude Code once and your numbers show up here on their own."
        />
      ) : (
        <div className={`${PAGE_GRID} @[900px]:items-start`}>
          <div className={PAGE_COLUMN}>
            <section aria-label="Last 7 days" className={`rise @container order-1 min-w-0 ${PAGE_WIDE}`} style={{ ["--i" as string]: 1 }}>
              <Card className="flex h-full flex-col gap-3 px-6 pb-4 pt-4 @[460px]:flex-row @[460px]:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="h-section">Last 7 days</h2>
                    {week?.delta != null && <Delta pct={week.delta} />}
                  </div>
                  <div
                    className="my-2 flex flex-wrap items-baseline gap-x-2.5"
                    title={
                      data.week.tokens.cacheRead > 0
                        ? `${tokenHint(weekTokens, data.week.cost)}\nPlus ${exact(data.week.tokens.cacheRead)} cache reads, counted apart.`
                        : tokenHint(weekTokens, data.week.cost)
                    }
                  >
                    <CountUp value={weekTokens} format={compact} id="dash:hero" className="d d-hero text-ink" />
                    <span className="text-lead font-semibold text-ink-2">tokens</span>
                  </div>
                  <div className="text-body text-ink-2">
                    {plural(data.week.sessions, "session")}
                    {projects.count ? ` · ${plural(projects.count, "project")}` : ""}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-caption text-ink-2">
                    {updated && <span>{updated}</span>}
                    <AboutNumbers data={data} status={status} />
                  </div>
                </div>
                {week && (
                  <div className="w-full self-end @[460px]:w-[clamp(168px,40%,600px)] @[460px]:shrink-0">
                    <Ridge id="dash:ridge" data={week.readouts} label="Tokens per day, last 7 days" height={112} />
                  </div>
                )}
              </Card>
            </section>

            <section aria-label="Activity" className={`rise order-4 min-w-0 @[740px]:order-3 ${PAGE_WIDE}`} style={{ ["--i" as string]: 3 }}>
              <ActivityCard today={today} />
            </section>

            <div className="order-5 grid min-w-0 grid-cols-1 gap-4 @[600px]:col-span-2 @[620px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <section aria-label="Models" className="rise" style={{ ["--i" as string]: 5 }}>
              <Card className="h-full px-5 py-4">
                <div className="flex items-baseline justify-between">
                  <h2 className="h-section">Models</h2>
                  <span className="text-caption text-ink-2">Last 30 days</span>
                </div>
                {data.byModel.length === 0 ? (
                  <p className="mt-3 text-body text-ink-2">No model has been used in the last 30 days.</p>
                ) : (
                  <div className="mt-4">
                    <StackBar id="dash:models" label="Share of tokens by model, last 30 days" items={modelItems(data)} />
                  </div>
                )}
              </Card>
            </section>

            <section aria-label="Projects" className="rise" style={{ ["--i" as string]: 6 }}>
              <Card className="h-full px-5 py-4">
                <div className="flex items-baseline justify-between">
                  <h2 className="h-section">Projects</h2>
                  <span className="text-caption text-ink-2">Last 30 days</span>
                </div>
                {projects.rows.length === 0 ? (
                  <p className="mt-3 text-body text-ink-2">No project has been used in the last 30 days.</p>
                ) : (
                  <ul className="mt-2.5">
                    {projects.rows.map(({ p, spark }) => (
                      <li
                        key={p.projectKey}
                        title={p.path}
                        className="grid grid-cols-[minmax(0,1fr)_56px_52px] items-center gap-3 rounded-control px-2 py-1.5 transition-colors duration-[var(--dur-fast)] hover:bg-raised"
                      >
                        <span className="flex min-w-0 items-center gap-2 font-semibold text-ink">
                          <FolderSimple size={16} aria-hidden="true" className="shrink-0 text-ink-2" />
                          <span className="truncate">{p.name}</span>
                          <span className="sr-only">{`, ${plural(p.sessions, "session")}`}</span>
                        </span>
                        {spark ? <Sparkline id={`dash:spark:${p.projectKey}`} values={spark} /> : <span />}
                        <span className="d d-small text-right text-ink" title={`${exact(headline(p.tokens))} tokens`}>
                          {compact(headline(p.tokens))}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </section>
            </div>
          </div>
          <div className={PAGE_COLUMN}>
            <section aria-label="Today" className="rise order-2 min-w-0" style={{ ["--i" as string]: 2 }}>
              <Card className="flex h-full flex-col px-5 py-3.5">
                <div className="flex items-baseline justify-between">
                  <h2 className="h-section">Today</h2>
                  <span className="text-caption text-ink-2">so far</span>
                </div>
                <div className="mt-2.5 flex flex-1 items-center gap-[18px]">
                  <Ring
                    id="dash:ring"
                    size={88}
                    stroke={10}
                    frac={week && week.usual > 0 ? week.todayTokens / week.usual : 0}
                    label={
                      week && week.usual > 0
                        ? `${Math.round((week.todayTokens / week.usual) * 100)} percent of a usual day`
                        : "No usual day yet"
                    }
                  >
                    <div>
                      <div className="d d-figure text-ink" title={tokenHint(headline(data.today.tokens), data.today.cost)}>
                        {compact(headline(data.today.tokens))}
                      </div>
                      <div className="text-caption text-ink-2">tokens</div>
                    </div>
                  </Ring>
                  <div className="flex min-w-0 flex-col gap-2.5">
                    <div>
                      <b className="d d-figure block text-ink">
                        {week && week.usual > 0 ? `${Math.round((week.todayTokens / week.usual) * 100)}%` : "None yet"}
                      </b>
                      <span className="text-caption text-ink-2">{week && week.usual > 0 ? "of a usual day" : "no usual day to compare"}</span>
                    </div>
                    <div>
                      <b className="d d-small block text-ink">{plural(data.today.sessions, "session")}</b>
                      <span className="text-caption text-ink-2">started today</span>
                    </div>
                  </div>
                </div>
              </Card>
            </section>

            <section aria-label="On a roll" className="rise order-3 min-w-0 @[740px]:order-4" style={{ ["--i" as string]: 4 }}>
              <Card className="h-full px-5 py-3.5">
                <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="flex items-center gap-2">
                    <h2 className="h-section">On a roll</h2>
                    {daily && daily.streak >= 2 && daily.streak === daily.longest && (
                      <span className="chip chip-clay">
                        <span className="spark" style={{ width: 12, height: 12, background: "currentColor" }} aria-hidden="true" />
                        Longest yet
                      </span>
                    )}
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="d d-stat text-ink">{daily ? daily.streak : 0}</span>
                    <span className="font-semibold text-ink-2">{daily && daily.streak === 1 ? "day in a row" : "days in a row"}</span>
                  </div>
                </div>
                {heat ? (
                  <HeatGrid
                    id="dash:heat"
                    values={heat.values}
                    readouts={heat.readouts}
                    label="Daily activity"
                    legend
                  />
                ) : (
                  <Skeleton className="h-[120px] w-full" />
                )}
              </Card>
            </section>

          <section aria-label="Recent sessions" className="rise @container order-6 min-w-0 @[600px]:col-span-2" style={{ ["--i" as string]: 7 }}>
            <div className="mb-3 flex items-center justify-between gap-4">
              <h2 className="h-section">Recent sessions</h2>
              <Button onClick={() => setView("sessions")}>
                <IconMotion motion="nudge">
                  <ArrowRight />
                </IconMotion>
                See all sessions
              </Button>
            </div>
            <Card>
              <SessionGrid>
                {data.recent.slice(0, RECENT_SHOWN).map((r) => (
                  <SessionLine key={r.sessionId} row={r} onOpen={open} />
                ))}
              </SessionGrid>
            </Card>
          </section>
          </div>
        </div>
      )}

    </div>
  );
}
