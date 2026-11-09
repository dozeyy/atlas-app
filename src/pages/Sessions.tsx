import { useEffect, useMemo, useState } from "react";
import { ArrowsDownUp, ChatsCircle } from "@phosphor-icons/react";
import { Button, Card, PageTitle } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { IndexProgress } from "../components/IndexProgress";
import { FilterLines } from "../components/icons";
import { ChoiceList, OptionField, OptionsMenu } from "../components/OptionsMenu";
import { SessionGrid, SessionLine } from "../components/usage/SessionList";
import { SearchField, SelectField } from "../components/usage/fields";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { SessionDetailView } from "./SessionDetail";
import { useAtlas } from "../state/AtlasProvider";
import { getBackend } from "../lib/ipc";
import { clearPendingSession, peekPendingSession } from "../lib/nav";
import { useChatSearch, useDebounced } from "../lib/useChatSearch";
import type { ChatSearch } from "../lib/useChatSearch";
import { cacheNotReady, useFetched, useLiveReload, useUsageStatus } from "../lib/useUsage";
import { addDays, exact, localDay, modelLabel, plural } from "../lib/usage";
import type { SessionPage, SessionQuery, SessionRow } from "../lib/types";

const PAGE = 50;
/** Titles and projects are filtered this soon after the last keystroke. Message text waits a little longer (useChatSearch). */
const TITLE_DEBOUNCE_MS = 60;

const SORTS = {
  newest: { sort: "started", dir: "desc", label: "Newest first" },
  oldest: { sort: "started", dir: "asc", label: "Oldest first" },
  tokens: { sort: "tokens", dir: "desc", label: "Most tokens" },
  longest: { sort: "duration", dir: "desc", label: "Longest" },
} as const;
type SortKey = keyof typeof SORTS;
const SORT_CHOICES = (Object.keys(SORTS) as SortKey[]).map((value) => ({ value, label: SORTS[value].label }));

const SPANS = [
  { value: "all", label: "All time", days: 0 },
  { value: "7", label: "Last 7 days", days: 6 },
  { value: "30", label: "Last 30 days", days: 29 },
  { value: "90", label: "Last 90 days", days: 89 },
];

/** The quiet line under the toolbar while searching inside chats cannot yet cover everything. */
function searchNote(chat: ChatSearch): string | null {
  if (chat.error) return "Searching inside chats did not work just now. Titles and projects still do.";
  const ix = chat.index;
  if (!ix || ix.ready) return null;
  if (ix.state === "error") return "Searching inside chats is not available right now. Titles and projects still work.";
  if (ix.filesTotal > 0) return `Still reading your chats so search can look inside them: ${exact(ix.filesDone)} of ${exact(ix.filesTotal)} files. More results appear as it goes.`;
  return "Getting search ready. Words inside chats start to match in a moment.";
}

export function Sessions() {
  const backend = getBackend();
  const { info } = useAtlas();
  const { status, progress } = useUsageStatus();

  const [selected, setSelected] = useState<string | null>(() => peekPendingSession());
  useEffect(() => clearPendingSession(), []);

  const [text, setText] = useState("");
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [span, setSpan] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const typed = text.trim();
  const titleQ = useDebounced(typed, TITLE_DEBOUNCE_MS);
  const chat = useChatSearch(text);

  const options = useFetched(() => backend.usageFilterOptions(), [info.config?.projectsDir ?? null]);
  useLiveReload(options.reload);

  const query = useMemo<SessionQuery>(() => {
    const days = SPANS.find((s) => s.value === span)?.days ?? 0;
    return {
      text: titleQ || null,
      // Chats whose messages match are listed too, whatever their title says.
      alsoIds: chat.ids,
      projects: project ? [project] : [],
      models: model ? [model] : [],
      from: days > 0 ? addDays(localDay(new Date()), -days) : null,
      to: null,
      includeMissing: true,
      sort: SORTS[sortKey].sort,
      dir: SORTS[sortKey].dir,
      limit: PAGE,
    };
  }, [titleQ, chat.ids, project, model, span, sortKey]);

  const first = useFetched(() => backend.sessionsList(query), [JSON.stringify(query), info.config?.projectsDir ?? null]);
  useLiveReload(first.reload);

  // Every chat there is: the "of N" in the count when the list is narrowed.
  const everything = useFetched(() => backend.sessionsList({ includeMissing: true, limit: 1 }), [info.config?.projectsDir ?? null]);
  useLiveReload(everything.reload);

  // Pages after the first are kept here, tied to the first page they follow: a new query
  // or a refresh produces a new first page, which drops them without an effect and so
  // without a render where the count and the "Show more" button disagree.
  const [tail, setTail] = useState<{ base: SessionPage | null; rows: SessionRow[]; cursor: string | null; error: string | null }>({
    base: null,
    rows: [],
    cursor: null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const live = tail.base !== null && tail.base === first.data;
  const more = live ? tail.rows : [];
  const cursor = live ? tail.cursor : (first.data?.nextCursor ?? null);
  const moreError = live ? tail.error : null;

  const loadMore = () => {
    const base = first.data;
    if (!cursor || !base) return;
    setBusy(true);
    backend
      .sessionsList({ ...query, cursor })
      .then((p) => setTail({ base, rows: [...more, ...p.rows], cursor: p.nextCursor, error: null }))
      .catch((e) => setTail({ base, rows: more, cursor, error: e instanceof Error ? e.message : String(e) }))
      .finally(() => setBusy(false));
  };

  const rows = [...(first.data?.rows ?? []), ...more];
  const total = first.data?.total ?? 0;
  const filtered = Boolean(typed || project || model || span !== "all");
  // The answer for what is typed is still on its way: an empty list now is not yet "no match".
  const settling = filtered && (first.loading || chat.pending);
  // What differs from the defaults: shown as the badge on the Filter button. Sort has no badge.
  const changed = [project, model, span !== "all"].filter(Boolean).length;
  const resetFilters = () => {
    setProject("");
    setModel("");
    setSpan("all");
  };
  const clear = () => {
    setText("");
    resetFilters();
  };
  const firstIndex = status?.state === "indexing" && !status.firstIndexDone;
  const note = typed.length >= 2 ? searchNote(chat) : null;

  const count = first.data
    ? filtered
      ? `${exact(total)} of ${plural(Math.max(everything.data?.total ?? total, total), "chat")}`
      : plural(total, "chat")
    : "";

  return (
    <>
      <PageTitle title="Sessions" />
      <IndexProgress status={status} progress={progress} onRetry={() => void backend.usageReindex("changed").catch(() => {})} />

      {selected && <SessionDetailView id={selected} onBack={() => setSelected(null)} />}

      <div hidden={selected !== null}>
        <div className="toolbar-tall mb-4 flex items-center gap-2">
          <SearchField tall value={text} onChange={setText} label="Search chats" placeholder="Search titles, projects and messages" />
          <span aria-live="polite" className="min-w-[4.5rem] shrink-0 whitespace-nowrap px-1 text-caption tabular-nums text-ink-2">
            {count}
          </span>
          <OptionsMenu label="Filter" icon={<FilterLines size={18} />} count={changed} onReset={resetFilters}>
            <OptionField label="Project">
              <SelectField
                wide
                label="Project"
                value={project}
                onChange={setProject}
                options={[
                  { value: "", label: "All projects" },
                  ...(options.data?.projects ?? []).map((p) => ({ value: p.projectKey, label: p.name })),
                ]}
              />
            </OptionField>
            <OptionField label="Model">
              <SelectField
                wide
                label="Model"
                value={model}
                onChange={setModel}
                options={[
                  { value: "", label: "All models" },
                  ...(options.data?.models ?? []).map((m) => ({ value: m.model, label: modelLabel(m.model) })),
                ]}
              />
            </OptionField>
            <OptionField label="Time">
              <SelectField wide label="Time span" value={span} onChange={setSpan} options={SPANS.map((s) => ({ value: s.value, label: s.label }))} />
            </OptionField>
          </OptionsMenu>
          <OptionsMenu label="Sort" status={SORTS[sortKey].label} icon={<ArrowsDownUp size={18} aria-hidden="true" />} width={200}>
            {(close) => <ChoiceList label="Sort order" value={sortKey} choices={SORT_CHOICES} onChange={setSortKey} onPick={close} />}
          </OptionsMenu>
        </div>
        {note && (
          <p role="status" className="-mt-2 mb-3 text-caption text-ink-2">
            {note}
          </p>
        )}

        {info.config === null ? (
          <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
            Waiting for your Claude folder. Your sessions appear here as soon as it is ready.
          </p>
        ) : first.error && !cacheNotReady(status) ? (
          <ErrorBlock title="Could not load your sessions" message={first.error} onRetry={() => first.reload(false)} />
        ) : ((first.loading || first.error) && !first.data) || (total === 0 && settling) ? (
          <Card>
            <div role="status" aria-label="Loading sessions" className="divide-y divide-line">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="px-5 py-3">
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="mt-2 h-3 w-1/3" />
                </div>
              ))}
            </div>
          </Card>
        ) : total === 0 && firstIndex ? (
          <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
            Sessions appear here as Atlas reads your files.
          </p>
        ) : total === 0 && filtered ? (
          <EmptyState
            icon={ChatsCircle}
            seed={11}
            className="min-h-[max(320px,calc(100vh-14.5rem))]"
            title="No chats match"
            body="Nothing fits the search and filters you set. Loosen them or start again."
          >
            <Button onClick={clear}>Clear filters</Button>
          </EmptyState>
        ) : total === 0 ? (
          <EmptyState
            icon={ChatsCircle}
            seed={11}
            className="min-h-[max(320px,calc(100vh-14.5rem))]"
            title="No sessions yet"
            body="Each Claude Code conversation shows up here with the tokens it used, when it ran and which project it belonged to."
          />
        ) : (
          <Card>
            <SessionGrid>
              {rows.map((r, i) => (
                <SessionLine key={r.sessionId} row={r} onOpen={setSelected} index={i < PAGE ? i : 0} snippet={chat.snippets.get(r.sessionId)} />
              ))}
            </SessionGrid>
            {(cursor || moreError) && (
              <div className="flex items-center gap-3 border-t border-line px-5 py-3">
                <Button onClick={loadMore} disabled={busy}>
                  {busy ? "Loading..." : "Show more"}
                </Button>
                <span className="text-caption text-ink-2">{`Showing ${rows.length} of ${total}`}</span>
                {moreError && (
                  <span role="alert" className="text-caption text-danger">
                    {moreError}
                  </span>
                )}
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
