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
import { useAtlas } from "../state/AtlasProvider";
import type { View } from "../lib/types";

export const NAV: { view: View; label: string; icon: ComponentType<IconProps> }[] = [
  { view: "dashboard", label: "Dashboard", icon: SquaresFour },
  { view: "sessions", label: "Sessions", icon: ChatsCircle },
  { view: "setup", label: "Setup", icon: Wrench },
  { view: "history", label: "History", icon: ClockCounterClockwise },
  { view: "wrapped", label: "Wrapped", icon: Sparkle },
  { view: "settings", label: "Settings", icon: GearSix },
];

export function Sidebar() {
  const { info, view, setView } = useAtlas();
  const mod = info.platform === "macos" ? "Cmd" : "Ctrl";
  const sb = info.sandbox;

  return (
    <aside
      className="flex w-[var(--sidebar-w)] shrink-0 flex-col px-3 pb-4 pt-[calc(var(--titlebar-inset)+8px)]"
      style={{ background: info.backdrop ? "var(--sidebar-glass)" : "var(--sidebar-solid)" }}
    >
      <nav aria-label="Main" className="flex flex-col gap-0.5">
        {NAV.map(({ view: v, label, icon: Icon }, i) => {
          const active = v === view;
          return (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              aria-current={active ? "page" : undefined}
              title={`${label} (${mod}+${i + 1})`}
              className={`press flex h-9 cursor-pointer items-center gap-3 rounded-control px-3 text-body font-medium ${
                active
                  ? "bg-accent-tint text-accent-text"
                  : "text-ink-2 hover:bg-raised hover:text-ink"
              }`}
            >
              <Icon size={18} weight={active ? "fill" : "regular"} aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex flex-col gap-2 px-2 pt-4">
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
        <span className="text-caption text-ink-2">Version {info.version}</span>
      </div>
    </aside>
  );
}
