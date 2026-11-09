import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowLeft, Plus } from "@phosphor-icons/react";
import { Button } from "../controls";
import { IconMotion } from "../IconMotion";
import { GroupBody, GroupSection } from "./GroupSection";
import { NoMatches } from "./states";
import { Toolbar } from "./Toolbar";
import {
  DEFAULT_FILTERS,
  gridMove,
  groupItems,
  KIND_BY_ID,
  tileKinds,
  tileTitle,
  visibleItems,
  type Filters,
  type TileId,
} from "../../lib/setup-model";
import type { CreateKind, ItemKind, SetupItem, SetupSnapshot } from "../../lib/setup-types";
import { setIncludeWorktrees } from "../../state/setupStore";
import { useKeyHints } from "../../lib/keyHints";

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
  const { show: showKeys } = useKeyHints();
  const [folded, setFolded] = useState<Set<ItemKind>>(() => new Set());
  const [filters, setFilters] = useState<Filters>({ ...DEFAULT_FILTERS, showWorktrees: includeWorktrees });
  const search = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const kinds = tileKinds(tile);
  const single = kinds.length === 1 ? kinds[0]! : null;

  // No page header any more: keyboard focus starts in the search box.
  useEffect(() => search.current?.focus({ preventScroll: true }), []);

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

  // Arrows move across the cards the way they sit on screen; Home / End jump to the ends.
  const onListKey = (e: KeyboardEvent) => {
    const nav = e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight";
    if (!nav && e.key !== "Home" && e.key !== "End") return;
    const cards = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-item-card]") ?? []);
    const at = cards.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    const to =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? cards.length - 1
          : gridMove(
              cards.map((c) => c.getBoundingClientRect()),
              at,
              e.key as "ArrowDown",
            );
    cards[to]?.focus();
    cards[to]?.scrollIntoView?.({ block: "nearest" });
  };

  // "/" jumps to the search box from anywhere on the page that is not already a text field.
  useEffect(() => {
    const onSlash = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement) return;
      if (a instanceof HTMLElement && a.isContentEditable) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    };
    window.addEventListener("keydown", onSlash);
    return () => window.removeEventListener("keydown", onSlash);
  }, []);

  // Down from the search box lands on the first card.
  const onSearchDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown") return;
    const first = list.current?.querySelector<HTMLElement>("[data-item-card]");
    if (!first) return;
    e.preventDefault();
    first.focus();
  };

  const forceOpen = query.trim() !== "";
  const creatable = single && CREATABLE.includes(single) ? (single as CreateKind) : null;
  const clearAll = () => patch({ ...DEFAULT_FILTERS, showWorktrees: filters.showWorktrees });

  return (
    <div className="fade-in flex min-h-0 flex-1 flex-col">
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-3">
        <Button onClick={onBack}>
          <IconMotion motion="nudge">
            <ArrowLeft />
          </IconMotion>
          Back to Toolkit
        </Button>
        {creatable && (
          <Button variant="primary" className="ml-auto" onClick={() => onCreate(creatable)}>
            <IconMotion motion="pop">
              <Plus />
            </IconMotion>
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
        onSearchKeyDown={onSearchDown}
        shortcut={showKeys ? (mac ? "Cmd F" : "Ctrl F") : undefined}
        shown={visible.length}
        total={items.length}
        placeholder={`Search ${tileTitle(tile).toLowerCase()}`}
      />

      <div ref={list} onKeyDown={onListKey} className="-mx-2 -mt-2 flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-2">
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
