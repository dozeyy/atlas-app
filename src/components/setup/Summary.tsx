import { FolderSimple, Lock } from "@phosphor-icons/react";
import { Card } from "../controls";
import { KINDS, type ScopeCounts } from "../../lib/setup-model";
import type { ItemKind, SetupSnapshot } from "../../lib/setup-types";

const SEGMENTS: { key: keyof ScopeCounts; label: string; bar: string }[] = [
  { key: "global", label: "Global", bar: "bg-accent" },
  { key: "project", label: "Project", bar: "bg-slate" },
  { key: "plugin", label: "Plugin", bar: "bg-warning" },
  { key: "claudeAi", label: "claude.ai", bar: "bg-success" },
  { key: "managed", label: "Managed", bar: "bg-ink-2" },
];

export function Summary({
  snapshot,
  total,
  kindCounts,
  scopeCounts,
  activeKind,
  onKind,
  live,
}: {
  snapshot: SetupSnapshot;
  total: number;
  kindCounts: Map<ItemKind, number>;
  scopeCounts: ScopeCounts;
  activeKind: ItemKind | null;
  onKind: (k: ItemKind | null) => void;
  live: boolean;
}) {
  const projects = snapshot.projects.filter((p) => p.exists && p.itemCount > 0).length;
  const scoped = SEGMENTS.filter((s) => scopeCounts[s.key] > 0);
  const tiles = KINDS.filter((k) => k.headline && (kindCounts.get(k.kind) ?? 0) > 0);
  return (
    <>
      <Card className="mb-4 px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FolderSimple size={18} weight="duotone" aria-hidden="true" className="shrink-0 text-accent-text" />
          <code className="selectable min-w-0 flex-1 truncate text-ink" title={snapshot.root.dir}>
            {snapshot.root.dir}
          </code>
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-raised px-2.5 text-caption font-medium text-ink-2">
            <Lock size={12} weight="bold" aria-hidden="true" />
            Read only
          </span>
          {live && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-success-tint px-2.5 text-caption font-medium text-success">
              <span aria-hidden="true" className="pulse-dot size-1.5 rounded-full bg-success" />
              Live
            </span>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-baseline gap-x-2">
          <span className="text-title font-semibold tracking-[-0.01em] text-ink">{total.toLocaleString()}</span>
          <span className="text-lead text-ink-2">
            {total === 1 ? "item" : "items"} across {projects} {projects === 1 ? "project" : "projects"}
          </span>
          <span className="ml-auto text-caption text-ink-2">Scanned in {snapshot.elapsedMs} ms</span>
        </div>

        {scoped.length > 0 && (
          <>
            <div role="img" aria-label={scoped.map((s) => `${s.label} ${scopeCounts[s.key]}`).join(", ")} className="mt-3 flex h-2 gap-0.5 overflow-hidden rounded-full">
              {scoped.map((s) => (
                <span key={s.key} style={{ flexGrow: scopeCounts[s.key] }} className={`${s.bar} min-w-1 basis-0`} />
              ))}
            </div>
            <ul className="mt-2.5 flex flex-wrap gap-x-5 gap-y-1">
              {scoped.map((s) => (
                <li key={s.key} className="flex items-center gap-1.5 text-caption text-ink-2">
                  <span aria-hidden="true" className={`size-2 rounded-full ${s.bar}`} />
                  {s.label}
                  <span className="font-semibold text-ink">{scopeCounts[s.key].toLocaleString()}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {tiles.length > 0 && (
        <ul aria-label="Filter by type" className="mb-6 grid grid-cols-[repeat(auto-fill,minmax(136px,1fr))] gap-2.5">
          {tiles.map((k) => {
            const active = activeKind === k.kind;
            const Icon = k.icon;
            return (
              <li key={k.kind}>
                <button
                  type="button"
                  aria-pressed={active}
                  onClick={() => onKind(active ? null : k.kind)}
                  className={`press flex w-full cursor-pointer items-center gap-3 rounded-card border p-3 text-left ${
                    active ? "border-accent bg-accent-tint" : "border-line bg-surface hover:border-line-strong hover:bg-raised"
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex size-8 shrink-0 items-center justify-center rounded-control ${
                      active ? "bg-surface text-accent-text" : "bg-accent-tint text-accent-text"
                    }`}
                  >
                    <Icon size={18} weight="duotone" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-subtitle font-semibold leading-6 text-ink">
                      {(kindCounts.get(k.kind) ?? 0).toLocaleString()}
                    </span>
                    <span className="block truncate text-caption text-ink-2">{k.plural}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
