import { fmtUsd, loadsWhere, rowTitle, titleCount, topRows, usdHover, weekTotal, weeklyTokens, windowLabel } from "../../lib/setup-cost";
import { compact, exact } from "../../lib/usage";
import type { CostReport, SetupItem } from "../../lib/setup-types";
import { MiniKind } from "./parts";

// Four rows keep this panel about as tall as the usage panel beside it, so the Toolkit page
// fits a 1280x800 window without scrolling.
const TOP = 4;

/**
 * What loads with every message, biggest first. Everything on screen is tokens (most people are
 * on a plan, not the API); the API-price dollar estimate is only in the hovers. Draws nothing
 * until Atlas has an answer.
 */
export function CostPanel({ report, items, onOpen }: { report: CostReport | null; items: SetupItem[]; onOpen?: (id: string) => void }) {
  const rows = topRows(report, TOP);
  if (!report || rows.length === 0) return null;
  const known = new Set(items.map((i) => i.id));
  const weekly = report.turns > 0;
  const max = Math.max(...rows.map(weeklyTokens), 1);
  // One unit on the card: with sessions to count, the headline is the week's total and every row
  // is a part of that week. What each message carries (the size, not the week) is in the hovers.
  const usd = report.usdWeek > 0 ? `Estimate: about ${fmtUsd(report.usdWeek)} a week at API prices, ${windowLabel(report)}.` : "";
  const total = [weekly ? `${exact(report.globalTokens)} tokens with every message, in every session.` : "", usd].filter(Boolean).join(" ");

  return (
    <section aria-labelledby="cost-title" className="@container flex min-w-0 flex-col rounded-card border border-line bg-surface px-5 py-4">
      <h2 id="cost-title" className="h-section">
        What your setup costs
      </h2>
      <p data-cost-headline title={total || undefined} className="mt-1 flex items-baseline gap-2 text-body text-ink-2">
        <span className="d d-tile text-ink">{compact(weekly ? weekTotal(report) : report.globalTokens)}</span>{" "}
        {weekly ? "tokens a week, across all sessions" : "tokens per message, in every session"}
      </p>

      {/* Headline and rows speak one unit. With sessions to count it is the week: the total, then
          the biggest parts of it, each saying where it loads. Before any session it is the size
          per message. No second unit sits on the surface: the exact per-message size of a row
          (which can be bigger than what every session carries) is in its hover. */}
      <ol aria-label={weekly ? `Biggest over the ${windowLabel(report)}` : "Biggest"} className="mt-3 space-y-2.5">
        {rows.map((r, i) => {
          const share = weeklyTokens(r) / max;
          const openable = onOpen && r.id !== null && known.has(r.id);
          const hover = [`${exact(r.tokens)} tokens with every message${weekly ? `, ${exact(weeklyTokens(r))} over ${windowLabel(report)}` : ""}.`, usdHover(r, report)]
            .filter(Boolean)
            .join(" ");
          const { label, count } = titleCount(rowTitle(r));
          const title = (
            <>
              {label}
              {count && <span className="ml-1.5 font-normal text-ink-2">{count}</span>}
            </>
          );
          const name = openable ? (
            <button type="button" onClick={() => onOpen(r.id!)} className="press min-w-0 cursor-pointer text-left text-body font-medium text-ink hover:text-accent-text">
              <span className="block truncate">{title}</span>
            </button>
          ) : (
            <span className="min-w-0 truncate text-body font-medium text-ink">{title}</span>
          );
          return (
            <li key={`${r.id ?? r.name}-${i}`} data-cost-row={r.id ?? r.name} title={hover}>
              <div className="flex items-baseline gap-2">
                <MiniKind kind={r.kind} name={r.name} />
                {name}
                <span className="ml-auto shrink-0 text-body text-ink">
                  <span className="d d-small">{compact(weekly ? weeklyTokens(r) : r.tokens)}</span>
                  <span className="text-caption text-ink-2">{weekly ? " a week" : " per message"}</span>
                </span>
              </div>
              <p className="mt-0.5 truncate text-caption text-ink-2">{loadsWhere(r)}</p>
              <div aria-hidden="true" className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
                <div style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} className="h-full rounded-full bg-accent/70" />
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
