import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowsDownUp, CaretRight } from "@phosphor-icons/react";
import { Button, Card, PageTitle } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { IndexProgress } from "../components/IndexProgress";
import { FilterLines } from "../components/icons";
import { ChoiceList, OptionField, OptionsMenu } from "../components/OptionsMenu";
import { PickUp } from "../components/usage/PickUp";
import { ProjectDot, SessionGrid, SessionLine, hitParts } from "../components/usage/SessionList";
import { SearchField, SelectField } from "../components/usage/fields";
import { Skeleton } from "../components/usage/StateBlocks";
import { SessionDetailView } from "./SessionDetail";
import { useAtlas } from "../state/AtlasProvider";
import { getBackend } from "../lib/ipc";
import { clearPendingProject, clearPendingSession, onNavRequest, peekPendingProject, peekPendingSession } from "../lib/nav";
import { useChatSearch, useDebounced } from "../lib/useChatSearch";
import { useScrollbarVar } from "../lib/useScrollbarVar";
import type { ChatSearch } from "../lib/useChatSearch";
import { cacheNotReady, useFetched, useLiveReload, useReadyRetry, useUsageStatus } from "../lib/useUsage";
import { PAGE, useSessionPages } from "../lib/useSessionPages";
import { groupByDay, groupByFolder, shareOfMax } from "../lib/sessionBrowse";
import { readFolded, readGrouping, writeFolded, writeGrouping } from "../lib/sessionPrefs";
import type { Grouping } from "../lib/sessionPrefs";
import { addDays, compact, exact, formatWhen, localDay, modelChoices, plural, sumKinds, tokensTip } from "../lib/usage";
import type { SessionQuery, SessionRow } from "../lib/types";

/** Empty, no-match and error take the room the list would: the state never floats over a blank page. */
const STATE_HEIGHT = "min-h-[max(320px,calc(var(--app-h)-14.5rem))]";
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
/** Folders first (Will, 2026-11-10: "categorize each chat into which folder it was under"); the day bands stay a choice. */
const GROUP_CHOICES: { value: Grouping; label: string }[] = [
  { value: "folder", label: "By folder" },
  { value: "day", label: "By day" },
];
/** The keys the list pane walks with: rows and folder headers, in reading order. */
const NAV_KEYS = new Set(["ArrowDown", "ArrowUp", "Home", "End"]);

/** The buttons the arrow keys walk, top to bottom: every folder header and every row on screen. */
function walkable(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>("button.folder-head, button.row-btn")];
}
/**
 * What the loaded pages were asked for: their order, and whether they answer a search. While a new
 * answer is on its way the old pages stay on screen, and they have to be laid out as what they
 * are: day bands over a page sorted by tokens repeat the same day, and rows get left behind.
 */
interface PageShape {
  sort: SortKey;
  search: boolean;
}

/** Joins the ids behind one model choice in the filter's value; no model id holds a line break. */
const MODEL_SEP = "\n";

const SPANS = [
  { value: "all", label: "All time", days: 0 },
  { value: "7", label: "Last 7 days", days: 6 },
  { value: "30", label: "Last 30 days", days: 29 },
  { value: "90", label: "Last 90 days", days: 89 },
];

/** The quiet line under the toolbar while searching inside chats cannot yet cover everything. */
function searchNote(chat: ChatSearch): string | null {
  if (chat.error) return "Searching inside sessions did not work just now. Titles and projects still do.";
  const ix = chat.index;
  if (!ix || ix.ready) return null;
  if (ix.state === "error") return "Searching inside sessions is not available right now. Titles and projects still work.";
  if (ix.filesTotal > 0) return `Still reading your sessions so search can look inside them: ${exact(ix.filesDone)} of ${exact(ix.filesTotal)} files. More results appear as it goes.`;
  return "Getting search ready. Words inside sessions start to match in a moment.";
}

export function Sessions() {
  const backend = getBackend();
  const { info } = useAtlas();
  const { status, progress } = useUsageStatus();

  const [selected, setSelected] = useState<string | null>(() => peekPendingSession());
  // The list is hidden, not unmounted, while a chat is open; a hidden pane forgets its scroll, so it is kept here.
  const listPane = useRef<HTMLDivElement>(null);
  const listTop = useRef(0);
  useLayoutEffect(() => {
    if (selected === null && listPane.current) listPane.current.scrollTop = listTop.current;
  }, [selected]);
  // The list's scrollbar sits in the page's gutter, so the card is exactly as wide as the toolbar above it.
  useScrollbarVar(listPane);
  const [text, setText] = useState("");
  const [project, setProject] = useState(() => peekPendingProject() ?? "");
  useEffect(() => {
    clearPendingSession();
    clearPendingProject();
    // The quick jump can ask for a chat or a project while this page is already open.
    return onNavRequest(() => {
      const id = peekPendingSession();
      const key = peekPendingProject();
      clearPendingSession();
      clearPendingProject();
      if (id) setSelected(id);
      else if (key) {
        setSelected(null);
        setText("");
        setProject(key);
      }
    });
  }, []);
  const [model, setModel] = useState("");
  const [span, setSpan] = useState("all");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [grouping, setGroupingState] = useState<Grouping>(() => readGrouping());
  const setGrouping = (g: Grouping) => {
    setGroupingState(g);
    writeGrouping(g);
  };
  // Folders folded shut, by path; remembered between launches.
  const [folded, setFolded] = useState<Set<string>>(() => new Set(readFolded()));
  const toggleFolder = (key: string) => {
    setFolded((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      writeFolded(next);
      return next;
    });
  };
  // Arrow keys walk the headers and rows top to bottom; Left and Right fold and open a folder.
  const onPaneKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLButtonElement)) return;
    const head = target.classList.contains("folder-head") ? target : null;
    if (head && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const open = head.getAttribute("aria-expanded") === "true";
      if (open === (e.key === "ArrowLeft")) head.click();
      e.preventDefault();
      return;
    }
    if (!NAV_KEYS.has(e.key) || !listPane.current) return;
    const all = walkable(listPane.current);
    const at = all.indexOf(target);
    if (at < 0) return;
    const to = e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : e.key === "ArrowDown" ? Math.min(all.length - 1, at + 1) : Math.max(0, at - 1);
    all[to]?.focus();
    e.preventDefault();
  };
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
      models: model ? model.split(MODEL_SEP) : [],
      from: days > 0 ? addDays(localDay(new Date()), -days) : null,
      to: null,
      includeMissing: true,
      sort: SORTS[sortKey].sort,
      dir: SORTS[sortKey].dir,
      limit: PAGE,
    };
  }, [titleQ, chat.ids, project, model, span, sortKey]);

  // Every page on screen comes from one loader: a refresh (a chat changed on disk, an indexing
  // pass ended) reads the same number of pages again, so "Show more" is never undone by it.
  const shape = useMemo<PageShape>(
    () => ({ sort: sortKey, search: Boolean(query.text) || (query.alsoIds?.length ?? 0) > 0 }),
    [sortKey, query.text, query.alsoIds],
  );
  const first = useSessionPages(query, JSON.stringify(query), shape, [info.config?.projectsDir ?? null]);
  useLiveReload(first.reload);
  useReadyRetry(status, first);
  const { busy, moreError, loadMore } = first;
  const cursor = first.data?.cursor ?? null;

  // Every chat there is: the "of N" in the count when the list is narrowed.
  const everything = useFetched(() => backend.sessionsList({ includeMissing: true, limit: 1 }), [info.config?.projectsDir ?? null]);
  useLiveReload(everything.reload);

  const rows = first.data?.rows ?? [];
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

  // The newest chat gets a card of its own, but only on the plain newest-first list.
  const shownShape = first.data?.tag;
  const shownSort = shownShape?.sort ?? sortKey;
  const pick = !filtered && shownSort === "newest" && first.data && rows.length > 0 ? rows[0] : null;
  // By folder (the default): one group per project folder in every order and in a search, the
  // folder with the newest chat on top. By day: time-ordered lists fall under a band per day; the
  // other orders stay one flat list. So do search results: matches are scattered over the weeks,
  // mostly one a day, and a band per match would repeat that row's own numbers and halve how
  // many matches fit on screen.
  const byFolder = grouping === "folder";
  const byTime = !byFolder && SORTS[shownSort].sort === "started" && !(shownShape?.search ?? Boolean(typed));
  const groups = byTime ? groupByDay(rows, new Date()) : [];
  const folders = byFolder ? groupByFolder(rows) : [];
  const maxRow = Math.max(0, ...rows.map((r) => r.tokens.total));
  const maxDay = Math.max(0, ...groups.filter((_, gi) => !(gi === groups.length - 1 && cursor !== null)).map((g) => g.tokens));
  const maxFolder = Math.max(0, ...folders.map((g) => g.tokens));
  // Running index for the entrance stagger, across the day bands.
  let seen = 0;
  const line = (r: SessionRow) => {
    const i = seen++;
    return (
      <SessionLine
        key={r.sessionId}
        row={r}
        onOpen={setSelected}
        index={i < PAGE ? i : 0}
        snippet={chat.snippets.get(r.sessionId)}
        query={titleQ}
        barShare={shareOfMax(r.tokens.total, maxRow)}
        dayKnown={byTime}
        projectKnown={byFolder}
      />
    );
  };

  const count = first.data
    ? filtered
      ? `${exact(total)} of ${plural(Math.max(everything.data?.total ?? total, total), "session")}`
      : plural(total, "session")
    : "";

  return (
    <>
      {/* An open session draws its own title; a page has one. */}
      {selected === null && <PageTitle title="Sessions" />}
      <IndexProgress status={status} progress={progress} onRetry={() => void backend.usageReindex("changed").catch(() => {})} />

      {selected && (
        <SessionDetailView id={selected} onBack={() => setSelected(null)} siblings={rows.map((r) => r.sessionId)} onJump={setSelected} />
      )}

      {/* The page is one window tall: the toolbar and the pick-up card stay put and only the list scrolls. */}
      <div hidden={selected !== null} className={selected !== null ? "hidden" : "flex min-h-0 flex-1 flex-col"}>
        <div className="toolbar-tall mb-4 flex shrink-0 items-center gap-2">
          <SearchField tall value={text} onChange={setText} label="Search sessions" placeholder="Search titles, projects and messages" />
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
                  // One choice per model name: the ids that read the same are asked for together.
                  ...modelChoices((options.data?.models ?? []).map((m) => m.model)).map((c) => ({ value: c.models.join(MODEL_SEP), label: c.label })),
                ]}
              />
            </OptionField>
            <OptionField label="Time">
              <SelectField wide label="Time span" value={span} onChange={setSpan} options={SPANS.map((s) => ({ value: s.value, label: s.label }))} />
            </OptionField>
          </OptionsMenu>
          <OptionsMenu label="Sort" status={SORTS[sortKey].label} icon={<ArrowsDownUp size={18} aria-hidden="true" />} width={200}>
            {(close) => (
              <>
                <OptionField label="Order">
                  <ChoiceList label="Sort order" value={sortKey} choices={SORT_CHOICES} onChange={setSortKey} onPick={close} />
                </OptionField>
                <OptionField label="Group">
                  <ChoiceList label="Group by" value={grouping} choices={GROUP_CHOICES} onChange={setGrouping} onPick={close} />
                </OptionField>
              </>
            )}
          </OptionsMenu>
        </div>
        {note && (
          <p role="status" className="-mt-2 mb-3 shrink-0 text-caption text-ink-2">
            {note}
          </p>
        )}

        {info.config === null ? (
          <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
            Waiting for your Claude folder. Your sessions appear here as soon as it is ready.
          </p>
        ) : first.error && !cacheNotReady(status) ? (
          <EmptyState
            variant="error"
            className={STATE_HEIGHT}
            title="Could not load your sessions"
            reason={first.error}
            action={{ onClick: () => first.reload(false) }}
          />
        ) : ((first.loading || first.error) && !first.data) || (total === 0 && settling) ? (
          <div role="status" aria-label="Loading sessions">
            {/* Same shape as the loaded page: the pick-up card, then rows. */}
            {!filtered && sortKey === "newest" && <Skeleton className="mb-4 h-[92px] rounded-card" />}
            <Card>
              <div className="divide-y divide-line">
                {[0, 1, 2, 3, 4, 5].map((i) => (
                  <div key={i} className="px-5 py-3">
                    <Skeleton className="h-4" style={{ width: `${62 - (i % 3) * 14}%` }} />
                    <Skeleton className="mt-2 h-3" style={{ width: `${34 + (i % 2) * 10}%` }} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
        ) : total === 0 && firstIndex ? (
          <p role="status" className="rounded-card border border-line bg-surface px-5 py-4 text-body text-ink-2">
            Sessions appear here as Atlas reads your files.
          </p>
        ) : total === 0 && filtered ? (
          <EmptyState
            variant="no-match"
            className={STATE_HEIGHT}
            query={typed || undefined}
            body={typed && changed > 0 ? "Filters are on too." : typed ? "Try fewer words." : undefined}
            action={{ onClick: clear, label: typed && changed > 0 ? "Clear search and filters" : typed ? "Clear search" : "Clear filters" }}
          />
        ) : total === 0 ? (
          <EmptyState
            seed={22}
            className={STATE_HEIGHT}
            title="No sessions yet"
            body="Each Claude Code session shows up here with the tokens it used, when it ran and its project."
          />
        ) : (
          <>
          {pick && (
            <div className="shrink-0">
              <PickUp row={pick} onOpen={setSelected} />
            </div>
          )}
          {/* Side room so a keyboard ring on a row is not cut by the pane's edge. */}
          <div
            ref={listPane}
            onScroll={(e) => {
              listTop.current = e.currentTarget.scrollTop;
            }}
            onKeyDown={onPaneKey}
            className="sessions-pane min-h-0 flex-1 overflow-y-auto px-2 pb-1"
            data-testid="sessions-scroll"
          >
          <Card>
            {byFolder ? (
              folders.map((g) => {
                const open = !folded.has(g.key);
                // More of this folder may still be on the next page: its count is not final yet.
                const soFar = cursor !== null;
                const id = `folder-${g.key.replace(/[^A-Za-z0-9_-]/g, "_")}`;
                return (
                  <section key={g.key} aria-labelledby={id} className="folder-section">
                    <h3 className="folder-h">
                      <button
                        type="button"
                        id={id}
                        className="folder-head"
                        aria-expanded={open}
                        aria-label={`${g.name}, ${plural(g.rows.length, "session")}${soFar ? " so far" : ""}, latest ${formatWhen(g.latest)}`}
                        onClick={() => toggleFolder(g.key)}
                      >
                        <CaretRight size={14} weight="bold" aria-hidden="true" className={`folder-caret ${open ? "is-open" : ""}`} />
                        <span className="folder-name" data-tip={g.path ? `${g.path}\nThe dot is this project's colour in every list.` : "These sessions ran outside any project folder."}>
                          {g.path && <ProjectDot path={g.path} />}
                          {/* A typed word found in the folder's name is marked here, where the name is, not on each row. */}
                          {hitParts(g.name, titleQ).map((p, i) =>
                            p.hit ? (
                              <mark key={i} className="sl-hit">
                                {p.text}
                              </mark>
                            ) : (
                              p.text
                            ),
                          )}
                        </span>
                        <span className="folder-count">{`${plural(g.rows.length, "session")}${soFar ? " so far" : ""}`}</span>
                        <span className="folder-latest" title="When this folder's latest session started">
                          {formatWhen(g.latest)}
                        </span>
                        <span className="folder-total" title={`${tokensTip(g.tokens, sumKinds(g.rows.map((r) => r.tokens)))}
In the sessions listed here.`}>
                          {`${compact(g.tokens)} tokens`}
                        </span>
                        <span aria-hidden="true" className="folder-bar">
                          <i style={{ width: `${Math.round(shareOfMax(g.tokens, maxFolder) * 100)}%` }} />
                        </span>
                      </button>
                    </h3>
                    {open && <SessionGrid>{g.rows.map(line)}</SessionGrid>}
                  </section>
                );
              })
            ) : byTime ? (
              groups.map((g, gi) => {
                // More of the last day may still be on the next page: its total is not final yet.
                const open = gi === groups.length - 1 && cursor !== null;
                return (
                  <section key={g.day} aria-label={g.label} className="day-section">
                    <h3 className="day-head">
                      <span className="day-name">{g.label}</span>
                      {!open && (
                        <>
                          <span className="day-count">{plural(g.rows.length, "session")}</span>
                          <span className="day-total" title={tokensTip(g.tokens, sumKinds(g.rows.map((r) => r.tokens)))}>
                            {`${compact(g.tokens)} tokens`}
                          </span>
                          <span aria-hidden="true" className="day-bar">
                            <i style={{ width: `${Math.round(shareOfMax(g.tokens, maxDay) * 100)}%` }} />
                          </span>
                        </>
                      )}
                    </h3>
                    <SessionGrid>{g.rows.map(line)}</SessionGrid>
                  </section>
                );
              })
            ) : (
              <SessionGrid>{rows.map(line)}</SessionGrid>
            )}
            {(cursor || moreError) && (
              <div className="flex items-center gap-3 border-t border-line px-5 py-3">
                <Button onClick={loadMore} disabled={busy}>
                  {busy ? "Loading..." : "Show more"}
                </Button>
                <span className="text-caption text-ink-2">{`Showing ${exact(rows.length)} of ${exact(total)}`}</span>
                {moreError && (
                  <span role="alert" className="text-caption text-danger" title={moreError}>
                    Could not load more. Try again.
                  </span>
                )}
              </div>
            )}
          </Card>
          </div>
          </>
        )}
      </div>
    </>
  );
}
