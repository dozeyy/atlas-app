import { CaretRight, SquaresFour } from "@phosphor-icons/react";
import { Card } from "../controls";
import { KindTile } from "./parts";
import { approx } from "../../lib/setup-cost";
import { KIND_BY_ID, tileBlurb, TILE_KINDS, type TileId } from "../../lib/setup-model";
import type { ItemKind } from "../../lib/setup-types";

/**
 * Twelve tiles, all the same size. 12 divides into 2, 3, 4 and 6 columns, so every
 * row is full at every width: no ragged last row. The grid takes the rest of the page,
 * so the rows grow to fill the window (never below 92px).
 */
export function TypeTiles({
  counts,
  moreCount,
  cost,
  onOpen,
}: {
  counts: Map<ItemKind, number>;
  moreCount: number;
  /** Estimated dollars a week per kind; empty until Atlas has an answer. */
  cost?: Map<ItemKind, number>;
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
      className="grid auto-rows-[96px] grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3"
    >
      {tiles.map(({ id, label, count, Icon }, i) => {
        const usd = id === "more" ? 0 : (cost?.get(id as ItemKind) ?? 0);
        return (
        <li key={id} className="row-in flex" style={{ ["--i" as string]: i }}>
          <Card
            data-tile={id}
            aria-label={`${label}, ${count}`}
            aria-describedby={usd > 0 ? `cost-${id}` : undefined}
            title={tileBlurb(id)}
            onClick={() => onOpen(id)}
            hitClassName="min-h-[92px]"
            className="flex min-h-[92px] items-center gap-3 px-3.5"
          >
            <KindTile kind={id === "more" ? "more" : (id as ItemKind)} size={44} icon={Icon} />
            <span className="min-w-0 flex-1">
              <span className="d d-tile block text-ink">{count.toLocaleString()}</span>
              <span className="block truncate text-body text-ink-2">{label}</span>
              {usd > 0 && (
                <span id={`cost-${id}`} data-cost={id} className="block truncate text-caption text-ink-2">
                  <span className="d d-small text-ink">{approx(usd)}</span> a week
                </span>
              )}
            </span>
            <CaretRight size={14} weight="bold" aria-hidden="true" className="row-caret shrink-0 text-ink-2" />
          </Card>
        </li>
        );
      })}
    </ul>
  );
}
