import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Ring } from "../charts/Ring";
import { getBackend } from "../../lib/ipc";
import { KIND_BY_ID, relativeTime } from "../../lib/setup-model";
import { cacheNotReady } from "../../lib/useUsage";
import { joinUsage, usageWindow } from "../../lib/usage-join";
import { exact } from "../../lib/usage";
import type { SetupItem } from "../../lib/setup-types";
import type { UsageRow } from "../../lib/usage-types";
import { MiniKind } from "./parts";

// A glance, not an inventory: the full lists are one tile away. The favourites are capped, and
// the unused show their first few names with the rest one press away.
const TOP = 4;
const NAMED = 8;

/** One unused item: a small raised tag (control radius, never a pill) with its picture and name. */
const TAG =
  "inline-flex h-7 max-w-full items-center gap-2 rounded-control border border-transparent bg-raised pl-1 pr-2 text-caption font-medium text-ink transition-colors duration-[var(--dur-fast)]";
const TAG_HOT = "hover:border-line-strong hover:text-accent-text";

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

/** What an unused item says on hover: its name, what it is, and when (if ever) it was last used. */
function neverLine(it: SetupItem, r: UsageRow): string {
  const last = r.lastUsed ? `last used ${relativeTime(r.lastUsed)}` : "never used";
  return `${it.name} (${KIND_BY_ID[it.kind].singular}), ${last}`;
}

/**
 * Everything unused, by name: each one is its kind's picture and its name, A to Z, and opens
 * when pressed. The first few show; "+12 more" lays out the rest in place. Something added
 * recently and not used since is never used too: the uses are counted from the transcripts,
 * so "too soon to tell" is never needed.
 */
function NeverList({
  never,
  byId,
  onOpen,
}: {
  never: UsageRow[];
  byId: Map<string, SetupItem>;
  onOpen?: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  const sorted = useMemo(
    () => [...never].sort((a, b) => byId.get(a.id)!.name.localeCompare(byId.get(b.id)!.name, undefined, { numeric: true, sensitivity: "base" })),
    [never, byId],
  );
  const shown = all ? sorted : sorted.slice(0, NAMED);
  const rest = sorted.length - NAMED;

  return (
    <ul data-never-list className="flex flex-wrap gap-2">
      {shown.map((r) => {
        const it = byId.get(r.id)!;
        const line = neverLine(it, r);
        const face = (
          <>
            <MiniKind kind={it.kind} name={it.name} />
            <span className="truncate">{it.name}</span>
          </>
        );
        return (
          <li key={r.id} className="min-w-0 max-w-full">
            {onOpen ? (
              <button type="button" data-never={r.id} title={line} onClick={() => onOpen(r.id)} className={`${TAG} ${TAG_HOT} press cursor-pointer`}>
                {face}
              </button>
            ) : (
              <span data-never={r.id} title={line} className={TAG}>
                {face}
              </span>
            )}
          </li>
        );
      })}
      {rest > 0 && (
        <li>
          <button type="button" aria-expanded={all} onClick={() => setAll((v) => !v)} className={`${TAG} ${TAG_HOT} press cursor-pointer !bg-transparent !pl-2 !border-line text-ink-2`}>
            {all ? "Show fewer" : `+${exact(rest)} more`}
          </button>
        </li>
      )}
    </ul>
  );
}

/**
 * What gets used and what never does, over the last 30 days: a ring for how much of the
 * toolkit earns its place, the favourites beside it, and the unused by name. Draws nothing
 * at all when there is no data, so there is never a placeholder or a "coming soon".
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
        <h2 id="usage-title" className="h-section">
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
            <h3 className="h-sub mb-2">Used most</h3>
            {used.length === 0 ? (
              <p className="text-body text-ink-2">Nothing has been used yet.</p>
            ) : (
              <ul className="space-y-2">
                {used.slice(0, TOP).map((r) => {
                  const it = byId.get(r.id)!;
                  return (
                    <li key={r.id} title={`${it.name}: ${exact(r.uses30d)} ${r.uses30d === 1 ? "time" : "times"}${r.lastUsed ? `, last ${relativeTime(r.lastUsed)}` : ""}`}>
                      <div className="flex items-baseline gap-2">
                        <MiniKind kind={it.kind} name={it.name} />
                        {open(r.id, it.name)}
                        <span className="ml-auto shrink-0 text-caption text-ink-2">
                          <span className="d d-small text-ink">{exact(r.uses30d)}</span>x
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
          <h3 className="h-sub mb-2 flex items-baseline gap-2">
            Never used
            <span className="d d-small text-ink" aria-label={`${never.length}`}>
              {never.length}
            </span>
          </h3>
          {never.length === 0 ? (
            <p className="text-body text-ink-2">Everything here has been used. Nice and tidy.</p>
          ) : (
            <NeverList never={never} byId={byId} onOpen={onOpen} />
          )}
        </div>
      </div>
    </section>
  );
}
