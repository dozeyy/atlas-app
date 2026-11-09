import { useMemo } from "react";
import { compact, exact } from "../lib/usage";
import { usualDay } from "../lib/chartPaths";
import { paceText, sparkShape } from "../lib/todayStat";
import { useDaily } from "../lib/useDaily";
import { useTodayStat } from "../lib/useTodayStat";
import { useAtlas } from "../state/AtlasProvider";

const W = 56;
const H = 18;

/**
 * The sidebar foot's readout, beside Settings, laid out as two rows on the nav's own grid (its
 * text starts where the nav icons start):
 *   Today                  42% usual
 *   12M          (24 hour trace on the figure's baseline)
 * The figure is today's tokens (3 significant digits). "Usual" is the middle of the active days
 * among the last 30, the same number the Dashboard's Today card uses; it is left out until there
 * is one. The trace never leaves its baseline. Hover gives the exact count; a press
 * opens the Dashboard. Hidden while the sidebar is folded (icons only) and while the numbers
 * are unknown.
 */
export function TodayStat() {
  const { info, setView } = useAtlas();
  const stat = useTodayStat(info.config?.dir ?? null);
  const daily = useDaily(info.config?.projectsDir ?? null);
  const shape = useMemo(() => (stat ? sparkShape(stat.hours, W, H) : null), [stat]);
  const usual = useMemo(() => (daily ? usualDay(daily.tokens.slice(-31, -1)) : 0), [daily]);
  if (!stat || !shape) return null;
  const pace = paceText(stat.total, usual);
  return (
    <button
      type="button"
      className="today-stat hover-host"
      aria-label={`Today ${exact(stat.total)}${pace ? `, ${pace}` : ""}. Open Dashboard`}
      onClick={() => setView("dashboard")}
    >
      <span className="today-stat-face">
        <span className="today-stat-top">
          <span className="today-stat-label">Today</span>
          {pace && <span className="today-stat-pace">{pace}</span>}
        </span>
        <span className="today-stat-bottom">
          <span className="today-stat-figure d">{compact(stat.total)}</span>
          <svg aria-hidden="true" focusable="false" width={W} height={H} className="today-stat-spark chart">
            <line x1="0" x2={W} y1={shape.baseline} y2={shape.baseline} className="today-base" />
            {!shape.empty && (
              <>
                <path d={shape.area} className="today-area" />
                <path d={shape.line} className="spark-line" />
                {shape.last && <circle cx={shape.last[0]} cy={shape.last[1]} r={2} fill="var(--accent)" />}
              </>
            )}
          </svg>
        </span>
      </span>
    </button>
  );
}
