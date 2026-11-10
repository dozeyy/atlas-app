import { Card } from "../controls";
import { AgentAvatar } from "../usage/helperKit";
import { TokenText } from "../usage/TokenText";
import { exact, modelWithEffort, plural } from "../../lib/usage";
import { REVIEWER_WORDS, finishLine, rateSentence, reviewCountsLine, reviewerLine, usualLine, weeklyTitle } from "../../lib/teamModel";
import type { ReviewCounts, TypeCard } from "../../lib/teamTypes";

/**
 * Twelve weeks of runs as small bars, this week in the accent. It says what it plots on its
 * face; the exact numbers are the hover. The sheet draws the same twelve weeks full size.
 */
function WeekBars({ weekly }: { weekly: number[] }) {
  const max = Math.max(1, ...weekly);
  const last = weekly.length - 1;
  return (
    <span title={weeklyTitle(weekly)} className="flex shrink-0 flex-col items-end gap-1">
      <span aria-hidden="true" className="flex h-7 items-end gap-0.5">
        {weekly.map((v, i) => (
          <span
            key={i}
            className="w-1 rounded-full"
            style={{
              height: v > 0 ? `${Math.max(14, Math.round((v / max) * 100))}%` : 2,
              background: v > 0 ? (i === last ? "var(--accent)" : "var(--bar-rest)") : "var(--line-strong)",
            }}
          />
        ))}
      </span>
      <span className="text-caption text-ink-2">{`Per week, last ${weekly.length} weeks`}</span>
    </span>
  );
}

/** What a rate leaves unsaid: "Passed 9 of 12" already counts the passes. */
function besidesPassed(r: ReviewCounts): string {
  const parts: string[] = [];
  if (r.sentBack > 0) parts.push(`${exact(r.sentBack)} sent back`);
  if (r.other > 0) parts.push(`${exact(r.other)} other`);
  if (r.notTied > 0) parts.push(`${exact(r.notTied)} not tied to a review`);
  return parts.join(", ");
}

/**
 * One kind of helper, as a card. Two things lead: how much it is used (the figure and the
 * twelve weeks beside it) and whether its work passes review (a reviewer shows the verdicts
 * it gave instead). Tokens, model and the typical run are two quiet lines; dollars stay on
 * hover; everything else is in the sheet the card opens.
 */
export function ScoreCard({ card, onOpen }: { card: TypeCard; onOpen: () => void }) {
  const reviews = card.reviewer ? null : card.reviews;
  const rate = rateSentence(reviews);
  const main = card.reviewer ? (card.verdicts ? reviewerLine(card.verdicts) : "No verdicts given yet") : (rate ?? (reviews ? reviewCountsLine(reviews) : "No reviews yet"));
  const note = reviews ? (rate ? besidesPassed(reviews) : reviews.tied > 0 ? "Too few reviews for a rate" : "") : "";
  // Nothing judged yet is a state, not a result: said quietly.
  const quiet = card.reviewer ? /^No /.test(main) : !reviews || reviews.tied === 0;
  const model = card.topModel ? modelWithEffort(card.topModel.model, card.topModel.effort) : "Model not known";
  const finish = finishLine(card);
  const usual = `${usualLine(card)}${finish ? ` \u00b7 ${finish}` : ""}`;

  return (
    <Card
      onClick={onOpen}
      hitClassName="text-left"
      className="flex h-full flex-col gap-3 p-4"
      aria-label={`${card.displayName}, ${plural(card.runs, "run")}. Open details.`}
      data-agent-type={card.agentType}
    >
      <div className="flex items-center gap-3">
        <AgentAvatar type={card.agentType} size={40} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lead font-semibold text-ink" title={card.displayName}>
            {card.displayName}
          </h3>
          {card.reviewer && <p className="truncate text-caption text-ink-2">{REVIEWER_WORDS}</p>}
        </div>
      </div>

      <div className="flex items-end justify-between gap-3">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="d d-stat text-ink">{exact(card.runs)}</span>
          <span className="text-body text-ink-2">{card.runs === 1 ? "run" : "runs"}</span>
        </p>
        <WeekBars weekly={card.weekly} />
      </div>

      <div className="border-t border-line pt-3">
        <p className="text-caption text-ink-2">{card.reviewer ? "Verdicts it gave" : "Its work in review"}</p>
        <p className={`mt-0.5 break-words text-body ${quiet ? "text-ink-2" : "font-semibold text-ink"}`}>{main}</p>
        {rate && reviews && (
          <span aria-hidden="true" className="team-meter mt-2">
            <span className="team-meter-fill" style={{ width: `${Math.round((reviews.passed / Math.max(1, reviews.tied)) * 100)}%` }} />
          </span>
        )}
        {note && <p className="mt-1.5 break-words text-caption text-ink-2">{note}</p>}
      </div>

      <div className="mt-auto space-y-0.5 text-caption text-ink-2">
        <p className="truncate" title={model}>
          <TokenText tokens={card.tokens.total} cost={card.cost} />
          {` \u00b7 ${model}`}
        </p>
        <p className="break-words">{usual}</p>
      </div>
    </Card>
  );
}
