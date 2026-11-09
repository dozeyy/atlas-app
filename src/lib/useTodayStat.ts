// The sidebar's Today readout: one hourly query (yesterday + today), refreshed by the usage
// engine's own "changed" event (debounced) and at the top of each hour. Nothing runs per frame.

import { useEffect, useRef, useState } from "react";
import { getBackend } from "./ipc";
import { last24Hours, statRange, todayTotal } from "./todayStat";

export interface TodayStat {
  total: number;
  hours: number[];
}

const REFRESH_DEBOUNCE_MS = 800;

export function useTodayStat(scope: string | null): TodayStat | null {
  const [stat, setStat] = useState<TodayStat | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (scope === null) {
      setStat(null);
      return;
    }
    const backend = getBackend();
    let alive = true;
    let off: (() => void) | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let hourTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const load = () => {
      const id = ++seq.current;
      const now = new Date();
      backend
        .usageTimeline({ ...statRange(now), bucket: "hour" })
        .then((t) => {
          if (!alive || id !== seq.current) return;
          retries = 0;
          setStat({ total: todayTotal(t.points, now), hours: last24Hours(t.points, now) });
        })
        .catch(() => {
          // The cache may still be opening at launch; ask again a few times, then stay quiet.
          if (alive && id === seq.current && retries < 5) {
            retries++;
            debounce = setTimeout(load, 800 * retries);
          }
        });
    };
    const armHour = () => {
      const n = new Date();
      const next = new Date(n.getFullYear(), n.getMonth(), n.getDate(), n.getHours() + 1, 0, 1).getTime();
      hourTimer = setTimeout(() => {
        load();
        armHour();
      }, Math.max(1000, next - n.getTime()));
    };

    load();
    armHour();
    backend
      .onUsageChanged(() => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(load, REFRESH_DEBOUNCE_MS);
      })
      .then((fn) => (alive ? (off = fn) : fn()))
      .catch(() => {});
    return () => {
      alive = false;
      seq.current++;
      off?.();
      if (debounce) clearTimeout(debounce);
      if (hourTimer) clearTimeout(hourTimer);
    };
  }, [scope]);

  return stat;
}
