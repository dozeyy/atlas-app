import type { ComponentType } from "react";
import {
  Binoculars,
  ChatsCircle,
  ClockCounterClockwise,
  GearSix,
  type IconProps,
  Sparkle,
  SquaresFour,
  Wrench,
} from "@phosphor-icons/react";
import { IconMotion } from "./IconMotion";
import type { Motion } from "./IconMotion";
import { useAtlas } from "../state/AtlasProvider";
import { modName } from "../lib/appMenu";
import { useSidebar } from "../lib/useSidebar";
import type { View } from "../lib/types";

export const NAV: { view: View; label: string; icon: ComponentType<IconProps>; motion: Motion }[] = [
  { view: "dashboard", label: "Dashboard", icon: SquaresFour, motion: "pop" },
  { view: "now", label: "Now", icon: Binoculars, motion: "tilt" },
  { view: "sessions", label: "Sessions", icon: ChatsCircle, motion: "bob" },
  { view: "setup", label: "Toolkit", icon: Wrench, motion: "wiggle" },
  { view: "history", label: "History", icon: ClockCounterClockwise, motion: "spin" },
  { view: "wrapped", label: "Wrapped", icon: Sparkle, motion: "wiggle" },
  { view: "settings", label: "Settings", icon: GearSix, motion: "spin" },
];

/** One row is 36 px tall with a 2 px gap: the pill moves in steps of this. */
const PITCH = 38;

export function Sidebar() {
  const { info, view, setView } = useAtlas();
  const mod = modName(info.platform);
  const { collapsed } = useSidebar();
  const sb = info.sandbox;
  // Settings sits at the foot of the sidebar; the sliding pill lives with the others.
  const top = NAV.filter((n) => n.view !== "settings");
  const at = top.findIndex((n) => n.view === view);

  const item = (index: number, { view: v, label, icon: Icon, motion }: (typeof NAV)[number], solo = false) => (
    <button
      key={v}
      type="button"
      onClick={() => setView(v)}
      aria-current={v === view ? "page" : undefined}
      title={`${label} (${mod}+${index + 1})`}
      aria-label={label}
      className={`nav-item hover-host${solo ? " nav-solo" : ""}`}
    >
      <span className="nav-face text-body">
        <IconMotion motion={motion} fill>
          <Icon />
        </IconMotion>
        {!solo && <span className="nav-label">{label}</span>}
      </span>
    </button>
  );

  return (
    <aside
      id="app-sidebar"
      className={`side flex shrink-0 flex-col px-3 pb-3${collapsed ? " side-collapsed" : ""}`}
      style={{ background: info.backdrop ? "var(--sidebar-glass)" : "var(--sidebar-solid)" }}
    >
      <nav aria-label="Main" className="relative flex flex-col gap-0.5">
        <span
          aria-hidden="true"
          className="nav-pill"
          style={{ transform: `translateY(${Math.max(0, at) * PITCH}px)`, opacity: at < 0 ? 0 : 1 }}
        />
        {top.map((n, i) => item(i, n))}
      </nav>

      <div className="mt-auto flex flex-col gap-2 pt-4">
        {sb.enabled && (
          <div
            role="status"
            className="flex items-center gap-2 rounded-control border border-line bg-warning-tint px-3 py-2 text-caption font-medium text-ink"
          >
            <span
              aria-hidden="true"
              className={`size-2 shrink-0 rounded-full bg-warning ${sb.state === "preparing" ? "pulse-dot" : ""}`}
            />
            <span className="nav-label">
              {sb.state === "preparing" ? "Preparing sandbox" : sb.state === "failed" ? "Sandbox failed" : "Sandbox mode"}
            </span>
          </div>
        )}
        {/* Settings: icon only, in the sidebar's bottom-right corner (centred when folded). */}
        <nav aria-label="Secondary" className="nav-settings-row">
          {item(NAV.length - 1, NAV[NAV.length - 1]!, true)}
        </nav>
      </div>
    </aside>
  );
}
