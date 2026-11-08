import { useEffect, useMemo, useState } from "react";
import { ChatsCircle } from "@phosphor-icons/react";
import { Button, Card, PageTitle } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { IndexProgress } from "../components/IndexProgress";
import { OptionField, OptionsMenu } from "../components/OptionsMenu";
import { SessionGrid, SessionLine } from "../components/usage/SessionList";
import { SearchField, SelectField } from "../components/usage/fields";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { SessionDetailView } from "./SessionDetail";
import { useAtlas } from "../state/AtlasProvider";
import { getBackend } from "../lib/ipc";
import { clearPendingSession, peekPendingSession } from "../lib/nav";
import { cacheNotReady, useFetched, useLiveReload, useUsageStatus } from "../lib/useUsage";
import { addDays, localDay, modelLabel, plural } from "../lib/usage";
import type { SessionPage, SessionQuery, SessionRow } from "../lib/types";

const PAGE = 50;

const SORTS = {
  newest: { sort: "started", dir: "desc", label: "Newest first" },
  oldest: { sort: "started", dir: "asc", label: "Oldest first" },
  cost: { sort: "cost", dir: "desc", label: "Highest cost" },
  tokens: { sort: "tokens", dir: "desc", label: "Most tokens" },
  longest: { sort: "duration", dir: "desc", label: "Longest" },
} as const;
type SortKey = keyof typeof SORTS;

const SPANS = [
  { value: "all", label: "All time", days: 0 },
  { value: "7", label: "Last 7 days", days: 6 },
  { value: "30", label: "Last 30 days", days: 29 },
  { value: "90", label: "Last 90 days", days: 89 },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
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
  const debounced = useDebounced(text.trim(), 250);

  const options = useFetched(() => backend.usageFilterOptions(), [info.config?.projectsDir ?? null]);
  useLiveReload(options.reload);

  const query = useMemo<SessionQuery>(() => {
    const days = SPANS.find((s) => s.value === span)?.days ?? 0;
    return {
      text: debounced || null,
      projects: project ? [project] : [],
      models: model ? [model] : [],
      from: days > 0 ? addDays(localDay(new Date()), -days) : null,
      to: null,
      includeMissing: true,
      sort: SORTS[sortKey].sort,
      dir: SORTS[sortKey].dir,
      limit: PAGE,
    };
  }, [debounced, project, model, span, sortKey]);

  const first = useFetched(() => backend.sessionsList(query), [JSON.stringify(query), info.config?.projectsDir ?? null]);
  useLiveReload(first.reload);

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
  const filtered = Boolean(debounced || project || model || span !== "all");
  // What differs from the defaults: shown as the badge on the options button.
  const changed = [project, model, span !== "all", sortKey !== "newest"].filter(Boolean).length;
  const resetOptions = () => {
    setProject("");
    setModel("");
    setSpan("all");
    setSortKey("newest");
  };
  const clear = () => {
    setText("");
    resetOptions();
  };
  const firstIndex = status?.state === "indexing" && !status.firstIndexDone;

  return (
    <>
      <PageTitle title="Sessions" />
      <IndexProgress status={status} progress={progress} onRetry={() => void backend.usageReindex("changed").catch(() => {})} />

      {selected && <SessionDetailView id={selected} onBack={() => setSelected(null)} />}

      <div hidden={selected !== null}>
        <div className="mb-4 flex items-center gap-2">
          <SearchField value={text} onChange={setText} label="Search sessions" placeholder="Search by title or project" />
          <OptionsMenu label="Filters" count={changed} onReset={resetOptions}>
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
            <OptionField label="Sort by">
              <SelectField
                wide
                label="Sort"
                value={sortKey}
                onChange={(v) => setSortKey(v as SortKey)}
                options={Object.entries(SORTS).map(([value, s]) => ({ value, label: s.label }))}
              />
            </OptionField>
          </OptionsMenu>
        </div>

        {info.config === null ? (
          <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
            Waiting for your Claude folder. Your sessions appear here as soon as it is ready.
          </p>
        ) : first.error && !cacheNotReady(status) ? (
          <ErrorBlock title="Could not load your sessions" message={first.error} onRetry={() => first.reload(false)} />
        ) : (first.loading || first.error) && !first.data ? (
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
            title="No sessions match"
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
            body="Each Claude Code conversation shows up here with what it cost, how long it ran and which project it belonged to."
          />
        ) : (
          <>
            <div aria-live="polite" className="mb-2 text-caption text-ink-2">
              {plural(total, "session")}
              {filtered ? " match" : ""}
            </div>
            <Card>
              <SessionGrid>
                {rows.map((r, i) => (
                  <SessionLine key={r.sessionId} row={r} onOpen={setSelected} index={i < PAGE ? i : 0} />
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
          </>
        )}
      </div>
    </>
  );
}
