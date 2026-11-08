import type { ReactNode } from "react";

export interface HBarItem {
  key: string;
  label: string;
  /** Muted second line under the label. */
  sub?: string;
  value: number;
  /** Right-hand text, already formatted. */
  right: ReactNode;
  /** Right-hand muted text under it. */
  rightSub?: ReactNode;
  title?: string;
}

/** Ranked horizontal bars for "who used the most". One hue: length is the whole message. */
export function HBars({ items, label }: { items: HBarItem[]; label: string }) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul aria-label={label} className="divide-y divide-line">
      {items.map((i) => (
        <li key={i.key} title={i.title} className="px-5 py-3">
          <div className="flex items-baseline justify-between gap-4">
            <div className="min-w-0">
              <div className="truncate text-body font-medium text-ink">{i.label}</div>
              {i.sub && <div className="truncate text-caption text-ink-2">{i.sub}</div>}
            </div>
            <div className="shrink-0 text-right">
              <div className="text-body text-ink">{i.right}</div>
              {i.rightSub && <div className="text-caption text-ink-2">{i.rightSub}</div>}
            </div>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised" aria-hidden="true">
            <div
              className="h-full rounded-full bg-accent"
              style={{ width: `${Math.max(i.value > 0 ? 2 : 0, (i.value / max) * 100)}%` }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}
