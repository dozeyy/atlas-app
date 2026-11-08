import { useEffect, useRef, useState } from "react";
import { getBackend } from "./ipc";
import type { CostReport } from "./setup-types";

/** New sessions arrive in bursts while Claude works; ask again once they settle. */
export const COST_REFRESH_MS = 4000;

// The last answer, so coming back to the page shows it at once while a fresh one loads.
let last: CostReport | null = null;

/** Tests: forget the last answer. */
export function resetSetupCost(): void {
  last = null;
}

/**
 * What the setup costs, or null until Atlas has an answer (and when it cannot give one: the
 * page then simply draws no cost figures). Refreshes when the setup changes (`reloadKey`) and
 * when the usage numbers do.
 */
export function useSetupCost(reloadKey: number): CostReport | null {
  const [report, setReport] = useState<CostReport | null>(last);
  const [bump, setBump] = useState(0);
  const timer = useRef(0);

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    getBackend()
      .onUsageChanged(() => {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setBump((n) => n + 1), COST_REFRESH_MS);
      })
      .then((fn) => (alive ? (off = fn) : fn()))
      .catch(() => {});
    return () => {
      alive = false;
      window.clearTimeout(timer.current);
      off?.();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    getBackend()
      .setupCost()
      .then((r) => {
        last = r;
        if (alive) setReport(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [reloadKey, bump]);

  return report;
}
