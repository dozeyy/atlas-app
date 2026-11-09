import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";
import { compact } from "../../lib/usage";
import { costWords, itemHover } from "../../lib/setup-cost";
import type { CostReport, CostRow } from "../../lib/setup-types";

interface CostValue {
  report: CostReport | null;
  byId: Map<string, CostRow>;
}

const EMPTY: CostValue = { report: null, byId: new Map() };
const Ctx = createContext<CostValue>(EMPTY);

/** Hands the cost report to every item card and row without threading it through each list. */
export function CostProvider({ report, children }: { report: CostReport | null; children: ReactNode }) {
  const value = useMemo<CostValue>(() => {
    const byId = new Map<string, CostRow>();
    for (const r of report?.rows ?? []) if (r.id) byId.set(r.id, r);
    return { report, byId };
  }, [report]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** One item's token readout: `7.3k` + `tokens per call`, with a hover that carries the exact figure and the API-price estimate. */
export interface ItemCost {
  figure: string;
  unit: string;
  hover: string;
}

export function useItemCost(id: string): ItemCost | null {
  const { report, byId } = useContext(Ctx);
  const row = byId.get(id);
  if (!row) return null;
  const w = costWords(row);
  if (!w) return null;
  return { figure: compact(w.n), unit: w.unit, hover: itemHover(row, report) };
}
