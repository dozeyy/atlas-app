import type { KeyboardEvent, RefObject } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { SegmentedControl, Toggle } from "../controls";
import { OptionField, OptionsMenu } from "../OptionsMenu";
import { SelectField } from "../usage/fields";
import { DEFAULT_FILTERS } from "../../lib/setup-model";
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
  onSearchKeyDown,
  shortcut,
  shown,
  total,
  placeholder = "Search your toolkit",
}: {
  filters: Filters;
  onChange: (f: Partial<Filters>) => void;
  projects: SetupProject[];
  hidden: HiddenCounts;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Extra key handling on the search box (Down into the list). */
  onSearchKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
  /** The key hint drawn in the empty search box; left out unless Settings > Show shortcuts is on. */
  shortcut?: string;
  shown: number;
  total: number;
  placeholder?: string;
}) {
  const changed = [
    filters.scope !== DEFAULT_FILTERS.scope,
    filters.scope === "project" && filters.projectId !== null,
    filters.showWorktrees !== DEFAULT_FILTERS.showWorktrees,
    filters.showBackups !== DEFAULT_FILTERS.showBackups,
  ].filter(Boolean).length;
  const choices = projects.filter((p) => p.exists && p.itemCount > 0 && !p.isWorktree).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="sticky top-0 z-10 -mx-[var(--gutter)] mb-4 border-b border-line bg-bg px-[var(--gutter)] py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="relative min-w-[220px] flex-1">
          <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2" />
          <input
            ref={searchRef}
            type="search"
            value={filters.query}
            onChange={(e) => onChange({ query: e.target.value })}
            onKeyDown={(e) => {
              onSearchKeyDown?.(e);
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
          ) : shortcut ? (
            <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded-[4px] border border-line bg-raised px-1.5 text-caption text-ink-2">
              {shortcut}
            </kbd>
          ) : null}
        </div>

        <OptionsMenu
          label="Filters"
          count={changed}
          onReset={() =>
            onChange({
              scope: DEFAULT_FILTERS.scope,
              projectId: null,
              showWorktrees: DEFAULT_FILTERS.showWorktrees,
              showBackups: DEFAULT_FILTERS.showBackups,
            })
          }
        >
          <OptionField label="Show items from">
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
          </OptionField>
          {filters.scope === "project" && (
            <OptionField label="Project">
              <SelectField
                wide
                label="Project"
                value={filters.projectId ?? ""}
                onChange={(v) => onChange({ projectId: v || null })}
                options={[{ value: "", label: "All projects" }, ...choices.map((p) => ({ value: p.id, label: p.name }))]}
              />
            </OptionField>
          )}
          <Labeled label="Worktrees" checked={filters.showWorktrees} onChange={(v) => onChange({ showWorktrees: v })} count={hidden.worktrees} />
          <Labeled label="Backups" checked={filters.showBackups} onChange={(v) => onChange({ showBackups: v })} count={hidden.backups} />
        </OptionsMenu>
      </div>
      <p role="status" className="mt-2 text-caption text-ink-2">
        {shown === total
          ? `${total.toLocaleString()} ${total === 1 ? "item" : "items"}`
          : `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} items`}
      </p>
    </div>
  );
}
