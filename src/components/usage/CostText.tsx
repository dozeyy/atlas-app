import { costView } from "../../lib/usage";
import type { Cost } from "../../lib/types";

/**
 * A cost, always an estimate (Q5). A trailing "+" means some tokens had no price, so
 * the real figure is higher; "No price" means none could be priced.
 */
export function CostText({ cost, className = "" }: { cost: Cost; className?: string }) {
  const v = costView(cost);
  const hint = v.none
    ? "These models have no price in the price list, so no cost can be estimated."
    : v.partial
      ? "Some of this usage has no price in the price list, so the real cost is higher."
      : "An estimate from the price list, not a bill.";
  return (
    <span title={hint} className={`tabular-nums ${v.none ? "text-ink-2" : ""} ${className}`}>
      {v.text}
      <span className="sr-only">{`, estimated${v.partial ? ", incomplete" : ""}`}</span>
    </span>
  );
}
