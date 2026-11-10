import { useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { AppMenu } from "./AppMenu";
import { IconButton } from "./controls";
import { IconMotion } from "./IconMotion";
import { NAV } from "./Sidebar";
import { useKeyHints } from "../lib/keyHints";
import { getBackend } from "../lib/ipc";
import { useSidebar } from "../lib/useSidebar";
import { useAtlas } from "../state/AtlasProvider";
import type { View } from "../lib/types";

/**
 * The row across the top of the window (like the Claude app): a drag region with the sidebar's
 * four corner buttons at the left, the window's three caption buttons at the right, and a 1 px
 * hairline under it. It lies over both columns; the sidebar column's colour runs up behind the
 * left end, so the divider between the columns is one straight line from the top edge to the
 * bottom, and the hairline starts at that divider in both states.
 *
 * Open, the four sit in one row: menu, Settings, sidebar toggle, then Wrapped at the far right of
 * the sidebar's top row. Folded, they close up into a 2 x 2 square at the top-left (Settings under
 * the menu, Wrapped under the toggle), so the same buttons are in the same corner either way.
 * Every one of them keeps the same 4 px to its column's edges (trail.css, --shell-inset).
 * Windows draws no title bar of its own (the window has no frame), so the caption buttons are
 * ours; macOS keeps its traffic lights (the buttons start after them); Linux keeps its own frame
 * and shows the row below it without them.
 */
export function TitleBar() {
  const { info } = useAtlas();
  const { collapsed, toggle } = useSidebar();
  const { tip, mod } = useKeyHints();
  return (
    <header data-tauri-drag-region className="titlebar">
      <div data-tauri-drag-region className="titlebar-left">
        <AppMenu />
        {/* In the markup between the menu and the toggle, where it sits in the open row, so Tab
            walks the row in reading order (folded, it walks the square down then across). */}
        <CornerButton view="settings" className="titlebar-settings" />
        <IconButton
          aria-label="Sidebar"
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          title={tip(`${collapsed ? "Show" : "Hide"} sidebar`, `${mod}+B`)}
          className="titlebar-toggle"
          onClick={toggle}
        >
          <SidebarSimple size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <CornerButton view="wrapped" className="titlebar-gift" />
      {info.platform === "windows" && <CaptionButtons />}
    </header>
  );
}

/**
 * Settings and Wrapped: icon-only buttons of their own in the title bar row (their place is set in
 * trail.css, and moves with the fold). Not part of the drag region, so a click opens the page and a
 * drag anywhere else on the row still moves the window. The one you are on wears the accent tint.
 */
function CornerButton({ view: v, className }: { view: View; className: string }) {
  const { view, setView } = useAtlas();
  const { tip, mod } = useKeyHints();
  const at = NAV.findIndex((n) => n.view === v);
  const { label, icon: Icon, motion } = NAV[at];
  const here = view === v;
  return (
    <IconButton
      aria-label={label}
      aria-current={here ? "page" : undefined}
      // No tip once you are on it: an empty title (not a missing one, which the tip layer cannot
      // see change while it holds the old text) so nothing hangs over the page the click opened.
      title={here ? "" : tip(label, `${mod}+${at + 1}`)}
      className={`titlebar-corner ${className} hover-host`}
      onClick={() => setView(v)}
    >
      <IconMotion motion={motion} fill>
        <Icon />
      </IconMotion>
    </IconButton>
  );
}

const GLYPH = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1, "aria-hidden": true } as const;

function CaptionButtons() {
  const backend = getBackend();
  const [maximized, setMaximized] = useState(false);

  // The middle button shows Restore while the window is maximized. Asked once, then told by Rust
  // when it changes: nothing crosses IPC on each step of an edge drag.
  useEffect(() => {
    let alive = true;
    let off: (() => void) | undefined;
    backend.windowMaximized().then((m) => alive && setMaximized(m)).catch(() => {});
    backend
      .onMaximized((m) => alive && setMaximized(m))
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [backend]);

  const act = (a: "minimize" | "toggle-maximize" | "close") => () => void backend.windowControl(a).catch(() => {});
  // A mouse press must not leave a caption button holding keyboard focus: after a minimize and a
  // restore, Space would press it again instead of going to the page. (Keyboard use never fires a
  // pointer-up, so a Tab-focused button keeps its focus.)
  const letGo = (e: PointerEvent<HTMLButtonElement>) => e.currentTarget.blur();
  return (
    <div className="caption-buttons">
      <button type="button" className="caption-btn" aria-label="Minimize" onClick={act("minimize")} onPointerUp={letGo}>
        <svg {...GLYPH}>
          <path d="M0 5.5h10" />
        </svg>
      </button>
      <button type="button" className="caption-btn" aria-label={maximized ? "Restore" : "Maximize"} onClick={act("toggle-maximize")} onPointerUp={letGo}>
        {maximized ? (
          <svg {...GLYPH}>
            <path d="M2.5 2.5V.5h7v7h-2" />
            <rect x="0.5" y="2.5" width="7" height="7" />
          </svg>
        ) : (
          <svg {...GLYPH}>
            <rect x="0.5" y="0.5" width="9" height="9" />
          </svg>
        )}
      </button>
      <button type="button" className="caption-btn caption-close" aria-label="Close" onClick={act("close")} onPointerUp={letGo}>
        <svg {...GLYPH}>
          <path d="M0 0l10 10M10 0L0 10" />
        </svg>
      </button>
    </div>
  );
}
