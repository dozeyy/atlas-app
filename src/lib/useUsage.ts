// React glue for the usage engine: live status, a fetch hook that never shows a
// stale answer, and a reload trigger for "the numbers changed".

import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "./ipc";
import type { IndexProgress, UsageStatus } from "./types";

function message(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong reading your usage.";
}

/** Subscribe to a Tauri-style event for the life of the component. */
function useEvent<T>(subscribe: (cb: (v: T) => void) => Promise<() => void>, cb: (v: T) => void): void {
  const latest = useRef(cb);
  latest.current = cb;
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    subscribe((v) => alive && latest.current(v))
      .then((fn) => {
        if (alive) off = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
    // `subscribe` is a stable method of the backend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * True while the cache cannot answer yet because the engine is still starting or doing
 * its first read. A failed question in that window is not an error to show: the numbers
 * arrive on their own (the status and changed events reload the page).
 */
export function cacheNotReady(status: UsageStatus | null): boolean {
  if (status === null) return true;
  return status.state === "recovering" || (status.state === "indexing" && !status.firstIndexDone);
}

export function useUsageStatus(): { status: UsageStatus | null; progress: IndexProgress | null } {
  const backend = getBackend();
  const [status, setStatus] = useState<UsageStatus | null>(null);
  const [progress, setProgress] = useState<IndexProgress | null>(null);

  useEffect(() => {
    let alive = true;
    backend
      .usageStatus()
      .then((s) => alive && setStatus((cur) => cur ?? s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [backend]);

  useEvent(
    (cb) => backend.onUsageStatus(cb),
    (s: UsageStatus) => {
      setStatus(s);
      if (s.state !== "indexing") setProgress(null);
    },
  );
  useEvent((cb) => backend.onUsageProgress(cb), setProgress);
  return { status, progress };
}

export interface Fetched<T> {
  data: T | null;
  error: string | null;
  /** True until the first answer (or error) arrives. */
  loading: boolean;
  /** When the numbers on screen arrived (ms since epoch), null before the first answer. */
  at: number | null;
  reload: (silent?: boolean) => void;
}

/**
 * Run `fn` now and whenever `deps` change. A slower, older answer never replaces a
 * newer one. A silent reload keeps the numbers on screen while it runs and keeps
 * them if it fails.
 */
export function useFetched<T>(fn: () => Promise<T>, deps: unknown[]): Fetched<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean; at: number | null }>({
    data: null,
    error: null,
    loading: true,
    at: null,
  });
  const seq = useRef(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  const reload = useCallback((silent = false) => {
    const id = ++seq.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    fnRef
      .current()
      .then((data) => id === seq.current && setState({ data, error: null, loading: false, at: Date.now() }))
      .catch((e) => {
        if (id !== seq.current) return;
        setState((s) => (silent && s.data ? s : { data: null, error: message(e), loading: false, at: null }));
      });
  }, []);

  useEffect(() => {
    reload(false);
    return () => {
      seq.current++; // drop an answer that arrives after unmount or a dependency change
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload };
}

/**
 * Call `reload(true)` when the engine says the numbers moved: a session changed on
 * disk, or an indexing pass finished. Bursts collapse into one reload.
 */
export function useLiveReload(reload: (silent: boolean) => void): void {
  const backend = getBackend();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIndexed = useRef<number | null | undefined>(undefined);

  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => reload(true), 250);
  }, [reload]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEvent((cb) => backend.onUsageChanged(cb), soon);
  useEvent(
    (cb) => backend.onUsageStatus(cb),
    (s: UsageStatus) => {
      // The first event also counts: the page may have asked before the first pass ended.
      if (s.state !== "indexing" && s.lastIndexedAt !== lastIndexed.current) soon();
      lastIndexed.current = s.lastIndexedAt;
    },
  );
}

export function describeError(e: string | null): string {
  return e ?? "Something went wrong reading your usage.";
}
