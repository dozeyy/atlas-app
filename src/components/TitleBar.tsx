import { useEffect, useState } from "react";
import type { PointerEvent } from "react";
import { SidebarSimple } from "@phosphor-icons/react";
import { AppMenu } from "./AppMenu";
import { IconButton } from "./controls";
import { GiftIcon } from "./GiftIcon";
import { IconMotion } from "./IconMotion";
import { NAV } from "./Sidebar";
import { modName } from "../lib/appMenu";
import { getBackend } from "../lib/ipc";
import { useSidebar } from "../lib/useSidebar";
import { useAtlas } from "../state/AtlasProvider";

/**
 * The row across the top of the window (like the Claude app): a drag region with the menu and
 * the sidebar toggle at the left, the window's three caption buttons at the right, and a 1 px
 * hairline under it. It lies over both columns; the sidebar column's colour runs up behind the
 * left end, so the divider between the columns is one straight line from the top edge to the
 * bottom. While the sidebar is folded the hairline runs the full width, which sets the two
 * buttons apart from the icons below them. Windows draws no title bar of its own (the window
 * has no frame), so the caption buttons are ours; macOS keeps its traffic lights (the buttons
 * start after them); Linux keeps its own frame and shows the row below it without them.
 */
export function TitleBar() {
  const { info } = useAtlas();
  const { collapsed, toggle } = useSidebar();
  return (
    <header data-tauri-drag-region className="titlebar">
      <div data-tauri-drag-region className="titlebar-left">
        <AppMenu />
        <IconButton
          aria-label="Sidebar"
          aria-expanded={!collapsed}
          aria-controls="app-sidebar"
          title={`${collapsed ? "Show" : "Hide"} sidebar (${modName(info.platform)}+B)`}
          onClick={toggle}
        >
          <SidebarSimple size={18} aria-hidden="true" />
        </IconButton>
      </div>
      <WrappedButton />
      {info.platform === "windows" && <CaptionButtons />}
    </header>
  );
}

/**
 * Wrapped: an icon-only gift at the far right of the sidebar's top row (the toggle stays at the
 * left). Folded, the column is too narrow for both, so it drops under the toggle, centred over
 * the icons. It is a button of its own, not part of the drag region, so a click opens Wrapped and
 * a drag anywhere else on the row still moves the window.
 */
function WrappedButton() {
  const { info, view, setView } = useAtlas();
  const at = NAV.findIndex((n) => n.view === "wrapped");
  const here = view === "wrapped";
  return (
    <IconButton
      aria-label="Wrapped"
      aria-current={here ? "page" : undefined}
      // No tip once you are on it: an empty title (not a missing one, which the tip layer cannot
      // see change while it holds the old text) so nothing hangs over the page the click opened.
      title={here ? "" : `Wrapped (${modName(info.platform)}+${at + 1})`}
      className="titlebar-gift hover-host"
      onClick={() => setView("wrapped")}
    >
      <IconMotion motion="gift" fill>
        <GiftIcon />
      </IconMotion>
    </IconButton>
  );
}

const GLYPH = { width: 10, height: 10, viewBox: "0 0 10 10", fill: "none", stroke: "currentColor", strokeWidth: 1, "aria-hidden": true } as const;

function CaptionButtons() {
  const backend = getBackend();
  const [maximized, setMaximized] = useState(false);

  // The middle button shows Restore while the window is maximized; a resize is when that can change.
  useEffect(() => {
    let alive = true;
    const ask = () => backend.windowMaximized().then((m) => alive && setMaximized(m)).catch(() => {});
    ask();
    window.addEventListener("resize", ask);
    return () => {
      alive = false;
      window.removeEventListener("resize", ask);
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
