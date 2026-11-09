import { useMemo } from "react";
import { MapTrifold } from "@phosphor-icons/react";
import { getBackend } from "../lib/ipc";
import { cacheNotReady, useFetched, useUsageStatus } from "../lib/useUsage";
import { useDaily } from "../lib/useDaily";
import { loadWrapped } from "../lib/wrappedLoad";
import { buildSlides } from "../lib/wrappedModel";
import { modelLabel } from "../lib/usage";
import { useAtlas } from "../state/AtlasProvider";
import { PageTitle } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { IndexProgress } from "../components/IndexProgress";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { Story } from "../components/wrapped/Story";

export function Wrapped() {
  const backend = getBackend();
  const { info, goBack } = useAtlas();
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
      <Story slides={slides} onLeave={goBack} />
    </div>
  );
}
