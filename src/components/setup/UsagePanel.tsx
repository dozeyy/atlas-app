import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getBackend } from "../../lib/ipc";
import { KIND_BY_ID, relativeTime } from "../../lib/setup-model";
import { cacheNotReady } from "../../lib/useUsage";
import { joinUsage, usageWindow } from "../../lib/usage-join";
import type { SetupItem } from "../../lib/setup-types";
import type { UsageRow } from "../../lib/usage-types";

const TOP = 5;
const NEVER_CAP = 8;

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

/**
 * What gets used and what never does, over the last 30 days. Draws nothing at all
 * when there is no data, so there is never a placeholder or a "coming soon".
 */
export function UsagePanel({ rows, items, onOpen }: { rows: UsageRow[] | null | undefined; items: SetupItem[]; onOpen?: (id: string) => void }) {
  const model = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    const byId = new Map(items.map((i) => [i.id, i]));
    const known = rows.filter((r) => byId.has(r.id));
    if (known.length === 0) return null;
    const used = known.filter((r) => r.uses30d > 0).sort((a, b) => b.uses30d - a.uses30d);
    const idle = known.filter((r) => r.uses30d === 0);
    // Anything made or changed inside the window is listed apart, never counted as unused.
    const never = idle.filter((r) => !r.isNew);
    const fresh = idle.filter((r) => r.isNew);
    if (used.length + never.length === 0) return null;
    return { byId, used, never, fresh, max: used[0]?.uses30d ?? 1 };
  }, [rows, items]);

  if (!model) return null;
  const { byId, used, never, fresh, max } = model;
  const total = used.length + never.length;
  const usedPct = Math.round((used.length / total) * 100);

  const open = (id: string, children: ReactNode) =>
    onOpen ? (
      <button type="button" onClick={() => onOpen(id)} className="press min-w-0 cursor-pointer truncate text-left text-body font-medium text-ink hover:text-accent-text">
        {children}
      </button>
    ) : (
      <span className="min-w-0 truncate text-body font-medium text-ink">{children}</span>
    );

  return (
    <section aria-labelledby="usage-title" className="rounded-card border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h2 id="usage-title" className="text-lead font-semibold text-ink">
          Used and never used
        </h2>
        <p className="text-body text-ink-2">
          {used.length} of {total} used in the last 30 days
        </p>
      </div>
      <div
        role="img"
        aria-label={`${used.length} used, ${never.length} never used`}
        className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full bg-raised"
      >
        <span style={{ width: `${usedPct}%` }} className="bg-accent" />
      </div>

      <div className="mt-4 grid gap-x-8 gap-y-4 min-[760px]:grid-cols-2">
        <div>
          <h3 className="mb-2 text-body font-semibold text-ink">Used most</h3>
          {used.length === 0 ? (
            <p className="text-body text-ink-2">Nothing has been used yet.</p>
          ) : (
            <ul className="space-y-2.5">
              {used.slice(0, TOP).map((r) => {
                const it = byId.get(r.id)!;
                return (
                  <li key={r.id}>
                    <div className="flex items-baseline gap-2">
                      {open(r.id, it.name)}
                      <span className="ml-auto shrink-0 text-caption text-ink-2">
                        {r.uses30d.toLocaleString()} {r.uses30d === 1 ? "time" : "times"}
                        {r.lastUsed ? `, ${relativeTime(r.lastUsed)}` : ""}
                      </span>
                    </div>
                    <div aria-hidden="true" className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised">
                      <div style={{ width: `${Math.max(4, Math.round((r.uses30d / max) * 100))}%` }} className="h-full rounded-full bg-accent/70" />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <h3 className="mb-2 text-body font-semibold text-ink">
            Never used <span className="font-normal text-ink-2">({never.length})</span>
          </h3>
          {never.length === 0 ? (
            <p className="text-body text-ink-2">Everything here has been used. Nice and tidy.</p>
          ) : (
            <ul className="space-y-1.5">
              {never.slice(0, NEVER_CAP).map((r) => {
                const it = byId.get(r.id)!;
                const Icon = KIND_BY_ID[it.kind].icon;
                return (
                  <li key={r.id} className="flex items-center gap-2">
                    <Icon size={14} aria-hidden="true" className="shrink-0 text-ink-2" />
                    {open(r.id, it.name)}
                    <span className="ml-auto shrink-0 text-caption text-ink-2">
                      {r.lastUsed ? `last used ${relativeTime(r.lastUsed)}` : KIND_BY_ID[it.kind].singular}
                    </span>
                  </li>
                );
              })}
              {never.length > NEVER_CAP && <li className="text-caption text-ink-2">and {never.length - NEVER_CAP} more</li>}
            </ul>
          )}
          {fresh.length > 0 && (
            <div className="mt-3">
              <h4 className="mb-1.5 text-caption font-semibold text-ink-2">New, too soon to tell</h4>
              <ul className="space-y-1.5">
                {fresh.slice(0, NEVER_CAP).map((r) => {
                  const it = byId.get(r.id)!;
                  const Icon = KIND_BY_ID[it.kind].icon;
                  return (
                    <li key={r.id} className="flex items-center gap-2">
                      <Icon size={14} aria-hidden="true" className="shrink-0 text-ink-2" />
                      {open(r.id, it.name)}
                      <span className="ml-auto shrink-0 rounded-full bg-accent-tint px-2 text-caption text-accent-text">new</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
