import type { ReactNode } from "react";
import { ringGeometry } from "../../lib/chartPaths";
import { useIntro } from "../../lib/motion";

/**
 * A progress ring. Past 100 % a second lap draws over the first in the darker clay.
 * The centre takes any content. The ring is decorative; `label` is what a screen reader hears.
 */
export function Ring({
  id,
  size,
  stroke,
  frac,
  label,
  children,
}: {
  id: string;
  size: number;
  stroke: number;
  frac: number;
  label: string;
  children?: ReactNode;
}) {
  const intro = useIntro(id);
  const g = ringGeometry(size, stroke, frac);
  const c = size / 2;
  return (
    <div
      role="img"
      aria-label={label}
      className={`relative shrink-0${intro ? " intro" : ""}`}
      style={{ width: size, height: size }}
    >
      <svg className="chart" width={size} height={size} aria-hidden="true" style={{ transform: "rotate(-90deg)" }}>
        <circle className="ring-track" cx={c} cy={c} r={g.r} strokeWidth={stroke} />
        <circle
          className="ring-arc"
          cx={c}
          cy={c}
          r={g.r}
          strokeWidth={stroke}
          strokeDasharray={g.circ}
          strokeDashoffset={g.offset}
          style={{ ["--circ" as string]: g.circ }}
        />
        {g.offset2 !== null && (
          <circle
            className="ring-arc lap2"
            cx={c}
            cy={c}
            r={g.r}
            strokeWidth={stroke}
            strokeDasharray={g.circ}
            strokeDashoffset={g.offset2}
            style={{ ["--circ" as string]: g.circ }}
          />
        )}
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}
