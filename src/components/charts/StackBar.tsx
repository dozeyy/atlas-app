import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { stackFlex } from "../../lib/chartPaths";
import { useIntro } from "../../lib/motion";
import type { TokenKinds } from "../../lib/usage";
import { tokensTip } from "../../lib/usage";
import { stepIndex } from "./shared";

export interface StackItem {
  key: string;
  label: string;
  value: number;
  /** 1-4: which --chart-N colour. */
  tone: number;
  /** Right-hand text of the legend row, already formatted. */
  right: ReactNode;
  /** Small share text ("62%"). */
  share: string;
  title?: string;
  /** Tokens by kind: the hover lists them and adds them all together. */
  kinds?: TokenKinds | null;
}

/** The hover of one row: the count with its kinds when known, then the row's own line. */
function rowTitle(it: StackItem): string | undefined {
  if (!it.kinds) return it.title;
  return it.title ? `${tokensTip(it.value, it.kinds)}
${it.title}` : tokensTip(it.value, it.kinds);
}

/**
 * One 14 px bar split by share (it grows to 22 px under the pointer, the rest step back to
 * 35 %), and a legend whose rows light up with it. Both are one control: hovering a row or a
 * segment, or the arrow keys, pick the same item.
 */
export function StackBar({ id, items, label }: { id: string; items: StackItem[]; label: string }) {
  const intro = useIntro(id);
  const [on, setOn] = useState<number | null>(null);
  const flex = stackFlex(items.map((i) => i.value));

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = stepIndex(e.key, on, items.length);
    if (next === undefined) return;
    e.preventDefault();
    setOn(next);
  };

  return (
    <div
      role="group"
      aria-label={`${label}. Use the left and right arrow keys to read each part.`}
      tabIndex={0}
      onKeyDown={onKey}
      onBlur={() => setOn(null)}
      onPointerLeave={() => setOn(null)}
      className={`chart-focus${intro ? " intro" : ""}`}
    >
      <div className="stack">
        {items.map((it, i) => (
          <div
            key={it.key}
            className={`seg-bar${on === i ? " on" : ""}`}
            title={rowTitle(it)}
            style={{ flex: `${Math.max(flex[i], 0.01)} 1 0`, background: `var(--chart-${it.tone})`, ["--i" as string]: i }}
            onPointerEnter={() => setOn(i)}
          />
        ))}
      </div>
      <ul className="mt-2">
        {items.map((it, i) => (
          <li
            key={it.key}
            className={`legend-row${on === i ? " on" : ""}`}
            onPointerEnter={() => setOn(i)}
            title={rowTitle(it)}
          >
            <span className="dot" style={{ background: `var(--chart-${it.tone})` }} aria-hidden="true" />
            <span className="min-w-0 truncate text-body text-ink">{it.label}</span>
            <span className="text-body tabular-nums text-ink-2">{it.right}</span>
            <span className="text-right text-body font-medium tabular-nums text-ink">{it.share}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
