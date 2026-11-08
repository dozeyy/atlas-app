import { CheckCircle, Circle, Info, SquaresFour } from "@phosphor-icons/react";
import { Button, Card, PageHeader } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { IndexProgress } from "../components/IndexProgress";
import { Activity } from "../components/usage/Activity";
import { CostText } from "../components/usage/CostText";
import { HBars } from "../components/usage/HBars";
import { SessionLine } from "../components/usage/SessionList";
import { ErrorBlock, SectionTitle, Skeleton } from "../components/usage/StateBlocks";
import { useAtlas } from "../state/AtlasProvider";
import { getBackend } from "../lib/ipc";
import { describeSource } from "../lib/labels";
import { openSessionNext } from "../lib/nav";
import { cacheNotReady, useFetched, useLiveReload, useUsageStatus } from "../lib/useUsage";
import { compact, exact, headline, localDay, modelLabel, plural } from "../lib/usage";
import type { Dashboard as DashboardData, Period, UsageStatus } from "../lib/types";

function Check({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? CheckCircle : Circle;
  return (
    <li className="flex items-center gap-2 text-body text-ink">
      <Icon
        size={16}
        weight={ok ? "fill" : "regular"}
        aria-hidden="true"
        className={ok ? "text-success" : "text-ink-2"}
      />
      <span>{label}</span>
      <span className="sr-only">{ok ? "found" : "not found"}</span>
      <span aria-hidden="true" className="text-ink-2">
        {ok ? "" : "not found"}
      </span>
    </li>
  );
}

function PeriodCard({ label, period }: { label: string; period: Period }) {
  const t = period.tokens;
  return (
    <section aria-label={label}>
    <Card className="px-5 py-4">
      <div className="text-caption font-medium text-ink-2">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-title font-semibold tabular-nums text-ink" title={`${exact(headline(t))} tokens`}>
          {compact(headline(t))}
        </span>
        <span className="text-body text-ink-2">tokens</span>
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3 text-body">
        <CostText cost={period.cost} className="font-medium text-ink" />
        <span className="text-caption text-ink-2">estimated cost</span>
      </div>
      <div className="mt-1 text-caption text-ink-2">
        {plural(period.sessions, "session")}
        {t.cacheRead > 0 && <span title={`${exact(t.cacheRead)} tokens`}>{`, plus ${compact(t.cacheRead)} cache reads`}</span>}
      </div>
    </Card>
    </section>
  );
}

function PeriodSkeleton() {
  return (
    <div role="status" aria-label="Loading your usage" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <Card key={i} className="px-5 py-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="mt-3 h-8 w-28" />
          <Skeleton className="mt-4 h-4 w-full" />
          <Skeleton className="mt-2 h-4 w-24" />
        </Card>
      ))}
    </div>
  );
}

/** Things worth knowing about how the numbers were made, only when there are any. */
function Notes({ data, status }: { data: DashboardData; status: UsageStatus | null }) {
  const notes: string[] = [];
  if (data.warnings.unknownModels.length > 0) {
    notes.push(
      `No price for ${data.warnings.unknownModels.map(modelLabel).join(", ")}. Their tokens are counted, but their cost is left out, so a cost with a plus sign is higher in real life.`,
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
        Costs are estimates from a price list{info ? ` (updated ${info.table.updated})` : ""}, not a bill.
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

export function Dashboard() {
  const { info, setView } = useAtlas();
  const backend = getBackend();
  const cfg = info.config;
  const { status, progress } = useUsageStatus();
  const dash = useFetched(() => backend.usageDashboard(), [cfg?.projectsDir ?? null]);
  useLiveReload(dash.reload);

  const data = dash.data;
  const firstIndex = status?.state === "indexing" && !status.firstIndexDone;
  const nothing = data !== null && data.recent.length === 0 && data.month.tokens.total === 0 && data.month.sessions === 0;

  const open = (id: string) => {
    openSessionNext(id);
    setView("sessions");
  };

  return (
    <>
      <PageHeader title="Dashboard" subtitle="How you are using Claude Code, at a glance." />

      <IndexProgress status={status} progress={progress} onRetry={() => void backend.usageReindex("changed").catch(() => {})} />

      {cfg === null ? (
        <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
          Waiting for your Claude folder. Your usage appears here as soon as it is ready.
        </p>
      ) : dash.error && !cacheNotReady(status) ? (
        <ErrorBlock title="Could not load your usage" message={dash.error} onRetry={() => dash.reload(false)} />
      ) : !data || (nothing && firstIndex) ? (
        <PeriodSkeleton />
      ) : nothing ? (
        <EmptyState
          icon={SquaresFour}
          seed={7}
          className="min-h-[max(320px,calc(100vh-20rem))]"
          title="No Claude Code usage found yet"
          body="Atlas reads the conversations Claude Code saves in your Claude folder. Use Claude Code once and the numbers show up here on their own."
        />
      ) : (
        <div className="space-y-8">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <PeriodCard label="Today" period={data.today} />
            <PeriodCard label="Last 7 days" period={data.week} />
            <PeriodCard label="Last 30 days" period={data.month} />
          </div>

          <Activity today={data.todayDate || localDay(new Date())} />

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
            <section aria-label="By model">
              <SectionTitle aside={<span className="text-caption text-ink-2">Last 30 days</span>}>By model</SectionTitle>
              <Card>
                {data.byModel.length === 0 ? (
                  <p className="px-5 py-4 text-body text-ink-2">No model has been used in the last 30 days.</p>
                ) : (
                  <HBars
                    label="Usage by model"
                    items={data.byModel.map((m) => ({
                      key: m.model,
                      label: modelLabel(m.model),
                      sub: m.known ? undefined : "No price in the price list",
                      value: headline(m.tokens),
                      right: `${compact(headline(m.tokens))} tokens`,
                      rightSub: <CostText cost={m.cost} />,
                      title: m.model,
                    }))}
                  />
                )}
              </Card>
            </section>
            <section aria-label="Top projects">
              <SectionTitle aside={<span className="text-caption text-ink-2">Last 30 days</span>}>Top projects</SectionTitle>
              <Card>
                {data.topProjects.length === 0 ? (
                  <p className="px-5 py-4 text-body text-ink-2">No project has been used in the last 30 days.</p>
                ) : (
                  <HBars
                    label="Usage by project"
                    items={data.topProjects.map((p) => ({
                      key: p.projectKey,
                      label: p.name,
                      sub: plural(p.sessions, "session"),
                      value: headline(p.tokens),
                      right: `${compact(headline(p.tokens))} tokens`,
                      rightSub: <CostText cost={p.cost} />,
                      title: p.path,
                    }))}
                  />
                )}
              </Card>
            </section>
          </div>

          <section aria-label="Recent sessions">
            <SectionTitle
              aside={
                <Button onClick={() => setView("sessions")}>See all sessions</Button>
              }
            >
              Recent sessions
            </SectionTitle>
            <Card>
              <ul className="divide-y divide-line">
                {data.recent.map((r) => (
                  <SessionLine key={r.sessionId} row={r} onOpen={open} />
                ))}
              </ul>
            </Card>
          </section>
        </div>
      )}

      {data && !nothing && <Notes data={data} status={status} />}
      {data && !nothing && <PriceFootnote />}

      <h2 className="mb-3 mt-8 text-lead font-semibold text-ink">Claude folder</h2>
      <Card className="px-5 py-4">
        {cfg ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <code className="selectable break-all text-ink">{cfg.dir}</code>
              <span className="text-caption text-ink-2">{describeSource(cfg.source)}</span>
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <Check ok={cfg.dirExists} label="Folder" />
              <Check ok={cfg.claudeJsonExists} label="Settings file" />
              <Check ok={cfg.projectsExists} label="Projects" />
            </ul>
          </>
        ) : (
          <p role="status" className="text-body text-ink-2">
            {info.sandbox.state === "failed"
              ? "The sandbox copy could not be made, so nothing is shown. See Settings."
              : "Making a safe copy of your Claude folder..."}
          </p>
        )}
      </Card>
    </>
  );
}
