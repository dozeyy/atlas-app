import { useState } from "react";
import { CaretDown, CaretRight, CaretUp, CheckCircle, Circle, Sparkle } from "@phosphor-icons/react";
import { Button, IconButton } from "../controls";
import { useIntro } from "../../lib/motion";
import { progress, progressTitle, SETUP_STEPS, type SetupStep } from "../../lib/setup-steps";
import type { CreateKind, SetupItem } from "../../lib/setup-types";

/** Set while the person has put the steps away; the card is then one line until they open it again. */
export const CHECKLIST_FOLDED_KEY = "atlas.setup.checklistFolded";

function storedFold(): boolean {
  try {
    return localStorage.getItem(CHECKLIST_FOLDED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberFold(folded: boolean) {
  try {
    if (folded) localStorage.setItem(CHECKLIST_FOLDED_KEY, "1");
    else localStorage.removeItem(CHECKLIST_FOLDED_KEY);
  } catch {
    // A convenience only: without it the steps are simply open again next time.
  }
}

/**
 * "Finish your toolkit", with "4 of 6" beside a growing bar. Steps tick themselves from what the
 * scan finds; done ones fold away, the rest each get a button that opens the create flow. The
 * reason for a step is its tooltip, not a sentence. The caret in the corner puts the steps away
 * (remembered), so a step someone never wants does not hold the top of the page for good.
 */
export function Checklist({ items, onCreate, steps = SETUP_STEPS }: { items: SetupItem[]; onCreate: (kind: CreateKind) => void; steps?: SetupStep[] }) {
  const [showDone, setShowDone] = useState(false);
  const [foldedPref, setFoldedPref] = useState(storedFold);
  const p = progress(items, steps);
  const pct = Math.round((p.doneCount / p.total) * 100);
  const intro = useIntro("toolkit:checklist");
  const Caret = showDone ? CaretDown : CaretRight;
  // The finished card (its short moment before it goes) is always whole.
  const folded = foldedPref && !p.complete;
  const fold = (next: boolean) => {
    setFoldedPref(next);
    rememberFold(next);
  };

  const bar = (
    <div
      role="progressbar"
      aria-label="Toolkit progress"
      aria-valuemin={0}
      aria-valuemax={p.total}
      aria-valuenow={p.doneCount}
      aria-valuetext={`${p.doneCount} of ${p.total} done`}
      className={`share-bar ${folded ? "min-w-12 flex-1" : "mt-3"}${intro ? " intro" : ""}`}
    >
      <i style={{ width: `${pct}%` }} />
    </div>
  );

  return (
    <section aria-labelledby="checklist-title" className={`card px-5 ${folded ? "py-3" : "py-4"}`}>
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className={`flex size-9 shrink-0 items-center justify-center rounded-full ${p.complete ? "celebrate bg-success-tint text-success" : "bg-accent-tint text-accent-text"}`}
        >
          {p.complete ? <CheckCircle size={20} weight="fill" /> : <Sparkle size={18} weight="duotone" />}
        </span>
        <div className={folded ? "min-w-0 shrink" : "min-w-0 flex-1"}>
          <h2 id="checklist-title" className="h-section truncate">
            {progressTitle(p)}
          </h2>
        </div>
        {/* Put away, the card is one line: what it is, how far along, and the way back. */}
        {folded && bar}
        <span className="chip chip-clay shrink-0 tabular-nums">{`${p.doneCount} of ${p.total}`}</span>
        {!p.complete && (
          <IconButton
            aria-label={folded ? "Show steps" : "Hide steps"}
            title={folded ? "Show steps" : "Hide steps"}
            aria-expanded={!folded}
            aria-controls={folded ? undefined : "checklist-steps"}
            onClick={() => fold(!folded)}
            className="-mr-2 shrink-0"
          >
            {folded ? <CaretDown /> : <CaretUp />}
          </IconButton>
        )}
      </div>

      {!folded && bar}

      {!folded && p.todo.length > 0 && (
        <ul id="checklist-steps" className="mt-3 divide-y divide-line">
          {p.todo.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2">
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

      {!folded && p.done.length > 0 && (
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
                <li key={s.id} className="flex items-center gap-3 py-2 text-body text-ink-2">
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
