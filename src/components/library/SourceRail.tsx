import { Plus } from "@phosphor-icons/react";
import type { SourceOption } from "../../lib/library";
import { exact } from "../../lib/usage";

/** Where plugins come from: All, Installed, the directory, and each marketplace added. 232 px at 1100 px wide and up. */
export function SourceRail({
  options,
  value,
  onChange,
  onAdd,
  counts = true,
}: {
  options: SourceOption[];
  value: string;
  /** False while the catalog loads: the counts are not known yet. */
  counts?: boolean;
  onChange: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <nav aria-label="Sources" className="flex w-[232px] shrink-0 flex-col gap-0.5 overflow-y-auto pr-1">
      {options.map((o) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            type="button"
            aria-current={on ? "true" : undefined}
            onClick={() => onChange(o.id)}
            className={`relative flex h-8 w-full cursor-pointer items-center gap-2 rounded-control px-3 text-left text-body ${
              on ? "bg-accent-tint font-medium text-accent-text" : "text-ink hover:bg-raised"
            }`}
          >
            {on && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent" />}
            <span title={o.label} className="min-w-0 flex-1 truncate">
              {o.label}
            </span>
            {o.flag && (
              <span title={o.flag.full} className="shrink-0 text-caption font-normal text-warning">
                {o.flag.short}
              </span>
            )}
            {/* A count is a number in the app's own face (tabular, so the column lines up), and it
                is only there once it is known: a rail that says "0" while it loads is wrong. */}
            {counts && <span className="shrink-0 text-caption font-normal tabular-nums text-ink-2">{exact(o.count)}</span>}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className="mt-1 flex h-8 w-full cursor-pointer items-center gap-2 rounded-control px-3 text-left text-body text-accent-text hover:bg-raised"
      >
        <Plus size={14} weight="bold" aria-hidden="true" />
        Add a marketplace
      </button>
    </nav>
  );
}
