import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CaretDown, CaretRight, FolderDashed, Info } from "@phosphor-icons/react";
import { PageHeader } from "../components/controls";
import { DetailSheet } from "../components/setup/DetailSheet";
import { GroupSection } from "../components/setup/GroupSection";
import { ItemRow } from "../components/setup/ItemViews";
import { NoMatches, NoSetup, SetupError, SetupSkeleton } from "../components/setup/states";
import { Summary } from "../components/setup/Summary";
import { Toolbar } from "../components/setup/Toolbar";
import {
  applyKind,
  countByKind,
  countByScope,
  DEFAULT_FILTERS,
  groupItems,
  visibleItems,
  type Filters,
} from "../lib/setup-model";
import type { ItemKind, SetupItem, SetupProject, SetupSnapshot } from "../lib/setup-types";
import { reloadSetup, setIncludeWorktrees, startSetup, useSetup } from "../state/setupStore";
import { useAtlas } from "../state/AtlasProvider";

/** Quiet by default: long, low-value lists start folded. */
const FOLDED: ItemKind[] = ["other", "agentMemory"];

const CLAUDE_JSON_NOTE: Record<string, string> = {
  missing: "Atlas could not find your .claude.json, so the project list and per-project MCP servers may be incomplete.",
  stale: "Your .claude.json looks out of date, so the project list may be incomplete.",
  unreadable: "Atlas could not read your .claude.json, so the project list and per-project MCP servers may be incomplete.",
};

function MissingProjects({ projects, items, onOpen }: { projects: SetupProject[]; items: SetupItem[]; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const byProject = useMemo(() => {
    const m = new Map<string, SetupItem[]>();
    for (const i of items) if (i.projectId) (m.get(i.projectId) ?? m.set(i.projectId, []).get(i.projectId)!).push(i);
    return m;
  }, [items]);
  if (!projects.length) return null;
  const Caret = open ? CaretDown : CaretRight;
  return (
    <section aria-labelledby="missing-title" className="mb-8">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="missing-body"
        onClick={() => setOpen((v) => !v)}
        className="press group flex w-full cursor-pointer items-center gap-3 rounded-card text-left"
      >
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
          <FolderDashed size={18} weight="duotone" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-2">
            <h2 id="missing-title" className="text-lead font-semibold text-ink">
              Projects no longer on disk
            </h2>
            <span className="rounded-full bg-raised px-2 text-caption font-medium text-ink-2">{projects.length}</span>
          </span>
          <span className="block truncate text-body text-ink-2">Claude remembers these folders, but they are gone from this computer.</span>
        </span>
        <Caret size={16} aria-hidden="true" className="shrink-0 text-ink-2 group-hover:text-ink" />
      </button>
      {open && (
        <ul id="missing-body" className="fade-in mt-3 overflow-hidden rounded-card border border-line bg-surface">
          {projects.map((p) => {
            const mine = byProject.get(p.id) ?? [];
            return (
              <li key={p.id} className="border-b border-line last:border-b-0">
                <div className="px-4 py-2.5">
                  <div className="text-body font-medium text-ink">{p.name}</div>
                  <div className="mono selectable truncate text-ink-2" title={p.path}>
                    {p.path}
                  </div>
                </div>
                {mine.map((i) => (
                  <ItemRow key={i.id} item={i} onOpen={onOpen} />
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Loaded({ snap, includeWorktrees, loads, error }: { snap: SetupSnapshot; includeWorktrees: boolean; loads: number; error: string | null }) {
  const { info } = useAtlas();
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS, showWorktrees: includeWorktrees });
  const [folded, setFolded] = useState<Set<ItemKind>>(() => new Set(FOLDED));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const mac = info.platform === "macos";

  const patch = useCallback((p: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...p }));
    if (p.showWorktrees !== undefined) setIncludeWorktrees(p.showWorktrees);
  }, []);

  // Ctrl/Cmd+F goes to the search box instead of the (useless here) browser find.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac]);

  const query = useDeferredValue(filters.query);
  const effective = useMemo(() => ({ ...filters, query }), [filters, query]);

  const missingIds = useMemo(() => new Set(snap.projects.filter((p) => !p.exists).map((p) => p.id)), [snap.projects]);
  const missingProjects = useMemo(() => snap.projects.filter((p) => !p.exists), [snap.projects]);
  const { live, gone } = useMemo(() => {
    const live: SetupItem[] = [];
    const gone: SetupItem[] = [];
    for (const i of snap.items) (i.projectId && missingIds.has(i.projectId) ? gone : live).push(i);
    return { live, gone };
  }, [snap.items, missingIds]);

  const visible = useMemo(() => visibleItems(live, effective), [live, effective]);
  const kindCounts = useMemo(() => countByKind(visible), [visible]);
  const scopeCounts = useMemo(() => countByScope(visible), [visible]);
  const shown = useMemo(() => applyKind(visible, filters.kind), [visible, filters.kind]);
  const groups = useMemo(() => groupItems(shown), [shown]);
  const byId = useMemo(() => new Map(snap.items.map((i) => [i.id, i])), [snap.items]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;

  const forceOpen = query.trim() !== "" || filters.kind !== null;
  const toggle = (k: ItemKind) =>
    setFolded((s) => {
      const n = new Set(s);
      if (!n.delete(k)) n.add(k);
      return n;
    });
  const clearAll = () => patch({ ...DEFAULT_FILTERS, showWorktrees: filters.showWorktrees });

  // Up/Down walk the cards in reading order.
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cards = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-item-card]") ?? []);
    const at = cards.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const nothing = snap.items.length === 0;
  const jsonNote = CLAUDE_JSON_NOTE[snap.root.claudeJsonState];

  return (
    <>
      {error && (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-card bg-warning-tint px-4 py-3 text-body text-warning">
          <Info size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
          Atlas could not refresh just now, so this is the last scan. {error}
        </p>
      )}
      {!snap.root.dirExists || nothing ? (
        <NoSetup dir={snap.root.dir} />
      ) : (
        <>
          {jsonNote && (
            <p role="note" className="mb-4 flex items-start gap-2 rounded-card bg-raised px-4 py-3 text-body text-ink-2">
              <Info size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
              {jsonNote}
            </p>
          )}
          <Summary
            snapshot={snap}
            total={visible.length}
            kindCounts={kindCounts}
            scopeCounts={scopeCounts}
            activeKind={filters.kind}
            onKind={(kind) => patch({ kind })}
            live={true}
          />
          <Toolbar
            filters={filters}
            onChange={patch}
            projects={snap.projects}
            hidden={snap.hidden}
            searchRef={search}
            shortcut={mac ? "Cmd F" : "Ctrl F"}
            shown={shown.length}
            total={visible.length}
          />
          <div ref={list} onKeyDown={onListKey}>
            {groups.length === 0 ? (
              <NoMatches onClear={clearAll} />
            ) : (
              groups.map((g) => (
                <GroupSection
                  key={g.meta.kind}
                  group={g}
                  open={forceOpen || !folded.has(g.meta.kind)}
                  onToggle={() => toggle(g.meta.kind)}
                  onOpenItem={setSelectedId}
                />
              ))
            )}
            {filters.kind === null && query.trim() === "" && filters.scope !== "global" && (
              <MissingProjects projects={missingProjects} items={gone} onOpen={setSelectedId} />
            )}
          </div>
        </>
      )}
      {selected && (
        <DetailSheet item={selected} all={byId} loads={loads} onClose={() => setSelectedId(null)} onOpen={setSelectedId} />
      )}
    </>
  );
}

export function Setup() {
  const st = useSetup();
  useEffect(() => startSetup(), []);

  return (
    <>
      <PageHeader
        title="Setup"
        subtitle="Everything Claude loads for you, read straight from your folders. Nothing here can be changed."
      />
      {st.snapshot ? (
        <Loaded snap={st.snapshot} includeWorktrees={st.includeWorktrees} loads={st.loads} error={st.status === "ready" ? st.error : null} />
      ) : st.status === "error" ? (
        <SetupError message={st.error ?? "Something went wrong."} onRetry={reloadSetup} />
      ) : (
        <SetupSkeleton />
      )}
    </>
  );
}
