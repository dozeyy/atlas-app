// React glue for the usage engine: live status, a fetch hook that never shows a
// stale answer, and a reload trigger for "the numbers changed".

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/**
 * Ask again, before the browser paints, the moment the cache turns ready (the first read or a
 * recovery finished). A question asked earlier may have failed with "not ready yet", and the
 * status turns ready about 250 ms before the live reload lands: that stale failure showed as
 * "Could not load your usage" for half a second on a first launch. A non-silent reload clears
 * it in the same pass (a layout effect runs before paint), so that frame shows the loading
 * state instead. A question asked once the cache is ready that still fails stays on screen.
 * From an unknown status (null, the first render) only a failure is asked again, so a normal
 * launch does not drop and repeat its first question.
 */
export function useReadyRetry(
  status: UsageStatus | null,
  f: { error: string | null; loading: boolean; reload: (silent?: boolean) => void },
): void {
  const notReady = cacheNotReady(status);
  const was = useRef<"unknown" | "waiting" | "ready">(status === null ? "unknown" : notReady ? "waiting" : "ready");
  useLayoutEffect(() => {
    const before = was.current;
    was.current = status === null ? "unknown" : notReady ? "waiting" : "ready";
    if (notReady || before === "ready") return;
    if (f.error !== null || (before === "waiting" && f.loading)) f.reload(false);
  });
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
 * `every` is for a heavy question over all history: instead of waiting for a quiet moment
 * (a chat that is being written never has one) it reloads at most once per `every` ms.
 */
export function useLiveReload(reload: (silent: boolean) => void, every?: number): void {
  const backend = getBackend();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastIndexed = useRef<number | null | undefined>(undefined);

  const soon = useCallback(() => {
    if (every !== undefined) {
      if (timer.current) return; // one is already on its way
      timer.current = setTimeout(() => {
        timer.current = null;
        reload(true);
      }, every);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => reload(true), 250);
  }, [reload, every]);

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
