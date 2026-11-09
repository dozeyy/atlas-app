import { useMemo } from "react";
import { compact, exact } from "../lib/usage";
import { sparkShape } from "../lib/todayStat";
import { useTodayStat } from "../lib/useTodayStat";
import { useAtlas } from "../state/AtlasProvider";

const W = 44;
const H = 22;

/**
 * The sidebar foot's readout, beside Settings: "Today", today's tokens (3 significant digits),
 * and a 24 hour trace that never leaves its baseline. Hover gives the exact count; a press opens
 * the Dashboard. Hidden while the sidebar is folded (icons only) and while the numbers are unknown.
 */
export function TodayStat() {
  const { info, setView } = useAtlas();
  const stat = useTodayStat(info.config?.dir ?? null);
  const shape = useMemo(() => (stat ? sparkShape(stat.hours, W, H) : null), [stat]);
  if (!stat || !shape) return null;
  const exactText = `${exact(stat.total)} tokens today`;
  return (
    <button
      type="button"
      className="today-stat hover-host"
      title={exactText}
      aria-label={`Today, ${exactText}. Open Dashboard`}
      onClick={() => setView("dashboard")}
    >
      <span className="today-face">
        <span className="today-text">
          <span className="today-label">Today</span>
          <span className="today-value d">{compact(stat.total)}</span>
        </span>
        <svg aria-hidden="true" focusable="false" width={W} height={H} className="today-spark chart">
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
    </button>
  );
}
