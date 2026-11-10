import type { ReactNode } from "react";
import { Card } from "../controls";
import { CostText } from "./CostText";
import { compact, effortMix, exact, headline, modelLabel, plural } from "../../lib/usage";
import type { Cost, Tokens } from "../../lib/types";
import type { EffortUse } from "../../lib/usageTypes";

/** A small number card: a label, one figure, an optional line under it. */
export function Stat({ label, children, sub, icon }: { label: string; children: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center gap-2 text-caption font-medium text-ink-2">
        {icon}
        {label}
      </div>
      <div className="d d-stat mt-1 text-ink">{children}</div>
      {sub && <div className="mt-1 text-caption text-ink-2">{sub}</div>}
    </Card>
  );
}

/** The four kinds of token, each with its figure. Cache reads sit apart (Q2). */
export function Breakdown({ t }: { t: Tokens }) {
  const rows: [string, number, string?][] = [
    ["Input", t.input],
    ["Output", t.output],
    ["Cache writes, 5-minute", t.cacheWrite5m],
    ["Cache writes, 1-hour", t.cacheWrite1h],
    ["Cache reads", t.cacheRead, "Counted apart, not in the total above"],
  ];
  return (
    <Card>
      <dl className="divide-y divide-line">
        {rows.map(([name, value, note]) => (
          <div key={name} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
            <dt className="text-body text-ink">
              {name}
              {note && <span className="ml-2 text-caption text-ink-2">{note}</span>}
            </dt>
            <dd className="text-body tabular-nums text-ink">{exact(value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * Usage split by model: the full name ("Opus 5.5"), its reasoning-effort mix under it when the
 * transcripts recorded one, "not priced" for a model the price list does not know, its tokens
 * and its cost.
 */
export function ModelSplit({ rows }: { rows: { model: string; tokens: Tokens; cost: Cost; efforts?: EffortUse[] }[] }) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-body">
        <caption className="sr-only">Usage by model</caption>
        <thead className="text-left text-caption text-ink-2">
          <tr className="border-b border-line">
            <th scope="col" className="px-5 py-2 font-medium">Model</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Tokens</th>
            <th scope="col" className="px-5 py-2 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.model} className="border-b border-line last:border-b-0">
              <th scope="row" className="px-5 py-2 text-left font-normal text-ink" title={r.model}>
                {modelLabel(r.model)}
                {r.cost.usd === null && <span className="ml-2 text-caption text-ink-2">not priced</span>}
                {effortMix(r.efforts) && <span className="block text-caption text-ink-2">{`Effort ${effortMix(r.efforts)}`}</span>}
              </th>
              <td className="px-3 py-2 text-right" title={exact(headline(r.tokens))}>{compact(headline(r.tokens))}</td>
              <td className="px-5 py-2 text-right"><CostText cost={r.cost} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export const toolCallsText = (n: number): string => plural(n, "tool call");
