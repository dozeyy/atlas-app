import type { DayCount } from "../../lib/historyTypes";
import { ribbonDot, ribbonLabel, ribbonStart, startOfDay } from "../../lib/historyModel";
import { shortDate } from "../../lib/usage";

/** A start date this close to "Today" would run into it; the number beside the ribbon says it anyway. */
const LABEL_ROOM = 5;

/**
 * The last 30 days as a row of dots: bigger means more changes that day. A day with changes is a
 * button that scrolls the timeline to it. The row starts on the day Atlas began watching when that
 * is inside the 30 days: the days before it are left empty, and the date under the first dot is
 * the same one "watching since" gives.
 */
export function Ribbon({ days, since = 0, onPick, now = Date.now() }: { days: DayCount[]; since?: number; onPick: (day: number) => void; now?: number }) {
  const max = days.reduce((m, d) => Math.max(m, d.count), 0);
  const today = startOfDay(now);
  const start = ribbonStart(days, since);
  const cols = { gridTemplateColumns: `repeat(${Math.max(1, days.length)}, minmax(0, 1fr))` };
  return (
    <div>
      <div className="hx-ribbon" style={cols} role="group" aria-label={start > 0 ? "Changes since Atlas began watching" : "Changes in the last 30 days"}>
        {days.map((d, i) => {
          if (i < start) return <span key={d.day} aria-hidden="true" />;
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
        <div className="hx-ribbon-ends mt-1 text-caption text-ink-2" style={cols} aria-hidden="true">
          {days.length - start > LABEL_ROOM && (
            <span className="whitespace-nowrap" style={{ gridColumn: `${start + 1} / -2`, gridRow: 1 }}>
              {shortDate(days[start].day, now)}
            </span>
          )}
          <span className="whitespace-nowrap text-right" style={{ gridColumn: "1 / -1", gridRow: 1 }}>
            Today
          </span>
        </div>
      )}
    </div>
  );
}
