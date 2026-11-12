import { useMemo } from "react";
import { Info } from "@phosphor-icons/react";
import { Card } from "../controls";
import { Skeleton } from "./StateBlocks";
import { getBackend } from "../../lib/ipc";
import { LIFETIME_NOTE, lifetimeView } from "../../lib/lifetimeModel";
import { useDayChange } from "../../lib/today";
import { compact, exact } from "../../lib/usage";
import { useFetched, useLiveReload } from "../../lib/useUsage";
import type { Daily } from "../../lib/useDaily";

/** The totals ask over all history, so a chat that is being written reloads them at most this often. */
const RELOAD_EVERY_MS = 5000;

/** A figure and what it counts, on one line. The figure is the hover target (it reads out in full on focus). */
function Stat({ value, label, tip, hidden }: { value: string; label: string; tip: string; hidden?: string }) {
  return (
    <span className="whitespace-nowrap">
      <b tabIndex={0} title={tip} className="d d-small text-ink">
        {value}
      </b>{" "}
      <span className="text-body text-ink-2">{label}</span>
      {hidden && <span className="sr-only">{hidden}</span>}
    </span>
  );
}

/**
 * "All time": everything since the first recorded day, as one quiet row. The totals are one query
 * (`usage_lifetime`, the CLI's `all` scope) that starts once the page's own numbers are on screen
 * and asks again only when the engine says they moved (at most every few seconds). The streak is
 * the Dashboard's own (`useDaily`), passed in; the record is the same streak code run over every
 * day. The two streak figures show together, and only when both were counted up to the same
 * day (they refresh separately at midnight); the totals never wait for them.
 * A failed or empty answer shows nothing: the page's other cards already say what is wrong.
 */
export function LifetimeStrip({ daily }: { daily: Daily | null }) {
  const backend = getBackend();
  const life = useFetched(() => backend.usageLifetime(), []);
  useLiveReload(life.reload, RELOAD_EVERY_MS);
  useDayChange(() => life.reload(true)); // "today" in the totals moves at midnight
  const streak = daily && life.data && daily.today === life.data.today ? daily.streak : null;
  const view = useMemo(() => (life.data ? lifetimeView(life.data, streak ?? 0) : null), [life.data, streak]);

  if (life.error || (life.data && !view)) return null;
  return (
    <section aria-label="All time" className="rise min-w-0 [--i:8]">
      <Card className="px-5 py-3">
        {!view ? (
          <div role="status" aria-label="Loading all-time numbers">
            <Skeleton className="h-6 w-3/4 max-w-[640px]" />
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
            <h2 className="h-section">All time</h2>
            <span tabIndex={0} title={LIFETIME_NOTE} aria-label={`Since ${view.since}. ${LIFETIME_NOTE}`} className="inline-flex cursor-help items-baseline gap-1.5 text-body text-ink-2">
              <span>{`Since ${view.since}`}</span>
              <Info size={14} aria-hidden="true" className="self-center" />
            </span>
            <Stat value={compact(view.tokens)} label="tokens" tip={view.tokensTip} />
            <Stat value={exact(view.sessions)} label={view.sessions === 1 ? "session" : "sessions"} tip={view.sessionsTip} />
            {view.busiest && (
              <Stat value={compact(view.busiest.tokens)} label={`busiest day, ${view.busiest.day}`} tip={view.busiest.tip} />
            )}
            {view.favorite && <Stat value={view.favorite.label} label="favorite model" tip={view.favorite.tip} />}
            {streak !== null && (
              <>
                <Stat value={String(streak)} label="day streak" tip="Days in a row with usage, counted up to today (or yesterday while today is still empty)." />
                <Stat value={String(view.longest)} label="longest" tip={view.longestTip} hidden=" day streak" />
              </>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
