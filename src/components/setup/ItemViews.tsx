import { memo } from "react";
import { Lock, X } from "@phosphor-icons/react";
import { pushToast } from "../../state/toastStore";
import type { KeyboardEvent } from "react";
import { KIND_BY_ID, relativeTime } from "../../lib/setup-model";
import type { SetupItem } from "../../lib/setup-types";
import { ConflictChip, copyText, KindTile, ScopeChip, SecretsChip, StateChip, TagChip, WarningMark } from "./parts";

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
        className="press absolute right-2 top-2 flex size-7 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
      >
        <Lock size={14} aria-hidden="true" />
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
        className="press absolute right-2 top-2 flex size-7 cursor-pointer items-center justify-center rounded-control text-ink-2 opacity-0 hover:bg-danger-tint hover:text-danger focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <X size={14} weight="bold" aria-hidden="true" />
      </button>
    );
  }
  return null;
}

/** A full card: icon, name, two lines of description, then where it lives. The corner holds the delete X or a lock. */
export const ItemCard = memo(function ItemCard({ item, onOpen, onDelete }: ItemProps & { onDelete?: (item: SetupItem) => void }) {
  const shown = item.chips.slice(0, MAX_CHIPS);
  const more = item.chips.length - shown.length;
  const showState = item.enabled.state !== "on" && item.enabled.state !== "none" && item.enabled.label;
  return (
    <div className="group relative h-full [contain-intrinsic-size:auto_112px] [content-visibility:auto]">
      <button
        type="button"
        data-item-card
        data-id={item.id}
        onClick={() => onOpen(item.id)}
        onKeyDown={(e) => onCopyKey(e, item)}
        aria-label={`${KIND_BY_ID[item.kind].singular} ${item.name}, ${item.scopeLabel}${item.enabled.label ? `, ${item.enabled.label}` : ""}`}
        className="press flex h-full min-h-[104px] w-full cursor-pointer gap-3 rounded-card border border-line bg-surface p-3.5 text-left hover:border-line-strong hover:bg-raised"
      >
        <KindTile kind={item.kind} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-start justify-between gap-2 pr-6">
            <span className="truncate text-body font-semibold text-ink">{item.name}</span>
            {showState ? <StateChip enabled={item.enabled} /> : null}
          </span>
          {item.description ? (
            <span className="line-clamp-2 text-body text-ink-2">{item.description}</span>
          ) : (
            <span className="text-body text-ink-2 opacity-70">No description</span>
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
            {item.modifiedMs ? <span className="ml-auto text-caption text-ink-2">{relativeTime(item.modifiedMs)}</span> : null}
          </span>
        </span>
      </button>
      <CornerControl item={item} onDelete={onDelete} />
    </div>
  );
});

/**
 * A one-line row for long, simple lists (permissions, memory, hook scripts). No press-scale: content-visibility
 * (kept so long lists stay cheap) clips to the element's own box, which would shrink the hit area when scaled.
 */
export const ItemRow = memo(function ItemRow({ item, onOpen, mono }: ItemProps & { mono?: boolean }) {
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
      <span className={`min-w-0 flex-1 truncate text-body text-ink ${mono ? "mono" : "font-medium"}`}>{item.name}</span>
      {item.description && <span className="hidden max-w-[34%] truncate text-caption text-ink-2 md:block">{item.description}</span>}
      {item.usedBy !== null && (
        <span className="shrink-0 text-caption text-ink-2">
          {item.usedBy === 0 ? "Not used" : `Used by ${item.usedBy}`}
        </span>
      )}
      <ScopeChip scope={item.scope} label={item.scopeLabel} />
      <StateChip enabled={item.enabled} />
    </button>
  );
});
