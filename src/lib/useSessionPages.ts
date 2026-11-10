// The Sessions list, page by page. One loader owns every page on screen: a new query starts at
// page one; "Show more" adds the next page; a refresh (the engine says a chat changed, or an
// indexing pass ended) walks the SAME number of pages again, so the list never shrinks back to
// its first page under the reader. The newest request always wins; an older answer is dropped.

import { useCallback, useEffect, useRef, useState } from "react";
import { getBackend } from "./ipc";
import type { SessionPage, SessionQuery, SessionRow } from "./types";

/** Rows per page. The engine caps one page at 200, so a long list is read as pages, never as one ask. */
export const PAGE = 50;

export interface Loaded<Tag> {
  /** The query these pages answer (its JSON). */
  key: string;
  /** Whatever the page wants to remember about the query that was asked (its order, a search). */
  tag: Tag;
  rows: SessionRow[];
  /** Where the next page starts; null when every row is on screen. */
  cursor: string | null;
  /** How many rows the query matches in all. */
  total: number;
  pages: number;
}

export interface SessionPages<Tag> {
  data: Loaded<Tag> | null;
  /** True until the first answer (or error) for the current query arrives. */
  loading: boolean;
  /** The current query failed and nothing can be shown. */
  error: string | null;
  /** "Show more" is on its way. */
  busy: boolean;
  /** The last "Show more" failed; what was shown stays. */
  moreError: string | null;
  loadMore: () => void;
  /** Read every loaded page again. Silent keeps the rows on screen while it runs and if it fails. */
  reload: (silent?: boolean) => void;
}

function message(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return "Something went wrong reading your usage.";
}

/** Rows appended to a list, skipping any already in it: between two pages a chat can move. */
function append(have: SessionRow[], more: SessionRow[]): SessionRow[] {
  const seen = new Set(have.map((r) => r.sessionId));
  const fresh = more.filter((r) => !seen.has(r.sessionId));
  return fresh.length === 0 ? have : [...have, ...fresh];
}

/**
 * `query` is asked for again whenever `key` (its JSON) or `deps` change; the pages shown are tagged
 * with `tag` as it was when they were asked for, so a page on its way does not change how the one
 * on screen is laid out.
 */
export function useSessionPages<Tag>(query: SessionQuery, key: string, tag: Tag, deps: unknown[]): SessionPages<Tag> {
  const backend = getBackend();
  const [data, setData] = useState<Loaded<Tag> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const seq = useRef(0);
  /** Pages wanted for the current key. "Show more" raises it; a refresh reads this many again. */
  const wanted = useRef(1);
  const latest = useRef({ query, key, tag, data });
  latest.current = { query, key, tag, data };

  /**
   * Read pages until `wanted` of them are on screen. `from` continues after what is shown (one
   * more page); without it the walk starts over from page one with what is on screen left in
   * place until the last page lands.
   */
  const walk = useCallback(
    (silent: boolean, from: Loaded<Tag> | null) => {
      const id = ++seq.current;
      const { query: q, key: k, tag: t } = latest.current;
      const run = async () => {
        let rows = from?.rows ?? [];
        let cursor = from?.cursor ?? null;
        let pages = from?.pages ?? 0;
        let total = from?.total ?? 0;
        do {
          const p: SessionPage = await backend.sessionsList({ ...q, cursor: pages === 0 ? null : cursor, limit: PAGE });
          if (id !== seq.current) return;
          rows = pages === 0 ? p.rows : append(rows, p.rows);
          cursor = p.nextCursor;
          total = p.total;
          pages++;
        } while (pages < wanted.current && cursor !== null);
        setData({ key: k, tag: t, rows, cursor, total, pages });
        setLoading(false);
        setError(null);
        setBusy(false);
        setMoreError(null);
      };
      run().catch((e: unknown) => {
        if (id !== seq.current) return;
        setBusy(false);
        if (from) {
          // The page never came: a refresh reads only what is on screen, not the page that failed.
          wanted.current = from.pages;
          setMoreError(message(e));
        } else if (!(silent && latest.current.data)) {
          setData(null);
          setError(message(e));
          setLoading(false);
        }
      });
    },
    [backend],
  );

  useEffect(() => {
    wanted.current = 1;
    setLoading(true);
    setError(null);
    setBusy(false);
    setMoreError(null);
    walk(false, null);
    return () => {
      seq.current++; // an answer for the old query is dropped
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, walk, ...deps]);

  const reload = useCallback(
    (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      walk(silent, null);
    },
    [walk],
  );

  const loadMore = useCallback(() => {
    const d = latest.current.data;
    if (!d || d.key !== latest.current.key || d.cursor === null) return;
    wanted.current = d.pages + 1;
    setBusy(true);
    setMoreError(null);
    walk(true, d);
  }, [walk]);

  // While a new query's answer is on its way the old pages stay on screen, laid out as what they
  // are (their own tag); `loadMore` continues only pages that answer the current query.
  return { data, loading, error, busy, moreError, loadMore, reload };
}
