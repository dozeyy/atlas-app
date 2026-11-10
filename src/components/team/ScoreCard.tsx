import { Sparkline } from "../charts/Sparkline";
import { Card } from "../controls";
import { TokenText } from "../usage/TokenText";
import { modelWithEffort, plural } from "../../lib/usage";
import { finishLine, medianCalls, medianTime, rateSentence, reviewCountsLine, reviewerLine } from "../../lib/teamModel";
import type { TypeCard } from "../../lib/teamTypes";

/**
 * One kind of helper, as a card: how many runs, what they cost in tokens (dollars on hover),
 * its usual model, typical time and tool calls (only from 3 runs), how often it finished,
 * and how its work was reviewed. A reviewer shows the verdicts it gave instead.
 */
export function ScoreCard({ card, onOpen }: { card: TypeCard; onOpen: () => void }) {
  const rate = card.reviewer ? null : rateSentence(card.reviews);
  const verdictLine = card.reviewer && card.verdicts ? reviewerLine(card.verdicts) : null;
  const countsLine = !card.reviewer && card.reviews ? reviewCountsLine(card.reviews) : null;
  const finish = finishLine(card);
  const headless = card.started.headless;

  return (
    <Card
      onClick={onOpen}
      hitClassName="text-left"
      className="flex h-full flex-col gap-3 p-4"
      aria-label={`${card.displayName}, ${plural(card.runs, "run")}. Open details.`}
      data-agent-type={card.agentType}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-lead font-semibold text-ink" title={card.displayName}>
            {card.displayName}
          </h3>
          <p className="mt-0.5 text-caption text-ink-2">
            {plural(card.runs, "run")}
            {card.reviewer ? " \u00b7 reviewer" : ""}
            {headless > 0 ? ` \u00b7 ${headless} headless` : ""}
          </p>
        </div>
        <Sparkline id={`team-${card.agentType}`} values={card.weekly} width={72} height={24} />
      </div>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body">
        <dt className="text-ink-2">Used</dt>
        <dd className="min-w-0 text-ink">
          <TokenText tokens={card.tokens.total} cost={card.cost} />
        </dd>
        <dt className="text-ink-2">Model</dt>
        <dd className="min-w-0 truncate text-ink">{card.topModel ? modelWithEffort(card.topModel.model, card.topModel.effort) : "Not known"}</dd>
        <dt className="text-ink-2">Time</dt>
        <dd className={`min-w-0 ${card.tooFewRuns ? "text-ink-2" : "text-ink"}`}>{medianTime(card)}</dd>
        <dt className="text-ink-2">Work</dt>
        <dd className={`min-w-0 ${card.tooFewRuns ? "text-ink-2" : "text-ink"}`}>{medianCalls(card)}</dd>
        {finish && (
          <>
            <dt className="text-ink-2">Ended</dt>
            <dd className="min-w-0 text-ink">{finish}</dd>
          </>
        )}
      </dl>

      <p className="mt-auto min-h-12 border-t border-line pt-3 text-body text-ink">
        {rate ?? verdictLine ?? countsLine ?? ""}
        {rate && countsLine && <span className="block text-caption text-ink-2">{countsLine}</span>}
        {!rate && countsLine && !card.reviewer && card.reviews && card.reviews.tied > 0 && (
          <span className="block text-caption text-ink-2">Too few reviews for a rate</span>
        )}
      </p>
    </Card>
  );
}
