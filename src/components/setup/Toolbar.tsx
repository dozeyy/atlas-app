import type { RefObject } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { SegmentedControl, Toggle } from "../controls";
import type { Filters, ScopeFilter } from "../../lib/setup-model";
import type { HiddenCounts, SetupProject } from "../../lib/setup-types";

function Labeled({ label, checked, onChange, count }: { label: string; checked: boolean; onChange: (v: boolean) => void; count?: number }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-body text-ink">
      <Toggle checked={checked} onChange={onChange} label={label} />
      <span>
        {label}
        {count ? <span className="ml-1 text-ink-2">({count})</span> : null}
      </span>
    </label>
  );
}

export function Toolbar({
  filters,
  onChange,
  projects,
  hidden,
  searchRef,
  shortcut,
  shown,
  total,
  placeholder = "Search your setup",
}: {
  filters: Filters;
  onChange: (f: Partial<Filters>) => void;
  projects: SetupProject[];
  hidden: HiddenCounts;
  searchRef: RefObject<HTMLInputElement | null>;
  shortcut: string;
  shown: number;
  total: number;
  placeholder?: string;
}) {
  const choices = projects.filter((p) => p.exists && p.itemCount > 0 && !p.isWorktree).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="sticky top-0 z-10 -mx-10 mb-6 border-b border-line bg-bg px-10 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="relative min-w-[220px] flex-1">
          <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2" />
          <input
            ref={searchRef}
            type="search"
            value={filters.query}
            onChange={(e) => onChange({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape" && filters.query) {
                e.preventDefault();
                onChange({ query: "" });
              }
            }}
            placeholder={placeholder}
            aria-label={placeholder}
            spellCheck={false}
            className="selectable h-9 w-full rounded-control border border-line-strong bg-surface pl-9 pr-16 text-body text-ink placeholder:text-ink-2 [&::-webkit-search-cancel-button]:hidden"
          />
          {filters.query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                onChange({ query: "" });
                searchRef.current?.focus();
              }}
              className="press absolute right-2 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-[4px] border border-line bg-raised px-1.5 text-caption text-ink-2">
              {shortcut}
            </kbd>
          )}
        </div>

        <SegmentedControl<ScopeFilter>
          label="Show items from"
          value={filters.scope}
          options={[
            { value: "all", label: "All" },
            { value: "global", label: "Global" },
            { value: "project", label: "Projects" },
          ]}
          onChange={(scope) => onChange({ scope, projectId: scope === "project" ? filters.projectId : null })}
        />

      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-5 gap-y-2">
        {filters.scope === "project" && (
          <select
            aria-label="Project"
            value={filters.projectId ?? ""}
            onChange={(e) => onChange({ projectId: e.target.value || null })}
            className="h-8 max-w-[220px] cursor-pointer rounded-control border border-line-strong bg-surface px-2 text-body text-ink"
          >
            <option value="">All projects</option>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}

        <Labeled label="Worktrees" checked={filters.showWorktrees} onChange={(v) => onChange({ showWorktrees: v })} count={hidden.worktrees} />
        <Labeled label="Backups" checked={filters.showBackups} onChange={(v) => onChange({ showBackups: v })} count={hidden.backups} />
        <p role="status" className="ml-auto text-caption text-ink-2">
          {shown === total
            ? `${total.toLocaleString()} ${total === 1 ? "item" : "items"}`
            : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} items`}
        </p>
      </div>
    </div>
  );
}
