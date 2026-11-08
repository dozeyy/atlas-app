import { SquaresFour } from "@phosphor-icons/react";
import { KIND_BY_ID, TILE_KINDS, type TileId } from "../../lib/setup-model";
import type { ItemKind } from "../../lib/setup-types";

/**
 * Twelve tiles, all the same size. 12 divides into 2, 3, 4 and 6 columns, so every
 * row is full at every width: no ragged last row.
 */
export function TypeTiles({ counts, moreCount, onOpen }: { counts: Map<ItemKind, number>; moreCount: number; onOpen: (id: TileId) => void }) {
  const tiles: { id: TileId; label: string; singular: string; count: number; Icon: (typeof KIND_BY_ID)[ItemKind]["icon"] }[] = [
    ...TILE_KINDS.map((k) => ({
      id: k as TileId,
      label: KIND_BY_ID[k].plural,
      singular: KIND_BY_ID[k].singular,
      count: counts.get(k) ?? 0,
      Icon: KIND_BY_ID[k].icon,
    })),
    { id: "more", label: "More", singular: "other file", count: moreCount, Icon: SquaresFour },
  ];
  return (
    <ul
      aria-label="Types of things in your setup"
      className="grid grid-cols-2 gap-3 min-[640px]:grid-cols-3 min-[1100px]:grid-cols-4 min-[1400px]:grid-cols-6"
    >
      {tiles.map(({ id, label, count, Icon }) => (
        <li key={id}>
          <button
            type="button"
            data-tile={id}
            aria-label={`${label}, ${count}`}
            onClick={() => onOpen(id)}
            className="press group flex h-[92px] w-full cursor-pointer items-center gap-3 rounded-card border border-line bg-surface px-3.5 text-left hover:border-line-strong hover:bg-raised"
          >
            <span
              aria-hidden="true"
              className="flex size-10 shrink-0 items-center justify-center rounded-control bg-accent-tint text-accent-text transition-transform duration-[var(--dur)] ease-[var(--ease-out)] group-hover:scale-105"
            >
              <Icon size={22} weight="duotone" />
            </span>
            <span className="min-w-0">
              <span className="block text-title font-semibold leading-8 tracking-[-0.01em] text-ink">{count.toLocaleString()}</span>
              <span className="block truncate text-body text-ink-2">{label}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
