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
  const mod = info.platform === "macos" ? "Cmd" : "Ctrl";
  const sb = info.sandbox;
  const daily = useDaily(info.config?.projectsDir ?? null);
  const at = Math.max(0, NAV.findIndex((n) => n.view === view));

  return (
    <aside
      className="flex w-[var(--sidebar-w)] shrink-0 flex-col px-3 pb-4 pt-[calc(var(--titlebar-inset)+8px)]"
      style={{ background: info.backdrop ? "var(--sidebar-glass)" : "var(--sidebar-solid)" }}
    >
      <nav aria-label="Main" className="relative flex flex-col gap-0.5">
        <span aria-hidden="true" className="nav-pill" style={{ transform: `translateY(${at * PITCH}px)` }} />
        {NAV.map(({ view: v, label, icon: Icon, motion }, i) => {
          const active = v === view;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-current={active ? "page" : undefined}
              title={`${label} (${mod}+${i + 1})`}
              className="nav-item hover-host"
            >
              <span className="nav-face text-body">
                <IconMotion motion={motion} fill>
                  <Icon />
                </IconMotion>
                {label}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-2 pt-4">
        {daily && daily.streak >= 1 && (
          <button
            type="button"
            onClick={() => setView("dashboard")}
            title="See your streak on the Dashboard"
            className="nav-item hover-host streak-btn"
          >
            <span className="nav-face text-body text-accent-text">
              <span aria-hidden="true" className="spark" />
              <span className="font-semibold">{daily.streak === 1 ? "1 day streak" : `${daily.streak} day streak`}</span>
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
            {sb.state === "preparing"
              ? "Preparing sandbox"
              : sb.state === "failed"
                ? "Sandbox failed"
                : "Sandbox mode"}
          </div>
        )}
        <span className="px-3 text-caption text-ink-2">Version {info.version}</span>
      </div>
    </aside>
  );
}
