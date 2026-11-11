import { compact, costView, tokenHint, type TokenKinds } from "../../lib/usage";
import type { Cost } from "../../lib/types";

/**
 * A token figure, the number that shows (2026-11-08: tokens everywhere, money on hover).
 * The hover is the exact count and, on a second line, the API-price dollar estimate, always
 * called an estimate. Screen readers get the estimate as words, since a hover is not reachable.
 */
export function TokenText({
  tokens,
  cost,
  kinds,
  unit = "tokens",
  className = "",
}: {
  tokens: number;
  cost: Cost;
  /** The tokens by kind: the hover lists them and adds them all together. */
  kinds?: TokenKinds | null;
  /** The word after the number; "" for a bare figure. */
  unit?: string;
  className?: string;
}) {
  const v = costView(cost);
  return (
    <span title={tokenHint(tokens, cost, kinds)} className={`tabular-nums ${className}`}>
      {unit ? `${compact(tokens)} ${unit}` : compact(tokens)}
      {!v.none && <span className="sr-only">{`, about ${v.text} at API prices, estimated${v.partial ? ", incomplete" : ""}`}</span>}
    </span>
  );
}
