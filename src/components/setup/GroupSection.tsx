import { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { Button } from "../controls";
import { permissionBuckets, type Group } from "../../lib/setup-model";
import { ItemCard, ItemRow } from "./ItemViews";
import { KindTile } from "./parts";
import type { SetupItem } from "../../lib/setup-types";

const CARD_CAP = 24;
const ROW_CAP = 60;

const BUCKET_TITLE = { deny: "Blocked", ask: "Asks first", allow: "Allowed", other: "Other rules" } as const;

function ShowMore({ hidden, onClick }: { hidden: number; onClick: () => void }) {
  return (
    <Button className="mt-3" onClick={onClick}>
      Show {hidden} more
    </Button>
  );
}

function Cards({ items, onOpen, onDelete }: { items: SetupItem[]; onOpen: (id: string) => void; onDelete?: (item: SetupItem) => void }) {
  const [all, setAll] = useState(false);
  const list = all ? items : items.slice(0, CARD_CAP);
  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3">
        {list.map((i) => (
          <ItemCard key={i.id} item={i} onOpen={onOpen} onDelete={onDelete} />
        ))}
      </div>
      {!all && items.length > CARD_CAP && <ShowMore hidden={items.length - CARD_CAP} onClick={() => setAll(true)} />}
    </>
  );
}

function Rows({ items, onOpen, mono }: { items: SetupItem[]; onOpen: (id: string) => void; mono: boolean }) {
  const [all, setAll] = useState(false);
  const list = all ? items : items.slice(0, ROW_CAP);
  return (
    <>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {list.map((i) => (
          <ItemRow key={i.id} item={i} onOpen={onOpen} mono={mono} />
        ))}
      </div>
      {!all && items.length > ROW_CAP && <ShowMore hidden={items.length - ROW_CAP} onClick={() => setAll(true)} />}
    </>
  );
}

export function GroupBody({
  group,
  onOpenItem,
  onDelete,
}: {
  group: Group;
  onOpenItem: (id: string) => void;
  onDelete?: (item: SetupItem) => void;
}) {
  const { meta, items } = group;
  if (meta.kind === "permission") {
    return (
      <>
        {permissionBuckets(items).map((b) => (
          <div key={b.id} className="mb-4 last:mb-0">
            <h3 className="mb-2 text-body font-medium text-ink-2">
              {BUCKET_TITLE[b.id]} <span className="font-normal">({b.items.length})</span>
            </h3>
            <Rows items={b.items} onOpen={onOpenItem} mono />
          </div>
        ))}
      </>
    );
  }
  if (meta.compact) return <Rows items={items} onOpen={onOpenItem} mono={meta.kind === "hookScript" || meta.kind === "other"} />;
  return <Cards items={items} onOpen={onOpenItem} onDelete={onDelete} />;
}

export function GroupSection({
  group,
  open,
  onToggle,
  onOpenItem,
  onDelete,
}: {
  group: Group;
  open: boolean;
  onToggle: () => void;
  onOpenItem: (id: string) => void;
  onDelete?: (item: SetupItem) => void;
}) {
  const { meta, items } = group;
  const id = `group-${meta.kind}`;
  const Caret = open ? CaretDown : CaretRight;
  return (
    <section aria-labelledby={`${id}-title`} className="mb-8">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={`${id}-body`}
        title={meta.blurb}
        className="row-btn group mb-3 items-center gap-3 rounded-card p-1 text-left"
      >
        <KindTile kind={meta.kind} size={32} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <h2 id={`${id}-title`} className="d d-figure text-ink">
              {meta.plural}
            </h2>
            <span className="chip">{items.length}</span>
          </span>
        </span>
        <Caret size={16} aria-hidden="true" className="shrink-0 text-ink-2 group-hover:text-ink" />
      </button>
      {open && (
        <div id={`${id}-body`} className="fade-in">
          <GroupBody group={group} onOpenItem={onOpenItem} onDelete={onDelete} />
        </div>
      )}
    </section>
  );
}
