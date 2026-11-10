import { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import { Button } from "../controls";
import { permissionBuckets, scopeRuns, type Group } from "../../lib/setup-model";
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
  // When the list mixes places (Global, a project, a plugin), each place gets its own small heading.
  const runs = scopeRuns(list);
  // A heading earns its line when a place holds several things. When every place holds one, the
  // cards share one grid (each card's chip already says where it lives), so no card sits alone
  // under its own heading beside an empty column.
  const headed = runs.length > 1 && runs.some((r) => r.items.length > 1);
  const blocks = headed ? runs : [{ label: "all", items: list }];
  return (
    <>
      {blocks.map((r) => (
        <div key={r.label} className={headed ? "mb-5 last:mb-0" : undefined}>
          {headed && (
            <h3 className="h-sub mb-2 flex items-baseline gap-2">
              {r.label}
              <span className="font-normal">{r.items.length}</span>
            </h3>
          )}
          {/* The only card on the page takes the row, as a list of one would. */}
          <div className={`grid gap-3 ${list.length === 1 ? "grid-cols-1" : "grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))]"}`}>
            {r.items.map((i) => (
              <ItemCard key={i.id} item={i} onOpen={onOpen} onDelete={onDelete} />
            ))}
          </div>
        </div>
      ))}
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
            {/* Same small heading as a place ("Global 3"): name, then the count. */}
            <h3 className="h-sub mb-2 flex items-baseline gap-2">
              {BUCKET_TITLE[b.id]}
              <span className="font-normal">{b.items.length}</span>
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
            <h2 id={`${id}-title`} className="h-section">
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
