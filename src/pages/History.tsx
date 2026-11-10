import { useEffect, useMemo, useRef, useState } from "react";
import { ClockCounterClockwise, PauseCircle } from "@phosphor-icons/react";
import { getBackend } from "../lib/ipc";
import { useFetched } from "../lib/useUsage";
import { useWidth } from "../lib/useWidth";
import { useHistoryEvents } from "../lib/useHistoryEvents";
import { prefersReducedMotion } from "../lib/motion";
import { GROUP_CHIPS, groupEvents, shortDate } from "../lib/historyModel";
import { exact } from "../lib/usage";
import { useAtlas } from "../state/AtlasProvider";
import { Button, Card, PageTitle } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { SearchField, SelectField } from "../components/usage/fields";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { Ribbon } from "../components/history/Ribbon";
import { Timeline } from "../components/history/Timeline";
import { Detail } from "../components/history/Detail";
import type { HistoryEvent, HistoryGroup, HistoryOverview } from "../lib/historyTypes";

const WIDE_AT = 760;
const rise = (n: number) => ({ ["--i" as string]: n });

function Hero({ o, now, onPick }: { o: HistoryOverview; now: number; onPick: (day: number) => void }) {
  return (
    <section aria-label="Summary" className="rise" style={rise(1)}>
      <Card className="grid grid-cols-1 items-center gap-x-10 gap-y-2 px-5 py-2 @[740px]:grid-cols-[auto_minmax(0,1fr)]">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
          <div>
            {/* A plain number: History is a calm page, nothing counts up here. */}
            <div className="d d-hero text-ink">{exact(o.watchedEvents)}</div>
            <div className="text-body text-ink-2">changes seen</div>
          </div>
          <div>
            <div className="d d-stat text-ink">{exact(o.items)}</div>
            <div className="text-body text-ink-2">files watched</div>
          </div>
          {o.watchingSince > 0 && (
            <div>
              <div className="d d-stat text-ink">{shortDate(o.watchingSince, now)}</div>
              <div className="text-body text-ink-2">watching since</div>
            </div>
          )}
        </div>
        <div className="min-w-0 self-end">
          <Ribbon days={o.days} onPick={onPick} now={now} />
        </div>
      </Card>
    </section>
  );
}

export function History() {
  const backend = getBackend();
  const { info } = useAtlas();
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const wide = width === 0 || width >= WIDE_AT;

  const overview = useFetched(() => backend.historyOverview(), [backend, info.config?.dir]);
  const [group, setGroup] = useState<HistoryGroup | "all">("all");
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQ(text), 200);
    return () => clearTimeout(t);
  }, [text]);

  const list = useHistoryEvents({ group, project, text: q }, info.config?.dir ?? null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [opened, setOpened] = useState(false);
  const [wantDay, setWantDay] = useState<number | null>(null);

  // The worker found a change: re-read the numbers and the first page, never blanking the list.
  const live = useRef({ reload: overview.reload, refresh: list.refresh });
  live.current = { reload: overview.reload, refresh: list.refresh };
  useEffect(() => {
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let dead = false;
    backend
      .onHistoryChanged(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          live.current.reload(true);
          live.current.refresh();
        }, 250);
      })
      .then((fn) => {
        if (dead) fn();
        else off = fn;
      })
      .catch(() => {});
    return () => {
      dead = true;
      clearTimeout(timer);
      off?.();
    };
  }, [backend]);

  // Ctrl/Cmd + F goes to the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = info.platform === "macos" ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey || e.key.toLowerCase() !== "f") return;
      const input = root.current?.querySelector<HTMLInputElement>('input[type="search"]');
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info.platform]);

  const since = overview.data?.watchingSince ?? 0;
  const view = useMemo(() => {
    const now = Date.now();
    return { now, sections: groupEvents(list.events, now, since) };
  }, [list.events, since]);

  const selected: HistoryEvent | null = list.events.find((e) => e.id === selectedId) ?? (wide ? (list.events[0] ?? null) : null);
  const showDetail = selected !== null && (wide || opened);

  // Narrow: Esc closes the open change.
  useEffect(() => {
    if (wide || !opened) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpened(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [wide, opened]);

  // A ribbon dot asks for a day: scroll there, opening earlier pages first if it is not loaded yet.
  useEffect(() => {
    if (wantDay === null) return;
    const el = root.current?.querySelector<HTMLElement>(`[data-day="${wantDay}"]`);
    if (el) {
      el.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      setWantDay(null);
    } else if (list.more && !list.loadingMore) {
      void list.loadMore();
    } else if (!list.more && !list.loading && !list.loadingMore) {
      setWantDay(null);
    }
  }, [wantDay, list.events, list.more, list.loading, list.loadingMore, list.loadMore]);

  const pick = (e: HistoryEvent) => {
    setSelectedId(e.id);
    setOpened(true);
  };

  const o = overview.data;
  const filtered = group !== "all" || project !== "" || q.trim() !== "";
  const showEverything = () => {
    setGroup("all");
    setProject("");
    setText("");
    setQ("");
  };

  if (overview.loading && !o && !overview.error) {
    return (
      <div className="@container flex flex-col gap-4" ref={root}>
        <PageTitle title="History" />
        <Skeleton className="h-36" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (overview.error && !o) {
    return (
      <div className="@container" ref={root}>
        <PageTitle title="History" />
        <ErrorBlock title="Could not load History" message={overview.error} onRetry={() => overview.reload(false)} />
      </div>
    );
  }
  if (o === null) {
    return (
      <div className="@container flex flex-1 flex-col" ref={root}>
        <PageTitle title="History" />
        <EmptyState
          fill
          seed={11}
          icon={PauseCircle}
          title="History is paused while Sandbox mode is on"
          body="Atlas keeps its copies of your real Claude folder only. Turn Sandbox mode off in Settings, under Claude folder, and History picks up where it left off."
        />
      </div>
    );
  }
  if (o.watchingSince === 0 && o.events === 0 && !list.loading && list.events.length === 0 && !filtered) {
    return (
      <div className="@container flex flex-1 flex-col" ref={root}>
        <PageTitle title="History" />
        <EmptyState
          fill
          seed={11}
          icon={ClockCounterClockwise}
          title="Atlas is taking its first look"
          body="It is reading your Claude folder now. Changes you make from here on show up on this page, newest first."
        />
      </div>
    );
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col gap-3" ref={root}>
      <PageTitle title="History" />

      {!(opened && !wide) && (
        <>
          <Hero o={o} now={view.now} onPick={setWantDay} />

          <div className="rise flex flex-wrap items-center gap-x-1 gap-y-2" style={rise(2)}>
            <div role="group" aria-label="Show" className="flex max-w-full flex-none flex-wrap items-center gap-0.5">
              {GROUP_CHIPS.map((c) => (
                <button key={c.id} type="button" className="hx-filter text-body" aria-pressed={group === c.id} onClick={() => setGroup(c.id)}>
                  {c.label}
                </button>
              ))}
            </div>
            <div className="ml-auto flex min-w-max flex-1 items-center justify-end gap-2">
              {o.projects.length > 0 && (
                // The picker cuts a long project name; the hover says which one is chosen.
                <span className="inline-flex" title={project || undefined}>
                  <SelectField
                    label="Project"
                    value={project}
                    onChange={setProject}
                    options={[{ value: "", label: "All projects" }, ...o.projects.map((p) => ({ value: p, label: p }))]}
                  />
                </span>
              )}
              <SearchField value={text} onChange={setText} label="Search changes" placeholder="Search changes" />
            </div>
          </div>
        </>
      )}

      {list.error && !list.events.length ? (
        <ErrorBlock title="Could not load the changes" message={list.error} onRetry={list.retry} />
      ) : list.loading && list.events.length === 0 ? (
        <Skeleton className="h-64" />
      ) : list.events.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <p role="status" className="text-body text-ink-2">
            {filtered ? "Nothing matches that. Try another filter or search." : "No changes yet."}
          </p>
          {filtered && <Button onClick={showEverything}>Show everything</Button>}
        </div>
      ) : wide ? (
        <div className="rise grid min-h-[240px] flex-1 grid-cols-[minmax(300px,380px)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-6" style={rise(3)}>
          <div className="min-h-0 overflow-y-auto pr-1">
            <Timeline
              sections={view.sections}
              selectedId={selected?.id ?? null}
              onSelect={pick}
              selectOnMove
              more={list.more}
              loadingMore={list.loadingMore}
              onMore={() => void list.loadMore()}
              now={view.now}
            />
          </div>
          <div className="min-h-0 overflow-y-auto rounded-card">
            {showDetail && selected && (
              <Card className="p-5">
                <Detail key={selected.id} event={selected} />
              </Card>
            )}
          </div>
        </div>
      ) : showDetail && selected ? (
        <div className="min-h-[240px] flex-1 overflow-y-auto rounded-card">
          <Card className="p-5">
            <Detail key={selected.id} event={selected} onBack={() => setOpened(false)} />
          </Card>
        </div>
      ) : (
        <div className="rise min-h-[240px] flex-1 overflow-y-auto" style={rise(3)}>
          <Timeline
            sections={view.sections}
            selectedId={selected?.id ?? null}
            onSelect={pick}
            selectOnMove={false}
            more={list.more}
            loadingMore={list.loadingMore}
            onMore={() => void list.loadMore()}
            now={view.now}
          />
        </div>
      )}
    </div>
  );
}
