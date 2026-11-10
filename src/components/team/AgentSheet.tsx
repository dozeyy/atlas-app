import { Bars } from "../charts/Bars";
import { Button } from "../controls";
import { AgentAvatar, helperName } from "../usage/helperKit";
import { TokenText } from "../usage/TokenText";
import { SheetSection, SideSheet } from "./SideSheet";
import { compact, exact, formatDuration, formatWhen, plural } from "../../lib/usage";
import { HEADLESS_HINT, REVIEWER_WORDS, endRows, finishLine, modelLine, rateSentence, reviewCountsLine, runOutcome, startedLine, usualLine, verdictRows, weeklyBars } from "../../lib/teamModel";
import type { RunRow, TypeCard } from "../../lib/teamTypes";

function Count({ label, n, total }: { label: string; n: number; total: number }) {
  const share = total > 0 ? n / total : 0;
  return (
    <li className="flex items-center gap-3 py-1 text-body">
      <span className="w-28 shrink-0 text-ink-2">{label}</span>
      <span aria-hidden="true" className="team-meter min-w-0 flex-1">
        <span className="team-meter-fill" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="w-14 shrink-0 text-right tabular-nums text-ink">{exact(n)}</span>
    </li>
  );
}

function RunLine({ run, onOpen }: { run: RunRow; onOpen: (r: RunRow) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(run)}
        title="Open this run"
        className="press team-run flex w-full cursor-pointer items-baseline gap-3 rounded-control px-2 py-2 text-left text-body hover:bg-raised"
      >
        {/* "Yesterday, 11:55 PM" is the longest this gets: it stays on one line. */}
        <span className="w-36 shrink-0 whitespace-nowrap text-ink-2">{formatWhen(run.started)}</span>
        <span title={run.project || undefined} className="min-w-0 flex-1 truncate text-ink">
          {run.project || "No project"}
        </span>
        <span className="w-14 shrink-0 whitespace-nowrap text-right text-ink-2">{formatDuration(run.durationMs)}</span>
        <span className="w-24 shrink-0 whitespace-nowrap text-right text-ink">{runOutcome(run)}</span>
        <span className="w-12 shrink-0 text-right tabular-nums text-ink-2">{compact(run.tokens)}</span>
      </button>
    </li>
  );
}

/**
 * One helper type in full, in a calm sheet (no spring, count-up or spark): twelve weeks of
 * runs, how they ended, how the work was reviewed, where it ran, and its newest runs. A run
 * opens that helper's own page.
 */
export function AgentSheet({
  card,
  toTs,
  onClose,
  onOpenRun,
  onOpenFile,
}: {
  card: TypeCard;
  toTs: number;
  onClose: () => void;
  onOpenRun: (r: RunRow) => void;
  /** Only given when a Toolkit agent of this name exists. */
  onOpenFile?: () => void;
}) {
  const ends = endRows(card.ends);
  const verdicts = card.verdicts ? verdictRows(card.verdicts) : [];
  const known = card.ends.finished + card.ends.errored + card.ends.stopped + card.ends.unknown;
  const finish = finishLine(card);
  const rate = card.reviewer ? null : rateSentence(card.reviews);
  const bars = weeklyBars(card.weekly, toTs);
  const name = helperName(card.displayName);

  return (
    <SideSheet
      title={name}
      lead={<AgentAvatar type={card.agentType} size={40} quiet />}
      subtitle={
        <span>
          {card.reviewer ? `${REVIEWER_WORDS} \u00b7 ` : ""}
          {plural(card.runs, "run")}
          {" \u00b7 "}
          <TokenText tokens={card.tokens.total} cost={card.cost} />
          {card.topModel ? ` \u00b7 ${modelLine(card.topModel.model, card.topModel.effort)}` : ""}
        </span>
      }
      onClose={onClose}
      footer={
        onOpenFile ? (
          <Button onClick={onOpenFile}>Open agent file</Button>
        ) : undefined
      }
    >
      <SheetSection title="Runs per week">
        <Bars id={`team-sheet-${card.agentType}`} data={bars} label={`${name} runs per week`} formatTick={(v) => String(Math.round(v))} height={160} calm highlight={-1} />
        <p className="mt-2 text-body text-ink-2">
          {usualLine(card)}.
          {card.resumedRuns > 0 ? ` ${plural(card.resumedRuns, "run")} picked up again.` : ""}
        </p>
      </SheetSection>

      {/* Only the endings that happened: a row of "Stopped 0" tells nobody anything. */}
      {ends.length > 0 && (
        <SheetSection title="How runs ended" aside={finish ? <span className="text-body text-ink-2">{finish}</span> : undefined}>
          <ul>
            {ends.map((r) => (
              <Count key={r.key} label={r.label} n={r.n} total={known} />
            ))}
          </ul>
        </SheetSection>
      )}

      {card.reviewer && card.verdicts ? (
        <SheetSection title="Verdicts it gave">
          {verdicts.length === 0 ? (
            <p className="text-body text-ink-2">No verdicts given yet.</p>
          ) : (
            <ul>
              {verdicts.map((r) => (
                <Count key={r.key} label={r.label} n={r.n} total={card.runs} />
              ))}
            </ul>
          )}
        </SheetSection>
      ) : card.reviews ? (
        <SheetSection title="How its work was reviewed">
          <p className="text-body text-ink">{rate ?? "Too few reviews for a rate yet"}</p>
          <p className="mt-0.5 text-body text-ink-2">{reviewCountsLine(card.reviews)}</p>
        </SheetSection>
      ) : null}

      {card.projects.length > 0 && (
        <SheetSection title="Where it ran">
          <ul>
            {card.projects.map((p) => (
              <li key={p.projectKey} className="flex items-baseline gap-3 py-1 text-body">
                <span title={p.name || undefined} className="min-w-0 flex-1 truncate text-ink">
                  {p.name || "No project"}
                </span>
                <span className="shrink-0 text-ink-2">{plural(p.runs, "run")}</span>
                <span className="w-28 shrink-0 text-right tabular-nums text-ink-2">{`${compact(p.tokens)} tokens`}</span>
              </li>
            ))}
          </ul>
        </SheetSection>
      )}

      <SheetSection title="Started from">
        <p title={HEADLESS_HINT} className="text-body text-ink">
          {startedLine(card.started)}
        </p>
      </SheetSection>

      {card.mix.length > 1 && (
        <SheetSection title="Models used">
          <ul>
            {card.mix.map((m) => (
              <li key={`${m.model}-${m.effort ?? ""}`} className="flex items-baseline gap-3 py-1 text-body">
                <span title={modelLine(m.model, m.effort)} className="min-w-0 flex-1 truncate text-ink">
                  {modelLine(m.model, m.effort)}
                </span>
                <span className="shrink-0 text-ink-2">{plural(m.runs, "run")}</span>
              </li>
            ))}
          </ul>
        </SheetSection>
      )}

      <SheetSection title="Newest runs">
        {card.recent.length === 0 ? (
          <p className="text-body text-ink-2">No runs in this range.</p>
        ) : (
          <ul className="-mx-2">
            {card.recent.map((r) => (
              <RunLine key={`${r.sessionId}-${r.agentId}`} run={r} onOpen={onOpenRun} />
            ))}
          </ul>
        )}
      </SheetSection>
    </SideSheet>
  );
}
