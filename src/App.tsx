import { useEffect, useRef } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { useSidebar } from "./lib/useSidebar";
import { NAV, Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { LeaveGuard } from "./components/LeaveGuard";
import { TitleBar } from "./components/TitleBar";
import { openPalette } from "./state/paletteStore";
import { refreshPaletteData } from "./lib/usePaletteData";
import { TipLayer } from "./components/TipLayer";
import { ToastHost } from "./components/Toasts";
import { useAtlas } from "./state/AtlasProvider";
import { Dashboard } from "./pages/Dashboard";
import { History } from "./pages/History";
import { Now } from "./pages/Now";
import { Wrapped } from "./pages/Wrapped";
import { Sessions } from "./pages/Sessions";
import { Setup } from "./pages/Setup";
import { Settings } from "./pages/Settings";
import type { View } from "./lib/types";

const PAGES: Record<View, () => React.JSX.Element> = {
  dashboard: Dashboard,
  now: Now,
  sessions: Sessions,
  setup: Setup,
  history: History,
  wrapped: Wrapped,
  settings: Settings,
};

export function App() {
  const { view, setView, info } = useAtlas();
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  const Page = PAGES[view];
  const { collapsed, toggle: toggleSidebar } = useSidebar();

  // Ctrl/Cmd + 1..7 jumps between sections; Ctrl/Cmd + B shows or hides the sidebar;
  // Ctrl/Cmd + K opens the quick jump.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = info.platform === "macos" ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === "k") {
        // An editor that took Ctrl+K for itself keeps it.
        if (e.defaultPrevented) return;
        // Not over another dialog (the quick jump's own panel is the one dialog that may be up).
        // A side sheet marked data-allow-jump (the Toolkit item sheet) may be left by a jump;
        // the unsaved-edit guard still asks first.
        const over = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).some(
          (d) => !d.closest(".qj-root") && !d.hasAttribute("data-allow-jump"),
        );
        if (over) return;
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.key.toLowerCase() === "b") {
        e.preventDefault();
        toggleSidebar();
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault();
        setView(NAV[n - 1].view);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info.platform, setView, toggleSidebar]);

  // The quick jump's lists are read a moment after start, so Ctrl+K opens already full.
  useEffect(() => {
    const t = setTimeout(() => void refreshPaletteData(), 1200);
    return () => clearTimeout(t);
  }, []);

  // After a route change, keyboard and screen-reader users land on the new page.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [view]);

  return (
    <div className="app-shell relative flex h-full" data-side={collapsed ? "collapsed" : "open"}>
      <TitleBar />
      {/* One straight divider from the top edge to the bottom: the sidebar's own right border. */}
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-bg pt-[var(--titlebar-h)]">
        <main ref={main} tabIndex={-1} aria-label={NAV.find((n) => n.view === view)?.label} className="min-h-0 flex-1 overflow-y-auto outline-none">
          <div
            key={view}
            className={`page-enter @container w-full px-[var(--gutter)] py-[var(--gutter-y)] ${view === "now" ? "flex min-h-full flex-col" : view === "setup" || view === "history" || view === "wrapped" || view === "settings" ? "flex h-full flex-col" : ""}`}
          >
            {info.settingsSaveError && (
              <div
                role="alert"
                className="mb-6 flex items-start gap-3 rounded-card border border-danger bg-danger-tint px-4 py-3 text-body text-ink"
              >
                <WarningCircle size={20} weight="fill" className="mt-px shrink-0 text-danger" aria-hidden="true" />
                <p>{info.settingsSaveError}</p>
              </div>
            )}
            <Page />
          </div>
        </main>
      </div>
      <CommandPalette />
      <LeaveGuard />
      <ToastHost />
      <TipLayer resetKey={view} />
    </div>
  );
}
