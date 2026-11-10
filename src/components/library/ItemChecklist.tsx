import { Check } from "@phosphor-icons/react";
import { itemWord } from "../../lib/library";
import type { InnerItem, Taken } from "../../lib/libraryTypes";

export const itemKey = (i: InnerItem) => `${i.kind}:${i.name}:${i.rel}`;

/** The skills, agents, commands and the like a repository holds, each one tickable. A name the person already has is left unticked and says so. */
export function ItemChecklist({
  items,
  taken,
  ticked,
  onToggle,
}: {
  items: InnerItem[];
  taken: Taken[];
  ticked: Set<string>;
  onToggle: (key: string) => void;
}) {
  const takenBy = (i: InnerItem) => taken.find((t) => t.kind === i.kind && t.name === i.name);
  return (
    <ul className="grid gap-0.5" aria-label="Things to install">
      {items.map((i) => {
        const key = itemKey(i);
        const t = takenBy(i);
        const on = !t && ticked.has(key);
        return (
          <li key={key}>
            <label
              className={`flex items-start gap-2.5 rounded-control px-2 py-1.5 text-body ${t ? "cursor-default opacity-70" : "cursor-pointer hover:bg-raised"}`}
            >
              <input type="checkbox" className="peer sr-only" checked={on} disabled={!!t} onChange={() => onToggle(key)} />
              <span
                aria-hidden="true"
                className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--focus-ring)] ${on ? "border-transparent bg-accent-solid text-on-accent" : "border-line-strong bg-surface"}`}
              >
                {on && <Check size={12} weight="bold" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-ink">{i.name}</span>
                  <span className="shrink-0 text-caption text-ink-2">{itemWord(i.kind)}</span>
                </span>
                {t && <span className="block text-caption text-ink-2">You already have one called {i.name}.</span>}
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}
