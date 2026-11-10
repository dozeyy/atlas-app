import { CaretRight, SquaresFour } from "@phosphor-icons/react";
import { Card } from "../controls";
import { KindTile } from "./parts";
import { KIND_BY_ID, tileBlurb, TILE_KINDS, type TileId } from "../../lib/setup-model";
import type { ItemKind } from "../../lib/setup-types";
import { exact } from "../../lib/usage";

/**
 * Twelve tiles, all the same size. 12 divides into 2, 3, 4 and 6 columns, so every
 * row is full at every width: no ragged last row. Count and name only (what things cost is
 * shown inside each category). Rows are 72px: three rows of tiles plus
 * the panels above them fit a 1280x800 window without scrolling the page.
 */
export function TypeTiles({
  counts,
  moreCount,
  onOpen,
}: {
  counts: Map<ItemKind, number>;
  moreCount: number;
  onOpen: (id: TileId) => void;
}) {
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
      aria-label="Types of things in your toolkit"
      className="grid auto-rows-[72px] grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3"
    >
      {tiles.map(({ id, label, count, Icon }, i) => (
        <li key={id} className="row-in flex" style={{ ["--i" as string]: i }}>
          <Card
            data-tile={id}
            aria-label={`${label}, ${count}`}
            title={tileBlurb(id)}
            onClick={() => onOpen(id)}
            hitClassName="min-h-[72px]"
            className="flex min-h-[72px] items-center gap-3 px-3"
          >
            <KindTile kind={id === "more" ? "more" : (id as ItemKind)} size={44} icon={Icon} />
            <span className="min-w-0 flex-1">
              {/* An empty type steps back (same size, quieter figure) so the eye lands on what is there. */}
              <span className={`d d-tile block ${count === 0 ? "text-ink-2" : "text-ink"}`}>{exact(count)}</span>
              <span className="block truncate text-body text-ink-2">{label}</span>
            </span>
            <CaretRight size={14} weight="bold" aria-hidden="true" className="row-caret shrink-0 text-ink-2" />
          </Card>
        </li>
      ))}
    </ul>
  );
}
