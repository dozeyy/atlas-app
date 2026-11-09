import { cloneElement } from "react";
import type { ReactElement } from "react";
import type { IconProps } from "@phosphor-icons/react";

export type Motion = "zap" | "tilt" | "nudge" | "plug" | "swing" | "wiggle" | "bob" | "pop" | "spin" | "gift";

/**
 * A Phosphor icon with one small move that plays once when its button, link or card is
 * hovered, and a crossfade from the regular to the duotone weight. Optional fill weight for
 * the active nav item. The motion is CSS (trail.css); this only stacks the weights.
 *
 *   <IconMotion motion="zap"><Lightning /></IconMotion>
 */
export function IconMotion({
  motion,
  children,
  size,
  fill = false,
  still = false,
  className = "",
}: {
  motion: Motion;
  children: ReactElement<IconProps>;
  size?: number;
  /** Also render the fill weight (shown when an ancestor has aria-current="page"). */
  fill?: boolean;
  /** No weight swap on hover (the icon is its own state, like a spinner). */
  still?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-m={motion}
      className={`ico${still ? " ico-still" : ""} ${className}`}
      style={size ? { width: size, height: size } : undefined}
    >
      {cloneElement(children, { weight: "regular", size: "100%", className: "w-reg" })}
      {!still && cloneElement(children, { weight: "duotone", size: "100%", className: "w-duo" })}
      {fill && cloneElement(children, { weight: "fill", size: "100%", className: "w-fill" })}
    </span>
  );
}
