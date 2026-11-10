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

/** The story's own shape while it is read: the trail, the sheet, Back and Next. Nothing jumps when it lands. */
function StorySkeleton() {
  return (
    <div className="sm-story" aria-hidden="true">
      <div className="sm-trail">
        <i className="sm-trail-track" />
      </div>
      <div className="sm-skel pulse-dot" />
      <div className="sm-foot">
        <Skeleton className="h-8 w-20" />
        <span />
        <Skeleton className="h-8 w-20" />
      </div>
    </div>
  );
}

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
    // When the usage engine has failed there is nothing on its way: the message and its one way
    // forward stand alone, with no placeholder under them promising a story.
    const failed = status?.state === "error";
    return (
      <div className="@container flex min-h-0 flex-1 flex-col">
        <PageTitle title="Wrapped" />
        <IndexProgress
          status={status}
          progress={progress}
          onRetry={() => void backend.usageReindex("changed").catch(() => {})}
        />
        {!failed && <StorySkeleton />}
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
