import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CaretDown } from "@phosphor-icons/react";
import { KindTile } from "../setup/parts";
import { Button } from "../controls";
import type { HistoryEvent } from "../../lib/historyTypes";
import { dotTone, setupKind, shortDate, timeText, whatHappened } from "../../lib/historyModel";
import type { DaySection, RowGroup } from "../../lib/historyModel";

interface Props {
  sections: DaySection[];
  selectedId: number | null;
  onSelect: (e: HistoryEvent) => void;
  /** Moving with the arrow keys also opens the change (two-pane layout). */
  selectOnMove: boolean;
  more: boolean;
  loadingMore: boolean;
  onMore: () => void;
  now: number;
}

function Row({
  group,
  selectedId,
  onSelect,
  open,
  toggle,
}: {
  group: RowGroup;
  selectedId: number | null;
  onSelect: (e: HistoryEvent) => void;
  open: boolean;
  toggle: () => void;
}) {
  const head = group.events[0];
  const many = group.events.length;
  const dated = head.kind === "dated";
  const project = head.item.project && head.item.scope !== "user" ? ` (${head.item.project})` : "";
  const picked = group.events.some((e) => e.id === selectedId);
  return (
    <li>
      <button
        type="button"
        className="hx-row hover-host"
        data-event={head.id}
        aria-current={selectedId === head.id || undefined}
        onClick={() => onSelect(head)}
      >
        <span className="hx-dot" data-tone={dotTone(head.kind)} aria-hidden="true" />
        <span className="hx-row-face">
          <KindTile kind={setupKind(head.item.kind)} size={32} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body text-ink">
              <span className="font-semibold">{whatHappened(head)}</span>{" "}
              <span className="text-ink-2">
                {head.item.name}
                {project}
              </span>
            </span>
            <span className="block truncate text-body text-ink-2">{many > 1 ? `Changed ${many} times` : head.summary}</span>
          </span>
          {!dated && <span className="shrink-0 text-caption text-ink-2">{timeText(head.at)}</span>}
        </span>
      </button>
      {many > 1 && (
        <>
          <button
            type="button"
            className="hx-sub"
            onClick={toggle}
            aria-expanded={open}
            aria-label={open ? `Hide the ${many} changes` : `Show all ${many} changes`}
          >
            <span className="hx-sub-face text-caption text-ink-2">
              <CaretDown size={12} weight="bold" aria-hidden="true" className={open ? "rotate-180" : ""} />
              {open ? "Hide" : `Show all ${many}`}
            </span>
          </button>
          {open && (
            <ul className="m-0 list-none p-0">
              {group.events.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    className="hx-sub"
                    data-event={e.id}
                    aria-current={(picked && selectedId === e.id) || undefined}
                    onClick={() => onSelect(e)}
                  >
                    <span className="hx-sub-face">
                      <span className="shrink-0 text-caption text-ink-2">{timeText(e.at)}</span>
                      <span className="min-w-0 truncate text-body text-ink">{e.summary}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </li>
  );
}

/**
 * Changes down a rail, newest first, a day at a time. Not a card: the rail and its dots are the
 * structure. Changes to the same file on the same day fold into one row.
 */
export function Timeline({ sections, selectedId, onSelect, selectOnMove, more, loadingMore, onMore, now }: Props) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const list = useRef<HTMLOListElement>(null);
  let dividerDone = false;

  const flip = (key: string) =>
    setOpen((cur) => {
      const n = new Set(cur);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  const onKeyDown = (ev: KeyboardEvent<HTMLOListElement>) => {
    if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
    const all = Array.from(list.current?.querySelectorAll<HTMLButtonElement>("button[data-event]") ?? []);
    const at = all.findIndex((b) => b === document.activeElement);
    if (at < 0) return;
    const to = all[at + (ev.key === "ArrowDown" ? 1 : -1)];
    if (!to) return;
    ev.preventDefault();
    to.focus();
    if (selectOnMove) to.click();
  };

  return (
    <div>
      <ol ref={list} className="hx-rail" aria-label="Changes" onKeyDown={onKeyDown}>
        {sections.map((s) => {
          const divider = s.before && !dividerDone;
          if (divider) dividerDone = true;
          const date = shortDate(s.start, now);
          return (
            <li key={`${s.start}:${s.before}`} className="contents">
              {divider && <div className="hx-before">Before Atlas was watching</div>}
              <h3 className="hx-day text-body font-semibold text-ink" data-day={s.start}>
                {s.label}
                {s.label !== date && <span className="ml-2 font-normal text-ink-2">{date}</span>}
              </h3>
              <ul className="m-0 list-none p-0">
                {s.rows.map((g) => (
                  <Row
                    key={g.key}
                    group={g}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    open={open.has(g.key)}
                    toggle={() => flip(g.key)}
                  />
                ))}
              </ul>
            </li>
          );
        })}
      </ol>
      {more && (
        <div className="mt-3 pl-[26px]">
          <Button onClick={onMore} disabled={loadingMore}>
            {loadingMore ? "Loading" : "Show earlier changes"}
          </Button>
        </div>
      )}
    </div>
  );
}
