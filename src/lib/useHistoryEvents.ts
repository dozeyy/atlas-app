import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "./ipc";
import type { HistoryEvent, HistoryGroup } from "./historyTypes";

export const PAGE = 40;

export interface EventFilter {
  group: HistoryGroup | "all";
  project: string;
  text: string;
}

export interface EventList {
  events: HistoryEvent[];
  /** More pages exist. */
  more: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  /** Fetch again without blanking the list (the worker found something). */
  refresh: () => void;
  /** Start over after a failed first load. */
  retry: () => void;
}

const older = (a: HistoryEvent, b: HistoryEvent) => a.at < b.at || (a.at === b.at && a.id < b.id);

/**
 * Pages of changes, newest first, 40 at a time. A new filter starts over; `refresh` re-reads the
 * first page and keeps whatever older pages were already open.
 */
export function useHistoryEvents(filter: EventFilter, epoch: unknown = null): EventList {
  const { group, project, text } = filter;
  const [tick, setTick] = useState(0);
  const busy = useRef(false);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const cursor = useRef<string | null>(null);
  cursor.current = next;
  const have = useRef<HistoryEvent[]>([]);
  have.current = events;

  const args = useCallback(
    (c?: string | null) => ({
      groups: group === "all" ? undefined : [group],
      project: project || undefined,
      text: text.trim() || undefined,
      cursor: c ?? undefined,
      limit: PAGE,
    }),
    [group, project, text],
  );

  useEffect(() => {
    const id = ++seq.current;
    busy.current = false;
    setLoadingMore(false);
    setLoading(true);
    setError(null);
    getBackend()
      .historyEvents(args())
      .then((p) => {
        if (id !== seq.current) return;
        setEvents(p.events);
        setNext(p.next);
        setLoading(false);
      })
      .catch((e) => {
        if (id !== seq.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => {
      seq.current++;
    };
    // `epoch` restarts the list when the folder being watched changes.
  }, [args, epoch, tick]);

  const loadMore = useCallback(async () => {
    const c = cursor.current;
    if (!c || busy.current) return;
    busy.current = true;
    const id = seq.current;
    setLoadingMore(true);
    try {
      const p = await getBackend().historyEvents(args(c));
      if (id !== seq.current) return;
      setEvents((cur) => [...cur, ...p.events]);
      setNext(p.next);
    } catch (e) {
      if (id === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
      if (id === seq.current) setLoadingMore(false);
    }
  }, [args]);

  const retry = useCallback(() => setTick((t) => t + 1), []);

  const refresh = useCallback(() => {
    const id = seq.current;
    getBackend()
      .historyEvents(args())
      .then((p) => {
        if (id !== seq.current) return;
        const old = have.current;
        const last = p.events[p.events.length - 1];
        const tail = last ? old.filter((e) => older(e, last)) : [];
        setEvents([...p.events, ...tail]);
        setNext(tail.length > 0 ? cursor.current : p.next);
      })
      .catch(() => {});
  }, [args]);

  return { events, more: next !== null, loading, loadingMore, error, loadMore, refresh, retry };
}
