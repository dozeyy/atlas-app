import { memo } from "react";
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

/** A full card: icon, name, state, two lines of description, then where it lives. */
export const ItemCard = memo(function ItemCard({ item, onOpen }: ItemProps) {
  const shown = item.chips.slice(0, MAX_CHIPS);
  const more = item.chips.length - shown.length;
  return (
    <button
      type="button"
      data-item-card
      data-id={item.id}
      onClick={() => onOpen(item.id)}
      onKeyDown={(e) => onCopyKey(e, item)}
      aria-label={`${KIND_BY_ID[item.kind].singular} ${item.name}, ${item.scopeLabel}${item.enabled.label ? `, ${item.enabled.label}` : ""}`}
      className="press group flex h-full min-h-[104px] w-full cursor-pointer gap-3 rounded-card border border-line bg-surface p-3.5 text-left [contain-intrinsic-size:auto_112px] [content-visibility:auto] hover:border-line-strong hover:bg-raised"
    >
      <KindTile kind={item.kind} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-start justify-between gap-2">
          <span className="truncate text-body font-semibold text-ink">{item.name}</span>
          <StateChip enabled={item.enabled} />
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
          {item.modifiedMs ? (
            <span className="ml-auto text-caption text-ink-2">{relativeTime(item.modifiedMs)}</span>
          ) : null}
        </span>
      </span>
    </button>
  );
});

/** A one-line row for long, simple lists (permissions, memory, hook scripts). */
export const ItemRow = memo(function ItemRow({ item, onOpen, mono }: ItemProps & { mono?: boolean }) {
  return (
    <button
      type="button"
      data-item-card
      data-id={item.id}
      onClick={() => onOpen(item.id)}
      onKeyDown={(e) => onCopyKey(e, item)}
      aria-label={`${KIND_BY_ID[item.kind].singular} ${item.name}, ${item.scopeLabel}`}
      className="press flex min-h-9 w-full cursor-pointer items-center gap-3 border-b border-line px-4 py-1.5 text-left [contain-intrinsic-size:auto_36px] [content-visibility:auto] last:border-b-0 hover:bg-raised"
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
