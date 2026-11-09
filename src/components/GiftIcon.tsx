import { useId } from "react";
import type { IconProps } from "@phosphor-icons/react";

// Phosphor's Gift, drawn from its own paths so the weight and size match every other nav icon, but
// cut in two at the seam between the lid and the box: the lid (and the bow on it) is its own group
// so the "gift" hover motion can pop it. IconMotion stacks this for the regular, duotone and fill
// weights exactly as it does for a Phosphor icon.
const OUTLINE =
  "M216,72H180.92c.39-.33.79-.65,1.17-1A29.53,29.53,0,0,0,192,49.57,32.62,32.62,0,0,0,158.44,16,29.53,29.53,0,0,0,137,25.91a54.94,54.94,0,0,0-9,14.48,54.94,54.94,0,0,0-9-14.48A29.53,29.53,0,0,0,97.56,16,32.62,32.62,0,0,0,64,49.57,29.53,29.53,0,0,0,73.91,71c.38.33.78.65,1.17,1H40A16,16,0,0,0,24,88v32a16,16,0,0,0,16,16v64a16,16,0,0,0,16,16H200a16,16,0,0,0,16-16V136a16,16,0,0,0,16-16V88A16,16,0,0,0,216,72ZM149,36.51a13.69,13.69,0,0,1,10-4.5h.49A16.62,16.62,0,0,1,176,49.08a13.69,13.69,0,0,1-4.5,10c-9.49,8.4-25.24,11.36-35,12.4C137.7,60.89,141,45.5,149,36.51Zm-64.09.36A16.63,16.63,0,0,1,96.59,32h.49a13.69,13.69,0,0,1,10,4.5c8.39,9.48,11.35,25.2,12.39,34.92-9.72-1-25.44-4-34.92-12.39a13.69,13.69,0,0,1-4.5-10A16.6,16.6,0,0,1,84.87,36.87ZM40,88h80v32H40Zm16,48h64v64H56Zm144,64H136V136h64Zm16-80H136V88h80v32Z";
const SOLID =
  "M216,72H180.92c.39-.33.79-.65,1.17-1A29.53,29.53,0,0,0,192,49.57,32.62,32.62,0,0,0,158.44,16,29.53,29.53,0,0,0,137,25.91a54.94,54.94,0,0,0-9,14.48,54.94,54.94,0,0,0-9-14.48A29.53,29.53,0,0,0,97.56,16,32.62,32.62,0,0,0,64,49.57,29.53,29.53,0,0,0,73.91,71c.38.33.78.65,1.17,1H40A16,16,0,0,0,24,88v32a16,16,0,0,0,16,16v64a16,16,0,0,0,16,16h60a4,4,0,0,0,4-4V120H40V88h80v32h16V88h80v32H136v92a4,4,0,0,0,4,4h60a16,16,0,0,0,16-16V136a16,16,0,0,0,16-16V88A16,16,0,0,0,216,72ZM84.51,59a13.69,13.69,0,0,1-4.5-10A16.62,16.62,0,0,1,96.59,32h.49a13.69,13.69,0,0,1,10,4.5c8.39,9.48,11.35,25.2,12.39,34.92C109.71,70.39,94,67.43,84.51,59Zm87,0c-9.49,8.4-25.24,11.36-35,12.4C137.7,60.89,141,45.5,149,36.51a13.69,13.69,0,0,1,10-4.5h.49A16.62,16.62,0,0,1,176,49.08,13.69,13.69,0,0,1,171.49,59Z";
const BOX_TINT = "M208,128v72a8,8,0,0,1-8,8H56a8,8,0,0,1-8-8V128Z";

export function GiftIcon({ weight = "regular", size = 18, color = "currentColor", className }: IconProps) {
  const id = useId();
  const d = weight === "fill" ? SOLID : OUTLINE;
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width={size} height={size} fill={color} className={className} overflow="visible">
      <defs>
        <clipPath id={`${id}-lid`}>
          <rect x="0" y="-64" width="256" height="189" />
        </clipPath>
        <clipPath id={`${id}-box`}>
          <rect x="0" y="124" width="256" height="132" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${id}-box)`}>
        {weight === "duotone" && <path d={BOX_TINT} opacity="0.2" />}
        <path d={d} />
      </g>
      <g className="gift-lid">
        <g clipPath={`url(#${id}-lid)`}>
          <path d={d} />
        </g>
      </g>
    </svg>
  );
}
