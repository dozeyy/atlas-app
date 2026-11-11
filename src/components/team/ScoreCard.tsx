import { Card } from "../controls";
import { AgentAvatar, helperName } from "../usage/helperKit";
import { TokenText } from "../usage/TokenText";
import { exact, kindsOf, plural } from "../../lib/usage";
import { REVIEWER_WORDS, finishLine, modelLine, rateSentence, reviewCountsLine, reviewerLine, usualLine, weeklyBars, weeklyTitle } from "../../lib/teamModel";
import type { ReviewCounts, TypeCard } from "../../lib/teamTypes";

/** The small chart's height: the tallest week fills it, a week with runs is never under 2 px. */
const WEEK_H = 32;

/**
 * Twelve weeks of runs as small bars, this week in the accent (the Dashboard's bars at rest and
 * today). What they plot is said once under the cards, not on each one; a bar's hover says its
 * own week and count, the gaps between them the whole row. The sheet draws the same twelve
 * weeks full size, from the same buckets.
 */
function WeekBars({ weekly, toTs }: { weekly: number[]; toTs: number }) {
  const max = Math.max(1, ...weekly);
  const last = weekly.length - 1;
  const bars = weeklyBars(weekly, toTs);
  return (
    <span title={weeklyTitle(weekly)} className="team-weeks" style={{ height: WEEK_H }}>
      {bars.map((b, i) => (
        <span
          key={b.key}
          aria-hidden="true"
          title={`${b.valueText}, week of ${b.axis}`}
          className={`team-week${i === last ? " team-week-today" : ""}${b.value > 0 ? "" : " team-week-none"}`}
          style={{ height: b.value > 0 ? Math.max(2, Math.round((b.value / max) * WEEK_H)) : 2 }}
        />
      ))}
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
export function ScoreCard({ card, toTs, onOpen }: { card: TypeCard; toTs: number; onOpen: () => void }) {
  const reviews = card.reviewer ? null : card.reviews;
  const rate = rateSentence(reviews);
  const main = card.reviewer ? (card.verdicts ? reviewerLine(card.verdicts) : "No verdicts given yet") : (rate ?? (reviews ? reviewCountsLine(reviews) : "No reviews yet"));
  const note = reviews ? (rate ? besidesPassed(reviews) : reviews.tied > 0 ? "Too few reviews for a rate" : "") : "";
  // Nothing judged yet is a state, not a result: said quietly.
  const quiet = card.reviewer ? /^No /.test(main) : !reviews || reviews.tied === 0;
  const model = card.topModel ? modelLine(card.topModel.model, card.topModel.effort) : "Model not known";
  const finish = finishLine(card);
  const usual = `${usualLine(card)}${finish ? ` \u00b7 ${finish}` : ""}`;
  // The engine makes the name from the type ("Ui builder"): the short forms go back in capitals.
  const name = helperName(card.displayName);

  return (
    <Card
      onClick={onOpen}
      hitClassName="text-left"
      className="flex h-full flex-col gap-3 p-4"
      aria-label={`${name}, ${plural(card.runs, "run")}. Open details.`}
      data-agent-type={card.agentType}
    >
      <div className="flex items-center gap-3">
        <AgentAvatar type={card.agentType} size={40} quiet />
        <div className="min-w-0 flex-1">
          {/* A card's name is a label, not a heading (the card is one button). */}
          <div className="truncate text-lead font-semibold text-ink" title={name}>
            {name}
          </div>
          {card.reviewer && <p className="truncate text-caption text-ink-2">{REVIEWER_WORDS}</p>}
        </div>
      </div>

      <div className="flex items-end justify-between gap-3">
        <p className="flex min-w-0 items-baseline gap-2">
          <span className="d d-stat text-ink">{exact(card.runs)}</span>
          <span className="text-body text-ink-2">{card.runs === 1 ? "run" : "runs"}</span>
        </p>
        <WeekBars weekly={card.weekly} toTs={toTs} />
      </div>

      <div className="border-t border-line pt-3">
        <p className="text-caption text-ink-2">{card.reviewer ? "Verdicts it gave" : "Its work in review"}</p>
        <p className={`mt-0.5 break-words text-body ${quiet ? "text-ink-2" : "font-semibold text-ink"}`}>{main}</p>
        {rate && reviews && (
          <span aria-hidden="true" className="team-meter mt-2">
            <span className="team-meter-fill" style={{ width: `${Math.round((reviews.passed / Math.max(1, reviews.tied)) * 100)}%` }} />
          </span>
        )}
        {note && <p className="mt-2 break-words text-caption text-ink-2">{note}</p>}
      </div>

      <div className="mt-auto space-y-0.5 text-caption text-ink-2">
        <p className="truncate" title={model}>
          <TokenText tokens={card.tokens.total} cost={card.cost} kinds={kindsOf(card.tokens)} />
          {` \u00b7 ${model}`}
        </p>
        <p className="break-words">{usual}</p>
      </div>
    </Card>
  );
}
