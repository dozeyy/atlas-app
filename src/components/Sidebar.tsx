import type { ComponentType } from "react";
import {
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
import { useDaily } from "../lib/useDaily";
import { modName } from "../lib/appMenu";
import { useSidebar } from "../lib/useSidebar";
import type { View } from "../lib/types";

export const NAV: { view: View; label: string; icon: ComponentType<IconProps>; motion: Motion }[] = [
  { view: "dashboard", label: "Dashboard", icon: SquaresFour, motion: "pop" },
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
  const daily = useDaily(info.config?.projectsDir ?? null);
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
        <span className="nav-label">{label}</span>
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
        {daily && daily.streak >= 1 && (
          <button
            type="button"
            onClick={() => setView("dashboard")}
            title={daily.streak === 1 ? "1 day streak. See it on the Dashboard" : `${daily.streak} day streak. See it on the Dashboard`}
            aria-label={daily.streak === 1 ? "1 day streak" : `${daily.streak} day streak`}
            className="nav-item hover-host streak-btn"
          >
            <span className="nav-face text-body text-accent-text">
              <span aria-hidden="true" className="spark" />
              <span className="nav-label font-semibold">{daily.streak === 1 ? "1 day streak" : `${daily.streak} day streak`}</span>
            </span>
          </button>
        )}
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
        <nav aria-label="Secondary" className="flex flex-col gap-0.5">
          {item(NAV.length - 1, NAV[NAV.length - 1]!, true)}
        </nav>
      </div>
    </aside>
  );
}
