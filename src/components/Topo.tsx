import { useMemo } from "react";
import { contourPaths } from "../lib/topo";

/**
 * Atlas's signature: topographic contour lines. Two static SVG paths drawn from the accent color
 * at low opacity (the ordinary lines at 1 px, every fifth line a heavier index contour at 1.5 px,
 * as on a printed map), masked to fade out at the edges.
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
  const { minor, index } = useMemo(() => contourPaths({ width, height, seed }), [width, height, seed]);
  const maskId = `topo-fade-${seed}`;
  const line = {
    mask: `url(#${maskId})`,
    fill: "none",
    stroke: "var(--accent)",
    strokeOpacity: 0.32,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    vectorEffect: "non-scaling-stroke" as const,
  };
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
      <path d={minor} strokeWidth="1" {...line} />
      <path d={index} strokeWidth="1.5" {...line} />
    </svg>
  );
}
