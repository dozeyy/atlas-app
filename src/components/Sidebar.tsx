import type { ComponentType } from "react";
import {
  Binoculars,
  ChatsCircle,
  ClockCounterClockwise,
  GearSix,
  type IconProps,
  SquaresFour,
  Wrench,
} from "@phosphor-icons/react";
import { GiftIcon } from "./GiftIcon";
import { IconMotion } from "./IconMotion";
import { UpdateButton } from "./UpdateButton";
import { TodayStat } from "./TodayStat";
import type { Motion } from "./IconMotion";
import { useAtlas } from "../state/AtlasProvider";
import { useKeyHints } from "../lib/keyHints";
import { useSidebar } from "../lib/useSidebar";
import type { View } from "../lib/types";

export const NAV: { view: View; label: string; icon: ComponentType<IconProps>; motion: Motion }[] = [
  { view: "dashboard", label: "Dashboard", icon: SquaresFour, motion: "pop" },
  { view: "now", label: "Now", icon: Binoculars, motion: "tilt" },
  { view: "sessions", label: "Sessions", icon: ChatsCircle, motion: "bob" },
  { view: "setup", label: "Toolkit", icon: Wrench, motion: "wiggle" },
  { view: "history", label: "History", icon: ClockCounterClockwise, motion: "spin" },
  { view: "settings", label: "Settings", icon: GearSix, motion: "spin" },
  // Not in the list: its button is the gift at the right end of the title bar (TitleBar.tsx).
  // Last, so the shortcuts run 1 to 7 with no gap.
  { view: "wrapped", label: "Wrapped", icon: GiftIcon, motion: "gift" },
];

/** One row is 36 px tall with a 2 px gap: the pill moves in steps of this. */
const PITCH = 38;

export function Sidebar() {
  const { info, view, setView } = useAtlas();
  const { show, tip, mod } = useKeyHints();
  const { collapsed } = useSidebar();
  const sb = info.sandbox;
  // Settings sits at the foot of the sidebar and Wrapped in the title bar; the sliding pill lives with the others.
  const top = NAV.filter((n) => n.view !== "settings" && n.view !== "wrapped");
  const at = top.findIndex((n) => n.view === view);

  const item = (n: (typeof NAV)[number], solo = false) => {
    const { view: v, label, icon: Icon, motion } = n;
    const index = NAV.indexOf(n);
    // A hover only where it tells something new: the name where nothing on screen says it (the gear,
    // and every item while the sidebar is folded to icons), and the keys when Settings > Show
    // shortcuts is on. A labelled item with the keys off has none: its label already says what it is.
    const named = !solo && !collapsed;
    return (
      <button
        key={v}
        type="button"
        onClick={() => setView(v)}
        aria-current={v === view ? "page" : undefined}
        title={named && !show ? undefined : tip(label, `${mod}+${index + 1}`)}
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
  };

  return (
    <aside
      id="app-sidebar"
      className={`side flex shrink-0 flex-col px-3 pb-3${collapsed ? " side-collapsed" : ""}`}
      style={{ background: info.backdrop ? "var(--sidebar-glass)" : "var(--sidebar-solid)" }}
    >
      <nav aria-label="Main" className="side-main relative flex flex-col gap-0.5">
        <span
          aria-hidden="true"
          className="nav-pill"
          style={{ transform: `translateY(${Math.max(0, at) * PITCH}px)`, opacity: at < 0 ? 0 : 1 }}
        />
        {top.map((n) => item(n))}
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
        {/* Settings: icon only, in the sidebar's bottom-right corner (centred when folded). The
            update icon, when there is one, mirrors it at the bottom-left (above it when folded);
            the Today readout fills the space between them while the sidebar is open. */}
        <nav aria-label="Secondary" className="nav-settings-row">
          <UpdateButton />
          <TodayStat />
          {item(NAV.find((n) => n.view === "settings")!, true)}
        </nav>
      </div>
    </aside>
  );
}
