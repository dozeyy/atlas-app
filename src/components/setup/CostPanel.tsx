import { KIND_BY_ID } from "../../lib/setup-model";
import { approx, fmtCount, hasDollars, loadLine, topRows, windowLabel } from "../../lib/setup-cost";
import type { CostReport, ItemKind, SetupItem } from "../../lib/setup-types";

// Four rows keep this panel about as tall as the usage panel beside it, so the Toolkit page
// fits a 1280x800 window without scrolling.
const TOP = 4;

/**
 * The biggest costs in the setup, most expensive first. Draws nothing until Atlas has an
 * answer. The one estimate label sits in the footer; each row says where it applies
 * ("All chats", "Chats in <project>") and shows tokens x turns next to its dollars.
 */
export function CostPanel({ report, items, onOpen }: { report: CostReport | null; items: SetupItem[]; onOpen?: (id: string) => void }) {
  const rows = topRows(report, TOP);
  if (!report || rows.length === 0) return null;
  const known = new Set(items.map((i) => i.id));
  const priced = rows.some(hasDollars);
  const max = Math.max(...rows.map((r) => (priced ? r.usdWeek : r.tokens + r.bodyTokens)), 1e-9);

  return (
    <section aria-labelledby="cost-title" className="@container flex min-w-0 flex-col rounded-card border border-line bg-surface px-5 py-4">
      <div className="flex items-baseline gap-x-3">
        <h2 id="cost-title" className="text-lead font-semibold text-ink">
          What your setup costs
        </h2>
        {priced && (
          <p className="ml-auto shrink-0 text-body text-ink-2">
            <span className="d d-small text-ink">{approx(report.usdWeek)}</span> a week
          </p>
        )}
      </div>

      <ol className="mt-3 space-y-2.5">
        {rows.map((r, i) => {
          const share = (priced ? r.usdWeek : r.tokens + r.bodyTokens) / max;
          const Icon = KIND_BY_ID[r.kind as ItemKind]?.icon;
          const openable = onOpen && r.id !== null && known.has(r.id);
          const name = openable ? (
            <button type="button" onClick={() => onOpen(r.id!)} className="press min-w-0 cursor-pointer text-left text-body font-medium text-ink hover:text-accent-text">
              <span className="block truncate">{r.name}</span>
            </button>
          ) : (
            <span className="min-w-0 truncate text-body font-medium text-ink">{r.name}</span>
          );
          return (
            <li key={`${r.id ?? r.name}-${i}`} data-cost-row={r.id ?? r.name}>
              <div className="flex items-baseline gap-2">
                {Icon && <Icon size={14} aria-hidden="true" className="shrink-0 translate-y-[2px] text-ink-2" />}
                {name}
                <span className="ml-auto shrink-0 text-body text-ink">
                  {priced ? (
                    <>
                      <span className="d d-small">{approx(r.usdWeek)}</span>
                      <span className="text-caption text-ink-2"> /wk</span>
                    </>
                  ) : (
                    <span className="d d-small">{fmtCount(r.tokens + r.bodyTokens)}</span>
                  )}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-3">
                <p className="min-w-0 flex-1 truncate text-caption text-ink-2">
                  {r.loadsIn}
                  {r.tokens > 0 && r.turns > 0 ? ` - ${loadLine(r)}` : r.tokens > 0 ? ` - ${fmtCount(r.tokens)} tokens` : ` - ${fmtCount(r.bodyTokens)} tokens when used`}
                </p>
              </div>
              <div aria-hidden="true" className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
                <div style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} className="h-full rounded-full bg-accent/70" />
              </div>
            </li>
          );
        })}
      </ol>

      <p className="mt-auto pt-3 text-caption text-ink-2">
        Estimate, {windowLabel(report)}. {fmtCount(report.globalTokens)} tokens load in every chat.
        {report.incomplete && report.turns > 0 ? " Some chats could not be priced." : ""}
        {report.turns === 0 ? " No chats yet, so sizes only." : ""}
      </p>
    </section>
  );
}
