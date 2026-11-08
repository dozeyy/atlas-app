import { useMemo, useState } from "react";
import { MapTrifold, Play } from "@phosphor-icons/react";
import { getBackend } from "../lib/ipc";
import { cacheNotReady, useFetched, useUsageStatus } from "../lib/useUsage";
import { useDaily } from "../lib/useDaily";
import { loadWrapped } from "../lib/wrappedLoad";
import { buildSlides, coverageLine } from "../lib/wrappedModel";
import { compact, exact, modelLabel, plural } from "../lib/usage";
import { useAtlas } from "../state/AtlasProvider";
import { Button, PageTitle } from "../components/controls";
import { CountUp } from "../components/CountUp";
import { EmptyState } from "../components/EmptyState";
import { IndexProgress } from "../components/IndexProgress";
import { Topo } from "../components/Topo";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { SlideCard } from "../components/wrapped/Slide";
import { Story } from "../components/wrapped/Story";
import type { WrappedData } from "../lib/wrappedModel";

const rise = (n: number) => ({ ["--i" as string]: n });

function Cover({ d, onPlay }: { d: WrappedData; onPlay: () => void }) {
  return (
    <section aria-label="Your Claude Code so far" className="rise relative isolate overflow-hidden rounded-card border border-line bg-surface px-6 py-7 @[740px]:px-9 @[740px]:py-9" style={rise(1)}>
      <Topo seed={23} />
      <div className="relative flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0">
          <CountUp value={d.tokens} format={compact} id="wrapped:tokens" className="d d-hero text-ink" />
          <div className="mt-1 text-subtitle text-ink">tokens so far</div>
          <p className="mt-3 text-body text-ink-2">
            {plural(d.sessions, "session")} on {plural(d.activeDays, "active day")}
            {d.streak > 1 ? `, ${plural(d.streak, "day")} in a row right now` : ""}.
          </p>
          <p className="mt-1 max-w-[62ch] text-caption text-ink-2">{coverageLine(d)}</p>
        </div>
        <Button variant="primary" onClick={onPlay}>
          <Play size={14} weight="fill" aria-hidden="true" />
          Play the story
        </Button>
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
  const [story, setStory] = useState<number | null>(null);

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
        <Skeleton className="h-44" />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4">
          <Skeleton className="h-60" />
          <Skeleton className="h-60" />
          <Skeleton className="h-60" />
        </div>
      </div>
    );
  }

  if (!d) {
    return (
      <div className="@container flex flex-1 flex-col">
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
    <div className="@container flex flex-1 flex-col gap-4">
      <PageTitle title="Wrapped" />
      <Cover d={d} onPlay={() => setStory(0)} />

      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-4" aria-label={`${exact(slides.length)} slides`} role="list">
        {slides.map((s, i) => (
          <div key={s.id} role="listitem" className="contents">
            <SlideCard slide={s} index={i} onOpen={() => setStory(i)} />
          </div>
        ))}
      </div>

      {story !== null && <Story slides={slides} start={story} onClose={() => setStory(null)} />}
    </div>
  );
}
