import { useCountUp } from "../lib/useCountUp";
import { prefersReducedMotion } from "../lib/motion";

/**
 * A number that counts up. An invisible copy of the final text sits in the same grid cell,
 * so the box is final-sized from the first frame and nothing around it shifts. Screen
 * readers get the final figure, never the ticks.
 */
export function CountUp({
  value,
  format,
  id,
  className = "",
}: {
  value: number;
  format: (v: number) => string;
  /** Counts from 0 the first time this id shows in a launch. */
  id?: string;
  className?: string;
}) {
  const { value: shown, running } = useCountUp(value, id);
  const final = format(value);
  // Reduced motion never counts, so the sizing twin is not needed (and would double the text).
  if (prefersReducedMotion() && !running) return <span className={className}>{final}</span>;
  return (
    <span className={`inline-grid ${className}`}>
      <span aria-hidden="true" className="invisible [grid-area:1/1]">
        {final}
      </span>
      <span aria-hidden={running || undefined} className="[grid-area:1/1]">
        {running ? format(shown) : final}
      </span>
      {running && <span className="sr-only">{final}</span>}
    </span>
  );
}
