import { useState } from "react";
import { CaretDown, CaretRight, CheckCircle, Circle, Sparkle } from "@phosphor-icons/react";
import { Button } from "../controls";
import { progress, progressTitle, SETUP_STEPS, type SetupStep } from "../../lib/setup-steps";
import type { CreateKind, SetupItem } from "../../lib/setup-types";

/**
 * "Your setup: 4 of 6 done". Steps tick themselves from what the scan finds; done
 * ones fold away, the rest each get a button that opens the create flow.
 */
export function Checklist({ items, onCreate, steps = SETUP_STEPS }: { items: SetupItem[]; onCreate: (kind: CreateKind) => void; steps?: SetupStep[] }) {
  const [showDone, setShowDone] = useState(false);
  const p = progress(items, steps);
  const pct = Math.round((p.doneCount / p.total) * 100);
  const Caret = showDone ? CaretDown : CaretRight;

  return (
    <section aria-labelledby="checklist-title" className="rounded-card border border-line bg-surface px-5 py-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${p.complete ? "celebrate bg-success-tint text-success" : "bg-accent-tint text-accent-text"}`}
        >
          {p.complete ? <CheckCircle size={20} weight="fill" /> : <Sparkle size={18} weight="duotone" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="checklist-title" className="text-lead font-semibold text-ink">
            {progressTitle(p)}
          </h2>
          <p className="text-body text-ink-2">
            {p.complete ? "Everything on the list is in place. Claude knows you well now." : "A few small things that make Claude feel like yours."}
          </p>
        </div>
        <span className="shrink-0 text-body font-semibold text-ink-2">{pct}%</span>
      </div>

      <div
        role="progressbar"
        aria-label="Setup progress"
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-valuenow={p.doneCount}
        aria-valuetext={`${p.doneCount} of ${p.total} done`}
        className="mt-3 h-2 overflow-hidden rounded-full bg-raised"
      >
        <div style={{ width: `${pct}%` }} className="h-full rounded-full bg-accent transition-[width] duration-[var(--dur-slow)] ease-[var(--ease-out)]" />
      </div>

      {p.todo.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {p.todo.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              <Circle size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-ink">{s.title}</div>
                <div className="line-clamp-2 text-body text-ink-2">{s.why}</div>
              </div>
              <Button onClick={() => onCreate(s.create)} aria-label={`${s.action}: ${s.title}`}>
                {s.action}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {p.done.length > 0 && (
        <div className={p.todo.length > 0 ? "border-t border-line pt-2" : "mt-2"}>
          <button
            type="button"
            aria-expanded={showDone}
            onClick={() => setShowDone((v) => !v)}
            className="press group flex h-8 w-full cursor-pointer items-center gap-2 rounded-control text-left text-body text-ink-2 hover:text-ink"
          >
            <Caret size={14} aria-hidden="true" />
            {p.done.length} done
          </button>
          {showDone && (
            <ul className="fade-in pb-1">
              {p.done.map((s) => (
                <li key={s.id} className="flex items-center gap-3 py-1.5 text-body text-ink-2">
                  <CheckCircle size={18} weight="fill" aria-hidden="true" className="shrink-0 text-success" />
                  {s.title}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
