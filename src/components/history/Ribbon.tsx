import type { DayCount } from "../../lib/historyTypes";
import { ribbonDot, ribbonLabel, shortDate, startOfDay } from "../../lib/historyModel";

/**
 * The last 30 days as a row of dots: bigger means more changes that day. A day with changes is a
 * button that scrolls the timeline to it.
 */
export function Ribbon({ days, onPick, now = Date.now() }: { days: DayCount[]; onPick: (day: number) => void; now?: number }) {
  const max = days.reduce((m, d) => Math.max(m, d.count), 0);
  const today = startOfDay(now);
  return (
    <div>
      <div className="hx-ribbon" role="group" aria-label="Changes in the last 30 days">
        {days.map((d) => {
          const size = ribbonDot(d.count, max);
          return (
            <button
              key={d.day}
              type="button"
              className="hx-ribbon-hit"
              data-empty={d.count === 0}
              data-today={d.day === today}
              disabled={d.count === 0}
              aria-label={ribbonLabel(d, now)}
              title={ribbonLabel(d, now)}
              onClick={() => onPick(d.day)}
            >
              <span className="hx-ribbon-dot" style={{ width: size, height: size }} />
            </button>
          );
        })}
      </div>
      {days.length > 0 && (
        <div className="mt-1 flex justify-between text-caption text-ink-2" aria-hidden="true">
          <span>{shortDate(days[0].day, now)}</span>
          <span>Today</span>
        </div>
      )}
    </div>
  );
}
