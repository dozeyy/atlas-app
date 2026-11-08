import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowLeft, Plus } from "@phosphor-icons/react";
import { Button } from "../controls";
import { GroupBody, GroupSection } from "./GroupSection";
import { NoMatches } from "./states";
import { Toolbar } from "./Toolbar";
import {
  DEFAULT_FILTERS,
  groupItems,
  KIND_BY_ID,
  tileBlurb,
  tileKinds,
  tileTitle,
  visibleItems,
  type Filters,
  type TileId,
} from "../../lib/setup-model";
import type { CreateKind, ItemKind, SetupItem, SetupSnapshot } from "../../lib/setup-types";
import { setIncludeWorktrees } from "../../state/setupStore";

const CREATABLE: ItemKind[] = ["skill", "agent", "command", "rule", "outputStyle", "hook", "mcpServer", "instructions"];

/**
 * One tile opened up: a back control, search, the Global / Projects filter, and
 * the cards. "More" shows several kinds, each under its own heading.
 */
export function CollectionView({
  tile,
  items,
  snap,
  includeWorktrees,
  mac,
  onBack,
  onOpenItem,
  onDelete,
  onCreate,
}: {
  tile: TileId;
  items: SetupItem[];
  snap: SetupSnapshot;
  includeWorktrees: boolean;
  mac: boolean;
  onBack: () => void;
  onOpenItem: (id: string) => void;
  onDelete: (item: SetupItem) => void;
  onCreate: (kind: CreateKind) => void;
}) {
  const [folded, setFolded] = useState<Set<ItemKind>>(() => new Set());
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS, showWorktrees: includeWorktrees });
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const kinds = tileKinds(tile);
  const single = kinds.length === 1 ? kinds[0]! : null;

  useEffect(() => heading.current?.focus({ preventScroll: true }), []);

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
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        const a = document.activeElement;
        if (!(a instanceof HTMLInputElement && a.value)) onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mac, onBack]);

  const query = useDeferredValue(filters.query);
  const effective = useMemo(() => ({ ...filters, query }), [filters, query]);
  const visible = useMemo(() => visibleItems(items, effective), [items, effective]);
  const groups = useMemo(() => groupItems(visible), [visible]);

  // Up/Down walk the cards in reading order.
  const onListKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const cards = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-item-card]") ?? []);
    const at = cards.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  };

  const forceOpen = query.trim() !== "";
  const creatable = single && CREATABLE.includes(single) ? (single as CreateKind) : null;
  const clearAll = () => patch({ ...DEFAULT_FILTERS, showWorktrees: filters.showWorktrees });

  return (
    <div className="fade-in flex flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <button
          type="button"
          onClick={onBack}
          className="press inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-control border border-line-strong bg-surface px-3 text-body font-medium text-ink hover:bg-raised"
        >
          <ArrowLeft size={14} weight="bold" aria-hidden="true" />
          Back to Setup
        </button>
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={-1} className="text-subtitle font-semibold text-ink outline-none">
            {tileTitle(tile)}
          </h2>
          <p className="truncate text-body text-ink-2">{tileBlurb(tile)}</p>
        </div>
        {creatable && (
          <Button variant="primary" onClick={() => onCreate(creatable)}>
            <Plus size={14} weight="bold" aria-hidden="true" />
            New {KIND_BY_ID[creatable].singular}
          </Button>
        )}
      </div>

      <Toolbar
        filters={filters}
        onChange={patch}
        projects={snap.projects}
        hidden={snap.hidden}
        searchRef={search}
        shortcut={mac ? "Cmd F" : "Ctrl F"}
        shown={visible.length}
        total={items.length}
        placeholder={`Search ${tileTitle(tile).toLowerCase()}`}
      />

      <div ref={list} onKeyDown={onListKey} className="flex flex-1 flex-col">
        {items.length === 0 ? (
          <p className="rounded-card border border-dashed border-line-strong px-5 py-8 text-center text-body text-ink-2">
            Nothing here yet.
            {creatable ? ` Use New ${KIND_BY_ID[creatable].singular} to make the first one.` : ""}
          </p>
        ) : groups.length === 0 ? (
          <NoMatches onClear={clearAll} />
        ) : single ? (
          <GroupBody group={groups[0]!} onOpenItem={onOpenItem} onDelete={onDelete} />
        ) : (
          groups.map((g) => (
            <GroupSection
              key={g.meta.kind}
              group={g}
              open={forceOpen || !folded.has(g.meta.kind)}
              onToggle={() =>
                setFolded((s) => {
                  const n = new Set(s);
                  if (!n.delete(g.meta.kind)) n.add(g.meta.kind);
                  return n;
                })
              }
              onOpenItem={onOpenItem}
              onDelete={onDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}
