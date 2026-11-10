import { memo } from "react";
import { Lock, X } from "@phosphor-icons/react";
import { Card } from "../controls";
import { pushToast } from "../../state/toastStore";
import type { KeyboardEvent } from "react";
import { KIND_BY_ID, relativeTime } from "../../lib/setup-model";
import type { SetupItem } from "../../lib/setup-types";
import { ConflictChip, copyText, formatDate, ItemIcon, ScopeChip, SecretsChip, StateChip, TagChip, WarningMark } from "./parts";
import { useItemCost } from "./CostContext";
import { HOOK_EVENTS } from "./CreateFlow";

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
 * The chips a card shows. A hook's own chips are its event and its type, which its title
 * ("PreToolUse - Bash") and first line ("command: ...") already say, so the card says when it
 * runs in plain words instead ("Before a tool runs"). Every other kind shows its chips as given.
 */
function cardChips(item: SetupItem): string[] {
  if (item.kind !== "hook") return item.chips;
  const event = HOOK_EVENTS.find((h) => item.name.startsWith(h.value));
  return event ? [event.label] : [];
}

/**
 * The small control in a card's corner: an X for what Atlas can delete, a lock
 * (with the reason) for what it must not touch, nothing for the rest.
 */
function CornerControl({ item, onDelete }: { item: SetupItem; onDelete?: (item: SetupItem) => void }) {
  if (item.locked) {
    return (
      <button
        type="button"
        aria-label={`${item.name} is locked. ${item.locked}`}
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
        aria-label={`Delete ${item.name}`}
        title="Delete"
        onClick={() => onDelete(item)}
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

/** A full card: icon, name, two lines of description, then where it lives. The corner holds the delete X or a lock. */
export const ItemCard = memo(function ItemCard({ item, onOpen, onDelete }: ItemProps & { onDelete?: (item: SetupItem) => void }) {
  const chips = cardChips(item);
  const shown = chips.slice(0, MAX_CHIPS);
  const more = chips.length - shown.length;
  const showState = item.enabled.state !== "on" && item.enabled.state !== "none" && item.enabled.label;
  const cost = useItemCost(item.id);
  return (
    <div className="item-wrap group relative h-full">
      <Card
        data-item-card
        data-id={item.id}
        onClick={() => onOpen(item.id)}
        onKeyDown={(e) => onCopyKey(e, item)}
        aria-label={`${KIND_BY_ID[item.kind].singular} ${item.name}, ${item.scopeLabel}${item.enabled.label ? `, ${item.enabled.label}` : ""}`}
        hitClassName="h-full min-h-[104px]"
        className="flex min-h-[104px] gap-3 p-3.5"
      >
        <ItemIcon item={item} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-start justify-between gap-2 pr-6">
            <span title={item.name} className="truncate text-body font-semibold text-ink">
              {item.name}
            </span>
            {showState ? <StateChip enabled={item.enabled} /> : null}
          </span>
          {item.description ? (
            <span title={item.description} className="line-clamp-2 text-body text-ink-2">
              {item.description}
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
            {shown.map((c) => (
              <TagChip key={c}>{c}</TagChip>
            ))}
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
      <CornerControl item={item} onDelete={onDelete} />
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
      aria-label={`${KIND_BY_ID[item.kind].singular} ${item.name}, ${item.scopeLabel}`}
      className="flex min-h-9 w-full cursor-pointer items-center gap-3 border-b border-line px-4 py-1.5 text-left transition-colors duration-[var(--dur-fast)] [contain-intrinsic-size:auto_36px] [content-visibility:auto] last:border-b-0 hover:bg-raised active:bg-raised"
    >
      <span title={item.name} className={`min-w-0 flex-1 truncate text-body text-ink ${mono ? "mono" : "font-medium"}`}>
        {item.name}
      </span>
      {/* A counted row (a hook script) says how many hooks use it once, in words; its description is the same count. */}
      {item.usedBy !== null ? (
        <span className="shrink-0 text-caption text-ink-2">
          {item.usedBy === 0 ? "Not used by any hook" : `Used by ${item.usedBy} ${item.usedBy === 1 ? "hook" : "hooks"}`}
        </span>
      ) : (
        item.description && (
          <span title={item.description} className="hidden max-w-[34%] truncate text-caption text-ink-2 md:block">
            {item.description}
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
