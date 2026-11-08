import type { SVGProps } from "react";

/**
 * The Filter icon: three horizontal lines, centered, the longest on top and the shortest at the
 * bottom (a funnel drawn as bars). Phosphor's FunnelSimple is a solid funnel and is not this.
 * Drawn on the same 256 grid, stroke and round caps as the Phosphor "regular" set so it sits
 * beside ArrowsDownUp (the Sort icon) and MagnifyingGlass at the same weight.
 */
export function FilterLines({ size = 16, ...rest }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      stroke="currentColor"
      strokeWidth={16}
      strokeLinecap="round"
      aria-hidden="true"
      {...rest}
    >
      <line x1="40" y1="80" x2="216" y2="80" />
      <line x1="72" y1="128" x2="184" y2="128" />
      <line x1="104" y1="176" x2="152" y2="176" />
    </svg>
  );
}
