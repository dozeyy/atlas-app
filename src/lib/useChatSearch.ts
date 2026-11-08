import { useEffect, useMemo, useRef, useState } from "react";
import { getBackend } from "./ipc";
import type { SearchStatus, SnippetPart } from "./searchTypes";

/** Message text is searched from this many typed characters; shorter text matches titles only. */
export const CHAT_SEARCH_MIN_CHARS = 2;
/** How long typing must pause before the engine is asked (titles are filtered sooner). */
export const CHAT_SEARCH_DEBOUNCE_MS = 150;
const PAGE = 50; // the engine's cap per call
const EXTRA_PAGES = 3; // when the first page is full, up to this many more are read, together

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface ChatSearch {
  /** Sessions with a matching message, best match first. Empty until the answer for `text` is in. */
  ids: string[];
  /** One snippet per session: the best-ranked matching message, matched words marked. */
  snippets: Map<string, SnippetPart[]>;
  /** True from the first keystroke of a 2+ character search until its answer lands. */
  pending: boolean;
  /** Set when the search itself failed; titles still work, so the page says so quietly. */
  error: string | null;
  /** The message index's state, for the "still building" line. Null until the first answer. */
  index: SearchStatus | null;
}

const NONE = { ids: [] as string[], snippets: new Map<string, SnippetPart[]>() };

/**
 * Search inside chats as the person types. The newest query wins: an answer for an older one is
 * dropped. The engine is asked for the first page, and, when that page is full, for a few more
 * at once, so the list of chats is not cut off after the first fifty messages.
 */
export function useChatSearch(text: string): ChatSearch {
  const backend = getBackend();
  const typed = text.trim();
  const q = useDebounced(typed, CHAT_SEARCH_DEBOUNCE_MS);
  const active = [...q].length >= CHAT_SEARCH_MIN_CHARS;

  const [index, setIndex] = useState<SearchStatus | null>(null);
  const [answer, setAnswer] = useState<{ q: string; ids: string[]; snippets: Map<string, SnippetPart[]>; error: string | null } | null>(null);
  const seq = useRef(0);

  // The index's state: asked once, then followed.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | null = null;
    backend
      .searchStatus()
      .then((s) => alive && setIndex(s))
      .catch(() => {});
    backend
      .onSearchStatus((s) => alive && setIndex(s))
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [backend]);

  // Asked again when the index finishes a pass, so results fill in as chats are read.
  const indexedAt = index?.lastIndexedAt ?? null;
  const ready = index?.ready ?? false;

  useEffect(() => {
    const id = ++seq.current;
    if (!active) {
      setAnswer(null);
      return;
    }
    const fold = (pages: Awaited<ReturnType<typeof backend.searchChats>>[]) => {
      const ids: string[] = [];
      const snippets = new Map<string, SnippetPart[]>();
      for (const p of pages)
        for (const h of p.hits)
          if (!snippets.has(h.sessionId)) {
            ids.push(h.sessionId);
            snippets.set(h.sessionId, h.snippet);
          }
      return { ids, snippets };
    };
    const fail = (e: unknown) => {
      if (id === seq.current) setAnswer({ q, ...NONE, error: e instanceof Error ? e.message : String(e) });
    };
    backend
      .searchChats(q, PAGE, 0)
      .then((first) => {
        if (id !== seq.current) return;
        setAnswer({ q, ...fold([first]), error: null });
        if (!first.hasMore) return;
        return Promise.all(Array.from({ length: EXTRA_PAGES }, (_, i) => backend.searchChats(q, PAGE, PAGE * (i + 1)))).then((more) => {
          if (id === seq.current) setAnswer({ q, ...fold([first, ...more]), error: null });
        });
      })
      .catch(fail);
    return () => {
      seq.current++;
    };
  }, [backend, q, active, indexedAt, ready]);

  // While a newer query is on its way the previous answer stays up, so the list does not
  // flicker narrower and wider on every keystroke; it is replaced the moment the new one lands.
  const wants = [...typed].length >= CHAT_SEARCH_MIN_CHARS;
  const shown = wants ? answer : null;
  return useMemo(
    () => ({
      ids: shown?.ids ?? NONE.ids,
      snippets: shown?.snippets ?? NONE.snippets,
      pending: wants && (typed !== q || shown?.q !== q),
      error: shown?.error ?? null,
      index,
    }),
    [shown, wants, typed, q, index],
  );
}
