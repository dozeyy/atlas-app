import { useMemo } from "react";
import { smoothPath } from "../../lib/chartPaths";
import { useIntro } from "../../lib/motion";

/**
 * A 64 x 20 trend line for a row. Decorative: the row already says the numbers in words, so
 * it is hidden from screen readers and takes no focus.
 */
export function Sparkline({ id, values, width = 64, height = 20 }: { id: string; values: number[]; width?: number; height?: number }) {
  const intro = useIntro(id);
  const { d, len, last } = useMemo(() => {
    const max = Math.max(1, ...values);
    const n = values.length;
    const pts: [number, number][] = values.map((v, i) => [
      n === 1 ? width / 2 : 2 + (i * (width - 4)) / (n - 1),
      height - 3 - (v / max) * (height - 6),
    ]);
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { d: pts.length > 1 ? smoothPath(pts) : "", len: Math.ceil(len * 1.12), last: pts[pts.length - 1] };
  }, [values, width, height]);

  if (!d) return <span aria-hidden="true" style={{ width, height }} className="inline-block" />;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={width}
      height={height}
      className={`chart shrink-0${intro ? " intro" : ""}`}
    >
      <path className="spark-line" d={d} style={{ ["--len" as string]: len }} />
      <circle cx={last[0]} cy={last[1]} r={2.25} fill="var(--accent)" />
    </svg>
  );
}
