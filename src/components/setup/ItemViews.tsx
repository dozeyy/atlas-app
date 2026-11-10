import { memo, useEffect, useRef, useState } from "react";
import { Lock, X } from "@phosphor-icons/react";
import { Button, Card } from "../controls";
import { pushToast } from "../../state/toastStore";
import type { KeyboardEvent } from "react";
import { deleteItem, errorText, whatGetsRemoved } from "../../lib/setup-actions";
import { chipWords, displayChips, displayDescription, displayName, KIND_BY_ID, relativeTime } from "../../lib/setup-model";
import type { SetupItem } from "../../lib/setup-types";
import { removedPath } from "./ConfirmDelete";
import { ConflictChip, copyText, formatDate, ItemIcon, ScopeChip, SecretsChip, StateChip, TagChip, WarningMark } from "./parts";
import { useItemCost } from "./CostContext";

interface ItemProps {
  item: SetupItem;
  onOpen: (id: string) => void;
}

/** Ctrl/Cmd+C on a focused card copies its path (when no text is selected). */
function onCopyKey(e: KeyboardEvent, item: SetupItem) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && item.path && !window.getSelection()?.toString()) {
    e.preventDefault();
    void copyText(item.path);
  }
}

const MAX_CHIPS = 3;

/**
 * The hover on a name: the name in full (it can be cut short), and for a hook the name Claude's
 * settings use for it on a second line, so someone who knows "PreToolUse" still finds it.
 */
function nameHover(item: SetupItem): string {
  const shown = displayName(item);
  return shown === item.name ? shown : `${shown}\n${item.name}`;
}

/**
 * The small control in a card's corner: an X for what Atlas can delete, a lock
 * (with the reason) for what it must not touch, nothing for the rest.
 */
function CornerControl({ item, onDelete }: { item: SetupItem; onDelete?: () => void }) {
  if (item.locked) {
    return (
      <button
        type="button"
        aria-label={`${displayName(item)} is locked. ${item.locked}`}
        title={item.locked}
        onClick={() => pushToast({ message: item.locked ?? "Atlas will not change this." })}
        className="x-del x-lock"
      >
        <span className="x-del-face">
          <Lock size={14} aria-hidden="true" />
        </span>
      </button>
    );
  }
  if (item.deletable && onDelete) {
    return (
      <button
        type="button"
        aria-label={`Delete ${displayName(item)}`}
        title="Delete"
        onClick={onDelete}
        className="x-del opacity-0 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <span className="x-del-face">
          <X size={14} weight="bold" aria-hidden="true" />
        </span>
      </button>
    );
  }
  return null;
}

/**
 * "Delete name?" asked on the card itself, in the card's own box (the Library's uninstall row does
 * the same). The card's X only opens this: nothing is deleted until the filled Delete is pressed.
 * Keep holds the keyboard first; Escape, a click anywhere else, or the keyboard leaving is Keep.
 * The buttons sit at the bottom of the card, well clear of where the X was, so a second click on
 * the same spot presses nothing. The delete itself is the one the sheet's Delete runs: deleteItem.
 */
function DeleteAsk({ item, onKeep, onGone }: { item: SetupItem; onKeep: (refocus: boolean) => void; onGone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // A press anywhere outside the card is "Keep". It never reaches Delete, which is inside.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (busyRef.current || !(e.target instanceof Node) || box.current?.contains(e.target)) return;
      onKeep(false);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [onKeep]);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteItem(item);
      onGone();
    } catch (e) {
      setError(errorText(e, "Atlas could not delete that, so nothing was changed."));
      setBusy(false);
    }
  };

  const name = displayName(item);
  return (
    <div
      ref={box}
      role="group"
      aria-label={`Delete ${name}?`}
      data-item-ask
      className="card item-ask flex h-full min-h-[104px] gap-3 p-3.5"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        // The page's own Escape (back to the Toolkit) must not also run.
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onKeep(true);
      }}
      onBlur={(e) => {
        const to = e.relatedTarget;
        if (!busy && to instanceof Node && !e.currentTarget.contains(to)) onKeep(false);
      }}
    >
      <ItemIcon item={item} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span title={nameHover(item)} className="truncate text-body font-semibold text-ink">
          Delete {name}?
        </span>
        <span title={removedPath(item) ?? undefined} className="text-body text-ink-2">
          {whatGetsRemoved(item)} Atlas keeps a backup first, so you can undo.
        </span>
        {error && (
          <span role="alert" className="text-body text-danger">
            {error}
          </span>
        )}
        <span className="mt-auto flex flex-wrap justify-end gap-2 pt-1">
          <Button autoFocus onClick={() => onKeep(true)} disabled={busy}>
            Keep
          </Button>
          <Button variant="danger-solid" onClick={() => void run()} disabled={busy}>
            {busy ? "Deleting..." : "Delete"}
          </Button>
        </span>
      </span>
    </div>
  );
}

/**
 * A full card: icon, name, two lines of description, then where it lives. The corner holds the
 * delete X or a lock. The X asks on the card itself (DeleteAsk); `canDelete` turns the X on.
 */
export const ItemCard = memo(function ItemCard({ item, onOpen, canDelete }: ItemProps & { canDelete?: boolean }) {
  const chips = displayChips(item);
  const shown = chips.slice(0, MAX_CHIPS);
  const more = chips.length - shown.length;
  // A copy that loses to another says so once, on its "Overridden by ..." chip; without that chip the state says it.
  const showState = item.enabled.state !== "on" && item.enabled.state !== "none" && item.enabled.label && !(item.enabled.state === "shadowed" && item.conflict);
  const cost = useItemCost(item.id);
  const description = displayDescription(item);
  const [asking, setAsking] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const refocus = useRef(false);
  // "Keep" and Escape hand the keyboard back to the card the question came from.
  useEffect(() => {
    if (asking || !refocus.current) return;
    refocus.current = false;
    wrap.current?.querySelector<HTMLElement>("[data-item-card]")?.focus();
  }, [asking]);
  const keep = useRef((back: boolean) => {
    refocus.current = back;
    setAsking(false);
  }).current;
  // What is deleted can no longer be asked about (a lock arrived, or the item changed under it).
  const askable = !!canDelete && item.deletable && !item.locked;
  if (asking && askable) {
    return (
      <div ref={wrap} data-item-wrap className="item-wrap relative h-full">
        <DeleteAsk
          item={item}
          onKeep={keep}
          onGone={() => {
            // The card is about to leave the list: the keyboard moves to its neighbour, not to nowhere.
            const wraps = Array.from(document.querySelectorAll<HTMLElement>("[data-item-wrap]"));
            const at = wrap.current ? wraps.indexOf(wrap.current) : -1;
            const next = at < 0 ? null : (wraps[at + 1] ?? wraps[at - 1] ?? null);
            next?.querySelector<HTMLElement>("[data-item-card]")?.focus();
          }}
        />
      </div>
    );
  }
  return (
    <div ref={wrap} data-item-wrap className="item-wrap group relative h-full">
      <Card
        data-item-card
        data-id={item.id}
        onClick={() => onOpen(item.id)}
        onKeyDown={(e) => onCopyKey(e, item)}
        aria-label={`${KIND_BY_ID[item.kind].singular} ${displayName(item)}, ${item.scopeLabel}${item.enabled.label ? `, ${item.enabled.label}` : ""}`}
        hitClassName="h-full min-h-[104px]"
        className="flex min-h-[104px] gap-3 p-3.5"
      >
        <ItemIcon item={item} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-start justify-between gap-2 pr-6">
            <span title={nameHover(item)} className="truncate text-body font-semibold text-ink">
              {displayName(item)}
            </span>
            {showState ? <StateChip enabled={item.enabled} /> : null}
          </span>
          {description ? (
            <span title={description === item.description ? description : `${description}\n${item.description}`} className="line-clamp-2 text-body text-ink-2">
              {description}
            </span>
          ) : (
            <span className="text-body text-ink-2 opacity-70">No description</span>
          )}
          {cost && (
            <span data-item-cost title={cost.hover} className="truncate text-caption text-ink-2">
              <span className="d d-small text-ink">{cost.figure}</span> {cost.unit}
            </span>
          )}
          <span className="mt-auto flex flex-wrap items-center gap-1.5 pt-0.5">
            <ScopeChip scope={item.scope} label={item.scopeLabel} />
            {shown.map((c) => {
              const { label, title } = chipWords(item, c);
              return (
                <TagChip key={c} title={title}>
                  {label}
                </TagChip>
              );
            })}
            {more > 0 && <TagChip>+{more}</TagChip>}
            {item.conflict && <ConflictChip conflict={item.conflict} />}
            {item.hasSecrets && <SecretsChip />}
            <WarningMark warnings={item.warnings} />
            {item.modifiedMs ? (
              <span title={`Last changed ${formatDate(item.modifiedMs)}`} className="ml-auto text-caption text-ink-2">
                {relativeTime(item.modifiedMs)}
              </span>
            ) : null}
          </span>
        </span>
      </Card>
      <CornerControl item={item} onDelete={canDelete ? () => setAsking(true) : undefined} />
    </div>
  );
});

/**
 * A one-line row for long, simple lists (permissions, memory, hook scripts). A wash on hover, never a move:
 * content-visibility (kept so long lists stay cheap) clips to the element's own box. The cards above do not
 * use it, because they lift.
 */
export const ItemRow = memo(function ItemRow({ item, onOpen, mono }: ItemProps & { mono?: boolean }) {
  const cost = useItemCost(item.id);
  return (
    <button
      type="button"
      data-item-card
      data-id={item.id}
      onClick={() => onOpen(item.id)}
      onKeyDown={(e) => onCopyKey(e, item)}
      aria-label={`${KIND_BY_ID[item.kind].singular} ${displayName(item)}, ${item.scopeLabel}`}
      className="flex min-h-9 w-full cursor-pointer items-center gap-3 border-b border-line px-4 py-1.5 text-left transition-colors duration-[var(--dur-fast)] [contain-intrinsic-size:auto_36px] [content-visibility:auto] last:border-b-0 hover:bg-raised active:bg-raised"
    >
      <span title={nameHover(item)} className={`min-w-0 flex-1 truncate text-body text-ink ${mono && displayName(item) === item.name ? "mono" : "font-medium"}`}>
        {displayName(item)}
      </span>
      {/* A counted row (a hook script) says how many hooks use it once, in words; its description is the same count. */}
      {item.usedBy !== null ? (
        <span className="shrink-0 text-caption text-ink-2">
          {item.usedBy === 0 ? "Not used by any hook" : `Used by ${item.usedBy} ${item.usedBy === 1 ? "hook" : "hooks"}`}
        </span>
      ) : (
        item.description && (
          <span title={displayDescription(item)} className="hidden max-w-[34%] truncate text-caption text-ink-2 md:block">
            {displayDescription(item)}
          </span>
        )
      )}
      {cost && (
        <span data-item-cost title={cost.hover} className="shrink-0 text-caption text-ink-2">
          <span className="d d-small text-ink">{cost.figure}</span> {cost.unit}
        </span>
      )}
      <ScopeChip scope={item.scope} label={item.scopeLabel} />
      <StateChip enabled={item.enabled} />
    </button>
  );
});
