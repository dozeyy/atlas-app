import { useState } from "react";
import { CaretDown, CaretRight, CheckCircle, Circle, Sparkle } from "@phosphor-icons/react";
import { Button } from "../controls";
import { useIntro } from "../../lib/motion";
import { progress, progressTitle, SETUP_STEPS, type SetupStep } from "../../lib/setup-steps";
import type { CreateKind, SetupItem } from "../../lib/setup-types";

/**
 * "Finish your toolkit", with "4 of 6" beside a growing bar. Steps tick themselves from what the
 * scan finds; done ones fold away, the rest each get a button that opens the create flow. The
 * reason for a step is its tooltip, not a sentence.
 */
export function Checklist({ items, onCreate, steps = SETUP_STEPS }: { items: SetupItem[]; onCreate: (kind: CreateKind) => void; steps?: SetupStep[] }) {
  const [showDone, setShowDone] = useState(false);
  const p = progress(items, steps);
  const pct = Math.round((p.doneCount / p.total) * 100);
  const intro = useIntro("toolkit:checklist");
  const Caret = showDone ? CaretDown : CaretRight;

  return (
    <section aria-labelledby="checklist-title" className="card px-5 py-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${p.complete ? "celebrate bg-success-tint text-success" : "bg-accent-tint text-accent-text"}`}
        >
          {p.complete ? <CheckCircle size={20} weight="fill" /> : <Sparkle size={18} weight="duotone" />}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="checklist-title" className="d d-figure text-ink">
            {progressTitle(p)}
          </h2>
        </div>
        <span className="chip chip-clay shrink-0 tabular-nums">{`${p.doneCount} of ${p.total}`}</span>
      </div>

      <div
        role="progressbar"
        aria-label="Toolkit progress"
        aria-valuemin={0}
        aria-valuemax={p.total}
        aria-valuenow={p.doneCount}
        aria-valuetext={`${p.doneCount} of ${p.total} done`}
        className={`share-bar mt-3${intro ? " intro" : ""}`}
      >
        <i style={{ width: `${pct}%` }} />
      </div>

      {p.todo.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {p.todo.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              <Circle size={18} aria-hidden="true" className="shrink-0 text-ink-2" />
              <div className="min-w-0 flex-1">
                <div className="text-body font-medium text-ink" title={s.why}>
                  {s.title}
                </div>
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
            className="row-btn group h-8 items-center gap-2 rounded-control px-1 text-body text-ink-2 hover:text-ink"
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
