import { useEffect, useMemo, useState } from "react";
import { ArrowRight, FolderSimple, Info, SquaresFour } from "@phosphor-icons/react";
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
import { ErrorBlock, SectionTitle, Skeleton } from "../components/usage/StateBlocks";
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
function Notes({ data, status }: { data: DashboardData; status: UsageStatus | null }) {
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
  if (notes.length === 0) return null;
  return (
    <ul aria-label="About these numbers" className="mt-8 space-y-2">
      {notes.map((n) => (
        <li key={n} className="flex items-start gap-2 text-caption text-ink-2">
          <Info size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}

function PriceFootnote() {
  const backend = getBackend();
  const price = useFetched(() => backend.pricingGet(), []);
  const info = price.data;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-2">
      <span>
        Dollar figures in hovers are estimates from a price list{info ? ` (updated ${info.table.updated})` : ""}, not a bill.
      </span>
      {info?.error && (
        <span role="status" className="text-warning">
          The price file could not be read, so the last good prices are in use.
        </span>
      )}
      {info?.newerSeedAvailable && <span>Atlas ships newer prices, but your edited price file was kept.</span>}
      {info && (
        <button
          type="button"
          onClick={() => void backend.pricingReveal().catch(() => {})}
          className="press cursor-pointer rounded-control text-accent-text underline-offset-2 hover:underline"
        >
          Show the price list
        </button>
      )}
    </div>
  );
}

function DashboardSkeleton({ firstIndex }: { firstIndex: boolean }) {
  return (
    <div role="status" aria-label="Loading your usage">
      <div className="grid grid-cols-1 gap-4 @[740px]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card className="px-6 py-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-4 h-14 w-56" />
          <Skeleton className="mt-3 h-4 w-48" />
        </Card>
        <Card className="px-5 py-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="mt-4 size-[104px] !rounded-full" />
        </Card>
      </div>
      {firstIndex && <p className="mt-4 text-body text-ink-2">Reading your history. This runs once.</p>}
    </div>
  );
}

/** Top models as one stacked bar: three named, the rest folded into "Other". */
function modelItems(data: DashboardData): StackItem[] {
  const models = data.byModel.map((m) => ({ key: m.model, label: modelLabel(m.model), value: headline(m.tokens), title: m.model }));
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
      valueText: last[i] ? compact(last[i]) : "No activity",
      detail: last[i] ? `tokens, ${points[i].cost.usd === null ? "no price" : `${formatUsd(points[i].cost.usd)} estimated`}` : "",
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
    const rows = data.topProjects.slice(0, PROJECTS_SHOWN).map((p) => {
      const s = byKey.get(p.projectKey);
      return { p, spark: s ? bin(s.points.map((pt) => headline(pt.tokens)), 10) : null };
    });
    let active = 0;
    for (const s of series ?? []) if (sumTail(s.points, 7) > 0) active++;
    return { rows, count: series ? active : null };
  }, [data, projectSeries.data]);

  const weekTokens = data ? headline(data.week.tokens) : 0;
  const updated = updatedText(dash.at, now);

  return (
    <div className="@container">
      <PageTitle title="Dashboard" />
      <IndexProgress status={status} progress={progress} onRetry={() => void backend.usageReindex("changed").catch(() => {})} />

      {cfg === null ? (
        <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
          {info.sandbox.state === "failed"
            ? "The sandbox copy could not be made, so nothing is shown. See Settings."
            : "Waiting for your Claude folder. Your usage appears here as soon as it is ready."}
        </p>
      ) : dash.error && !cacheNotReady(status) ? (
        <ErrorBlock title="Could not load your usage" message={dash.error} onRetry={() => dash.reload(false)} />
      ) : !data || (nothing && firstIndex) ? (
        <DashboardSkeleton firstIndex={firstIndex} />
      ) : nothing ? (
        <EmptyState
          icon={SquaresFour}
          seed={7}
          className="min-h-[max(320px,calc(100vh-20rem))]"
          title="No Claude Code usage found yet"
          body="Atlas reads the conversations Claude Code saves in your Claude folder. Use Claude Code once and the numbers show up here on their own."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 @[900px]:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)] @[900px]:items-start">
          <div className="min-w-0 space-y-4">
            <section aria-label="Last 7 days" className="rise @container" style={{ ["--i" as string]: 1 }}>
              <Card className="flex h-full flex-col gap-3 px-6 pb-4 pt-4 @[520px]:flex-row @[520px]:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="d d-figure text-ink">Last 7 days</h2>
                    {week?.delta != null && <Delta pct={week.delta} />}
                  </div>
                  <div className="my-2 flex items-baseline gap-2.5" title={tokenHint(weekTokens, data.week.cost)}>
                    <CountUp value={weekTokens} format={compact} id="dash:hero" className="d d-hero text-ink" />
                    <span className="text-lead font-semibold text-ink-2">tokens</span>
                  </div>
                  <div className="text-body text-ink-2">
                    {plural(data.week.sessions, "session")}
                    {projects.count ? ` · ${plural(projects.count, "project")}` : ""}
                  </div>
                  {data.week.tokens.cacheRead > 0 && (
                    <div className="mt-1 text-caption text-ink-2" title={`${exact(data.week.tokens.cacheRead)} tokens`}>
                      {`Plus ${compact(data.week.tokens.cacheRead)} cache reads, listed apart.`}
                    </div>
                  )}
                  {updated && <div className="mt-1 text-caption text-ink-2">{updated}</div>}
                </div>
                {week && (
                  <div className="w-full self-end @[520px]:w-[clamp(200px,40%,600px)] @[520px]:shrink-0">
                    <Ridge id="dash:ridge" data={week.readouts} label="Tokens per day, last 7 days" height={112} />
                  </div>
                )}
              </Card>
            </section>

            <section aria-label="Activity" className="rise" style={{ ["--i" as string]: 3 }}>
              <ActivityCard today={today} />
            </section>

            <div className="grid grid-cols-1 gap-4 @[740px]:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
            <section aria-label="Models" className="rise" style={{ ["--i" as string]: 5 }}>
              <Card className="h-full px-5 py-4">
                <div className="flex items-baseline justify-between">
                  <h2 className="d d-figure text-ink">Models</h2>
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
                  <h2 className="d d-figure text-ink">Projects</h2>
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
          <div className="min-w-0 space-y-4">
            <section aria-label="Today" className="rise" style={{ ["--i" as string]: 2 }}>
              <Card className="h-full px-5 py-3.5">
                <div className="flex items-baseline justify-between">
                  <h2 className="d d-figure text-ink">Today</h2>
                  <span className="text-caption text-ink-2">so far</span>
                </div>
                <div className="mt-2.5 flex items-center gap-[18px]">
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

            <section aria-label="On a roll" className="rise" style={{ ["--i" as string]: 4 }}>
              <Card className="h-full px-5 py-3.5">
                <div className="mb-2.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <div className="flex items-center gap-2">
                    <h2 className="d d-figure text-ink">On a roll</h2>
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
                    footer={(weeks) => (
                      <div className="mt-3 flex items-center justify-between">
                        <span className="text-caption text-ink-2">{`Last ${weeks} weeks`}</span>
                        <span aria-hidden="true" className="flex items-center gap-1 text-caption text-ink-2">
                          Less
                          {[0, 1, 2, 3, 4, 5].map((b) => (
                            <i key={b} className="inline-block size-2.5 rounded-[3px]" style={{ background: `var(--heat-${b})` }} />
                          ))}
                          More
                        </span>
                      </div>
                    )}
                  />
                ) : (
                  <Skeleton className="h-[120px] w-full" />
                )}
              </Card>
            </section>

          <section aria-label="Recent sessions" className="rise" style={{ ["--i" as string]: 7 }}>
            <SectionTitle
              aside={
                <Button onClick={() => setView("sessions")}>
                  <IconMotion motion="nudge">
                    <ArrowRight />
                  </IconMotion>
                  See all sessions
                </Button>
              }
            >
              Recent sessions
            </SectionTitle>
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

      {data && !nothing && <Notes data={data} status={status} />}
      {data && !nothing && <PriceFootnote />}
    </div>
  );
}
