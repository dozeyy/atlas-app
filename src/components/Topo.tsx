import { useMemo } from "react";
import { contourPath } from "../lib/topo";

/**
 * Atlas's signature: topographic contour lines. One static SVG path, drawn from
 * the accent color at low opacity, masked to fade out at the edges.
 */
export function Topo({
  seed = 7,
  className = "",
  width = 960,
  height = 420,
}: {
  seed?: number;
  className?: string;
  width?: number;
  height?: number;
}) {
  const d = useMemo(() => contourPath({ width, height, seed }), [width, height, seed]);
  const maskId = `topo-fade-${seed}`;
  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="xMidYMid slice"
      className={`pointer-events-none absolute inset-0 h-full w-full ${className}`}
    >
      <defs>
        <radialGradient id={`${maskId}-g`} cx="50%" cy="46%" r="62%">
          <stop offset="0" stopColor="#fff" stopOpacity="1" />
          <stop offset="0.55" stopColor="#fff" stopOpacity="0.7" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </radialGradient>
        <mask id={maskId}>
          <rect width={width} height={height} fill={`url(#${maskId}-g)`} />
        </mask>
      </defs>
      <path
        d={d}
        mask={`url(#${maskId})`}
        fill="none"
        stroke="var(--accent)"
        strokeOpacity="0.32"
        strokeWidth="1"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
