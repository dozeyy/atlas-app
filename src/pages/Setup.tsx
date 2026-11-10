import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CaretDown, CaretRight, FolderDashed, Info } from "@phosphor-icons/react";
import { PageTitle, SegmentedControl } from "../components/controls";
import { LibraryTab } from "../components/library/LibraryTab";
import { CollectionView } from "../components/setup/CollectionView";
import { ConfirmDelete } from "../components/setup/ConfirmDelete";
import { CreateFlow } from "../components/setup/CreateFlow";
import { DetailSheet } from "../components/setup/DetailSheet";
import { ItemRow } from "../components/setup/ItemViews";
import { NoSetup, SetupError, SetupSkeleton } from "../components/setup/states";
import { TopSlot } from "../components/setup/TopSlot";
import { TypeTiles } from "../components/setup/TypeTiles";
import { CostProvider } from "../components/setup/CostContext";
import { countByKind, itemsForTile, MORE_KINDS, type TileId } from "../lib/setup-model";
import { useSetupCost } from "../lib/useSetupCost";
import { clearPendingToolkitItem, clearPendingToolkitTab, onNavRequest, peekPendingToolkitItem, peekPendingToolkitTab, type ToolkitTab } from "../lib/nav";
import type { CreateKind, SetupItem, SetupProject, SetupSnapshot } from "../lib/setup-types";
import { reloadSetup, startSetup, useSetup } from "../state/setupStore";
import { useAtlas } from "../state/AtlasProvider";
import { guardLeave } from "../state/unsavedStore";
import { Team } from "./Team";

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
    <section aria-labelledby="missing-title">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="missing-body"
        onClick={() => setOpen((v) => !v)}
        title="Claude remembers these folders, but they are gone from this computer."
        className="row-btn group items-center gap-3 rounded-card p-1 text-left"
      >
        <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
          <FolderDashed size={18} weight="duotone" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <h2 id="missing-title" className="d d-figure text-ink">
              Projects no longer on disk
            </h2>
            <span className="chip">{projects.length}</span>
          </span>
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
  const [tile, setTile] = useState<TileId | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const [pendingDelete, setPendingDelete] = useState<SetupItem | null>(null);
  const [creating, setCreating] = useState<CreateKind | null>(null);
  const top = useRef<HTMLDivElement>(null);
  const savedScroll = useRef(0);
  const mac = info.platform === "macos";

  const missingIds = useMemo(() => new Set(snap.projects.filter((p) => !p.exists).map((p) => p.id)), [snap.projects]);
  const missingProjects = useMemo(() => snap.projects.filter((p) => !p.exists), [snap.projects]);
  const { live, gone } = useMemo(() => {
    const live: SetupItem[] = [];
    const gone: SetupItem[] = [];
    for (const i of snap.items) (i.projectId && missingIds.has(i.projectId) ? gone : live).push(i);
    return { live, gone };
  }, [snap.items, missingIds]);

  // What the tiles count: what the page shows by default (no backups, no worktree copies).
  const counted = useMemo(() => live.filter((i) => !i.backup && !i.worktree), [live]);
  const counts = useMemo(() => countByKind(counted), [counted]);
  const moreCount = useMemo(() => MORE_KINDS.reduce((n, k) => n + (counts.get(k) ?? 0), 0), [counts]);
  const cost = useSetupCost(loads);
  const byId = useMemo(() => new Map(snap.items.map((i) => [i.id, i])), [snap.items]);
  const selected = selectedId ? (byId.get(selectedId) ?? null) : null;
  const tileItems = useMemo(() => (tile ? itemsForTile(live, tile) : []), [live, tile]);

  const scroller = () => top.current?.closest("main") ?? null;
  const openTile = useCallback((id: TileId) => {
    savedScroll.current = scroller()?.scrollTop ?? 0;
    setTile(id);
    scroller()?.scrollTo?.({ top: 0 });
  }, []);
  const closeTile = useCallback(() => {
    const id = tile;
    setTile(null);
    requestAnimationFrame(() => {
      scroller()?.scrollTo?.({ top: savedScroll.current });
      if (id) document.querySelector<HTMLElement>(`[data-tile="${id}"]`)?.focus({ preventScroll: true });
    });
  }, [tile]);

  // The quick jump (Ctrl+K) leaves "open this item" behind: take it when the page appears, or
  // right away when the page is already on screen.
  const takePending = useCallback(() => {
    const id = peekPendingToolkitItem();
    if (!id) return;
    clearPendingToolkitItem();
    // Another item replaces the one being edited: ask first when it holds unsaved edits.
    if (byId.has(id) && id !== selectedRef.current) guardLeave(() => setSelectedId(id));
  }, [byId]);
  useEffect(() => {
    takePending();
    return onNavRequest(takePending);
  }, [takePending]);

  const noFolder = !snap.root.dirExists;
  const jsonNote = CLAUDE_JSON_NOTE[snap.root.claudeJsonState];

  // The page frame is exactly one window tall, so a list can scroll inside itself. The home
  // can be taller than the window; its own bottom padding keeps the last row off the edge.
  return (
    <CostProvider report={cost}>
    <div ref={top} className={`flex flex-1 flex-col ${tile ? "min-h-0" : "pb-[var(--gutter-y)]"}`}>
      {error && (
        <p role="alert" className="mb-4 flex items-start gap-2 rounded-card bg-warning-tint px-4 py-3 text-body text-warning">
          <Info size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
          Atlas could not refresh just now, so this is the last scan. {error}
        </p>
      )}
      {noFolder ? (
        <NoSetup />
      ) : tile ? (
        <CollectionView
          key={tile}
          tile={tile}
          items={tileItems}
          snap={snap}
          includeWorktrees={includeWorktrees}
          mac={mac}
          onBack={closeTile}
          onOpenItem={setSelectedId}
          onDelete={setPendingDelete}
          onCreate={setCreating}
        />
      ) : (
        <>
          {jsonNote && (
            <p role="note" className="mb-4 flex items-start gap-2 rounded-card bg-raised px-4 py-3 text-body text-ink-2">
              <Info size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
              {jsonNote}
            </p>
          )}
          <TopSlot items={counted} loads={loads} cost={cost} onCreate={setCreating} onOpen={setSelectedId} />
          <TypeTiles counts={counts} moreCount={moreCount} onOpen={openTile} />
          <div className="mt-4">
            <MissingProjects projects={missingProjects} items={gone} onOpen={setSelectedId} />
          </div>
        </>
      )}
      {selected && (
        <DetailSheet
          item={selected}
          all={byId}
          loads={loads}
          cost={cost}
          onClose={() => setSelectedId(null)}
          onOpen={setSelectedId}
          onDelete={setPendingDelete}
        />
      )}
      {pendingDelete && (
        <ConfirmDelete
          item={pendingDelete}
          onCancel={() => setPendingDelete(null)}
          onDone={() => {
            if (selectedId === pendingDelete.id) setSelectedId(null);
            setPendingDelete(null);
          }}
        />
      )}
      {creating && <CreateFlow kind={creating} onClose={() => setCreating(null)} />}
    </div>
    </CostProvider>
  );
}

const TAB_KEY = "atlas.toolkit.tab";
const TABS: { value: ToolkitTab; label: string }[] = [
  { value: "setup", label: "Your setup" },
  { value: "library", label: "Library" },
  { value: "team", label: "Team" },
];

function firstTab(): ToolkitTab {
  const asked = peekPendingToolkitTab();
  if (asked) {
    clearPendingToolkitTab();
    return asked;
  }
  try {
    const saved = window.localStorage.getItem(TAB_KEY);
    return saved === "library" || saved === "team" ? saved : "setup";
  } catch {
    return "setup";
  }
}

export function Setup() {
  const st = useSetup();
  useEffect(() => startSetup(), []);
  const [tab, setTabState] = useState<ToolkitTab>(firstTab);

  const setTab = useCallback((t: ToolkitTab) => {
    setTabState(t);
    try {
      window.localStorage.setItem(TAB_KEY, t);
    } catch {
      // the choice just is not remembered
    }
  }, []);

  // Ctrl+K, or "Open in Toolkit" on a copied item, asks for a tab while the page is already open.
  useEffect(
    () =>
      onNavRequest(() => {
        const asked = peekPendingToolkitTab();
        if (!asked) return;
        clearPendingToolkitTab();
        setTab(asked);
      }),
    [setTab],
  );

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const at = TABS.findIndex((t) => t.value === tab);
    const next = (at + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length;
    setTab(TABS[next].value);
  };

  return (
    <>
      <PageTitle title="Toolkit" />
      <div onKeyDown={onKeyDown} className="mb-3 flex h-10 shrink-0 items-center">
        <SegmentedControl label="Toolkit view" value={tab} options={TABS} onChange={setTab} />
      </div>
      {tab === "library" ? (
        <LibraryTab />
      ) : (
        <>
          {tab === "team" && <Team onShowSetup={() => setTab("setup")} />}
          <div className={tab === "team" ? "hidden" : "contents"}>
            {st.snapshot ? (
              <Loaded snap={st.snapshot} includeWorktrees={st.includeWorktrees} loads={st.loads} error={st.status === "ready" ? st.error : null} />
            ) : st.status === "error" ? (
              <SetupError message={st.error ?? "Something went wrong."} onRetry={reloadSetup} />
            ) : (
              <SetupSkeleton />
            )}
          </div>
        </>
      )}
    </>
  );
}
