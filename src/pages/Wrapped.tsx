import { useMemo } from "react";
import type { CSSProperties } from "react";
import { MapTrifold } from "@phosphor-icons/react";
import { getBackend } from "../lib/ipc";
import { cacheNotReady, useFetched, useUsageStatus } from "../lib/useUsage";
import { useDaily } from "../lib/useDaily";
import { loadWrapped } from "../lib/wrappedLoad";
import { buildSlides, rangeHint, rangeLabel } from "../lib/wrappedModel";
import { compact, modelLabel, plural } from "../lib/usage";
import { useAtlas } from "../state/AtlasProvider";
import { PageTitle } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { IndexProgress } from "../components/IndexProgress";
import { Topo } from "../components/Topo";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { Num, Words } from "../components/wrapped/motion";
import { Story } from "../components/wrapped/Story";
import type { WrappedData } from "../lib/wrappedModel";

/** The first page of the story: the one number, then how far back it honestly goes. */
function Cover({ d }: { d: WrappedData }) {
  return (
    <section aria-label="Your Claude Code so far" className="wr-slide relative isolate overflow-hidden" data-tone="accent">
      <Topo seed={23} />
      <div className="relative flex flex-col gap-3">
        <div className="wr-kicker wr-in" style={{ "--s": 0 } as CSSProperties}>
          Your Claude Code so far
        </div>
        <div className="wr-cover-num">
          <Num text={compact(d.tokens)} delay={160} className="d d-hero wr-cover-fig text-ink" />
        </div>
        <div className="text-subtitle text-ink wr-in" style={{ "--s": 4 } as CSSProperties}>
          tokens so far
        </div>
        <p className="wr-line">
          <Words
            text={`${plural(d.sessions, "session")}. ${plural(d.activeDays, "active day")}.${d.streak > 1 ? ` ${plural(d.streak, "day")} in a row right now.` : ""} Ready?`}
          />
        </p>
        <p className="wr-aside wr-in" style={{ "--s": 9 } as CSSProperties} title={rangeHint(d)} tabIndex={0}>
          {rangeLabel(d)}
        </p>
      </div>
    </section>
  );
}

export function Wrapped() {
  const backend = getBackend();
  const { info } = useAtlas();
  const { status, progress } = useUsageStatus();
  const daily = useDaily(info.config?.dir ?? null);
  const wrapped = useFetched(() => (daily ? loadWrapped(daily, modelLabel) : Promise.resolve(null)), [backend, daily]);

  const d = wrapped.data;
  const slides = useMemo(() => (d ? buildSlides(d) : []), [d]);

  const waiting = daily === null || (wrapped.loading && !d);
  const notReady = cacheNotReady(status);

  if (wrapped.error && !d) {
    return (
      <div className="@container">
        <PageTitle title="Wrapped" />
        <ErrorBlock title="Could not build your story" message={wrapped.error} onRetry={() => wrapped.reload(false)} />
      </div>
    );
  }

  if (!d && (waiting || notReady)) {
    return (
      <div className="@container flex flex-col gap-4">
        <PageTitle title="Wrapped" />
        <IndexProgress status={status} progress={progress} />
        <Skeleton className="h-72" />
      </div>
    );
  }

  if (!d) {
    return (
      <div className="@container flex min-h-0 flex-1 flex-col">
        <PageTitle title="Wrapped" />
        <EmptyState
          fill
          seed={23}
          icon={MapTrifold}
          title="Nothing to tell yet"
          body="Once you have used Claude Code, the story of how you use it shows up here."
        />
      </div>
    );
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <PageTitle title="Wrapped" />
      <Story cover={<Cover d={d} />} slides={slides} />
    </div>
  );
}
