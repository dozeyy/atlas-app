import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { Ring } from "../charts/Ring";
import { getBackend } from "../../lib/ipc";
import { KIND_BY_ID, relativeTime } from "../../lib/setup-model";
import { cacheNotReady } from "../../lib/useUsage";
import { joinUsage, usageWindow } from "../../lib/usage-join";
import type { SetupItem } from "../../lib/setup-types";
import type { UsageRow } from "../../lib/usage-types";
import { MiniKind } from "./parts";

// A glance, not an inventory: the full lists are one tile away. These caps keep the panel short
// enough that the whole Toolkit page fits a 1280x800 window beside the cost ranking. The dust
// field holds about six rows of squares; past that it says how many more there are.
const TOP = 4;
const DUST_CAP = 78;

/**
 * Skills and agents joined to the last 30 days of real use, or null when the usage
 * engine has no answer (still reading, failed, nothing indexed): the panel then
 * draws nothing at all.
 */
export function useUsageRows(items: SetupItem[], reloadKey: number): UsageRow[] | null {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [bump, setBump] = useState(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  // The numbers changed (new sessions were read): ask again.
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    getBackend()
      .onUsageChanged(() => setBump((n) => n + 1))
      .then((fn) => (alive ? (off = fn) : fn()))
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const backend = getBackend();
    const { from, to } = usageWindow();
    (async () => {
      const status = await backend.usageStatus();
      if (cacheNotReady(status) || status.state === "error" || status.filesTracked === 0) return null;
      const [skills, agents] = await Promise.all([
        backend.usageByItem({ kind: "skill", from, to, limit: 5000 }),
        backend.usageByItem({ kind: "agent", from, to, limit: 5000 }),
      ]);
      return joinUsage(itemsRef.current, skills, agents);
    })()
      .then((r) => alive && setRows(r))
      .catch(() => alive && setRows(null));
    return () => {
      alive = false;
    };
  }, [reloadKey, bump]);
  return rows;
}

/** What a dust cell says on hover: its name, what it is, and when (if ever) it was last used. */
function dustLine(it: SetupItem, r: UsageRow): string {
  const last = r.lastUsed ? `last used ${relativeTime(r.lastUsed)}` : "never used";
  return `${it.name} (${KIND_BY_ID[it.kind].singular}), ${last}`;
}

/**
 * Everything unused as a field of little squares: dozens fit in a handful of rows. Hover or
 * focus one to read its name in the line below; click to open it. Arrow keys walk the field
 * (one tab stop for the whole thing). Something added recently and not used since is never
 * used too: the uses are counted from the transcripts, so "too soon to tell" is never needed.
 */
function DustField({
  never,
  byId,
  onOpen,
}: {
  never: UsageRow[];
  byId: Map<string, SetupItem>;
  onOpen?: (id: string) => void;
}) {
  const [peek, setPeek] = useState<string | null>(null);
  const field = useRef<HTMLDivElement>(null);
  const shown = never.slice(0, DUST_CAP);
  const hiddenCount = never.length - shown.length;

  // Arrow keys move between squares; Up/Down pick the square nearest in the row above or below.
  const onKey = (e: KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    const cells = Array.from(field.current?.querySelectorAll<HTMLElement>("[data-dust]") ?? []);
    const at = cells.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    let next: HTMLElement | undefined;
    if (e.key === "ArrowLeft") next = cells[at - 1];
    else if (e.key === "ArrowRight") next = cells[at + 1];
    else {
      const here = cells[at]!.getBoundingClientRect();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const rows = cells.filter((c) => (c.getBoundingClientRect().top - here.top) * dir > 2);
      const rowTop = rows.length ? (dir === 1 ? Math.min : Math.max)(...rows.map((c) => c.getBoundingClientRect().top)) : null;
      next = rows
        .filter((c) => Math.abs(c.getBoundingClientRect().top - (rowTop ?? 0)) < 2)
        .sort((a, b) => Math.abs(a.getBoundingClientRect().left - here.left) - Math.abs(b.getBoundingClientRect().left - here.left))[0];
    }
    next?.focus();
  };

  const cell = (r: UsageRow, tab: boolean) => {
    const it = byId.get(r.id)!;
    const line = dustLine(it, r);
    const look = "bg-chart-4/60 group-hover/cell:bg-chart-4 group-focus-visible/cell:bg-chart-4";
    const face = (
      <span
        aria-hidden="true"
        className={`block size-4 rounded-[5px] transition-[transform,background-color] duration-[var(--dur-fast)] group-hover/cell:scale-125 group-focus-visible/cell:scale-125 ${look}`}
      />
    );
    const common = {
      "data-dust": r.id,
      title: line,
      onMouseEnter: () => setPeek(line),
      onMouseLeave: () => setPeek(null),
      onFocus: () => setPeek(line),
      onBlur: () => setPeek(null),
      className: "group/cell flex size-[22px] shrink-0 items-center justify-center",
    };
    return onOpen ? (
      <button key={r.id} type="button" aria-label={line} tabIndex={tab ? 0 : -1} onClick={() => onOpen(r.id)} {...common} className={`${common.className} cursor-pointer`}>
        {face}
      </button>
    ) : (
      <span key={r.id} role="img" aria-label={line} {...common}>
        {face}
      </span>
    );
  };

  return (
    <div ref={field} onKeyDown={onKey}>
      <div className="flex flex-wrap" data-dust-field>
        {shown.map((r, i) => cell(r, i === 0))}
        {hiddenCount > 0 && (
          <span className="flex h-[22px] items-center pl-1.5 text-caption text-ink-2" title={`${hiddenCount} more never used, not drawn here`}>
            +{hiddenCount}
          </span>
        )}
      </div>
      {never.length > 0 && (
        <p aria-live="polite" className="mt-1.5 h-5 truncate text-caption text-ink-2">
          {peek ?? "Gathering dust. Hover one to see which."}
        </p>
      )}
    </div>
  );
}

/**
 * What gets used and what never does, over the last 30 days: a ring for how much of the
 * toolkit earns its place, the favourites beside it, and the unused as a field of dust you
 * can hover. Draws nothing at all when there is no data, so there is never a placeholder or
 * a "coming soon".
 */
export function UsagePanel({ rows, items, onOpen }: { rows: UsageRow[] | null | undefined; items: SetupItem[]; onOpen?: (id: string) => void }) {
  const model = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const byId = new Map(items.map((i) => [i.id, i]));
    const known = rows.filter((r) => byId.has(r.id));
    if (known.length === 0) return null;
    const used = known.filter((r) => r.uses30d > 0).sort((a, b) => b.uses30d - a.uses30d);
    // Unused in the window is never used, new or not: the count comes from the transcripts.
    const never = known.filter((r) => r.uses30d === 0);
    if (used.length + never.length === 0) return null;
    return { byId, used, never, max: used[0]?.uses30d ?? 1 };
  }, [rows, items]);

  if (!model) return null;
  const { byId, used, never, max } = model;
  const total = used.length + never.length;

  const open = (id: string, children: ReactNode) =>
    onOpen ? (
      <button type="button" onClick={() => onOpen(id)} className="press min-w-0 cursor-pointer text-left text-body font-medium text-ink hover:text-accent-text">
        <span className="block truncate">{children}</span>
      </button>
    ) : (
      <span className="min-w-0 truncate text-body font-medium text-ink">{children}</span>
    );

  return (
    <section aria-labelledby="usage-title" className="@container min-w-0 rounded-card border border-line bg-surface px-5 py-4">
      <div className="flex items-baseline gap-x-3">
        <h2 id="usage-title" className="text-lead font-semibold text-ink">
          Used and never used
        </h2>
        <p className="ml-auto text-caption text-ink-2">Last 30 days</p>
      </div>

      <div className="mt-3 grid gap-x-8 gap-y-4 @min-[560px]:grid-cols-2">
        <div className="flex min-w-0 items-center gap-4">
          <Ring
            id="usage:ring"
            size={104}
            stroke={11}
            frac={used.length / total}
            label={`${used.length} of ${total} used in the last 30 days`}
          >
            <div className="flex flex-col items-center leading-none">
              <span className="d d-figure text-ink">{used.length}</span>
              <span className="mt-1 text-caption text-ink-2">of {total} used</span>
            </div>
          </Ring>
          <div className="min-w-0 flex-1">
            <h3 className="mb-1.5 text-body font-semibold text-ink">Used most</h3>
            {used.length === 0 ? (
              <p className="text-body text-ink-2">Nothing has been used yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {used.slice(0, TOP).map((r) => {
                  const it = byId.get(r.id)!;
                  return (
                    <li key={r.id} title={`${it.name}: ${r.uses30d.toLocaleString()} ${r.uses30d === 1 ? "time" : "times"}${r.lastUsed ? `, last ${relativeTime(r.lastUsed)}` : ""}`}>
                      <div className="flex items-baseline gap-2">
                        <MiniKind kind={it.kind} name={it.name} />
                        {open(r.id, it.name)}
                        <span className="ml-auto shrink-0 text-caption text-ink-2">
                          <span className="d d-small text-ink">{r.uses30d.toLocaleString()}</span>x
                        </span>
                      </div>
                      <div aria-hidden="true" className="mt-0.5 h-1 overflow-hidden rounded-full bg-raised">
                        <div style={{ width: `${Math.max(4, Math.round((r.uses30d / max) * 100))}%` }} className="h-full rounded-full bg-accent/70" />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <h3 className="mb-1.5 flex items-baseline gap-2 text-body font-semibold text-ink">
            Never used
            <span className="d d-figure font-normal text-ink-2" aria-label={`${never.length}`}>
              {never.length}
            </span>
          </h3>
          {never.length === 0 ? (
            <p className="text-body text-ink-2">Everything here has been used. Nice and tidy.</p>
          ) : (
            <DustField never={never} byId={byId} onOpen={onOpen} />
          )}
        </div>
      </div>
    </section>
  );
}
