import { useEffect, useRef } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { NAV, Sidebar } from "./components/Sidebar";
import { useAtlas } from "./state/AtlasProvider";
import { Dashboard } from "./pages/Dashboard";
import { History, Wrapped } from "./pages/Placeholders";
import { Sessions } from "./pages/Sessions";
import { Setup } from "./pages/Setup";
import { Settings } from "./pages/Settings";
import type { View } from "./lib/types";

const PAGES: Record<View, () => React.JSX.Element> = {
  dashboard: Dashboard,
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

  // Ctrl/Cmd + 1..6 jumps between sections.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = info.platform === "macos" ? e.metaKey : e.ctrlKey;
      if (!mod || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (n >= 1 && n <= NAV.length) {
        e.preventDefault();
        setView(NAV[n - 1].view);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [info.platform, setView]);

  // After a route change, keyboard and screen-reader users land on the new page.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    main.current?.focus({ preventScroll: true });
  }, [view]);

  return (
    <div className="flex h-full">
      {info.platform === "macos" && (
        <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-10 h-[var(--titlebar-inset)]" />
      )}
      <Sidebar />
      <main
        ref={main}
        tabIndex={-1}
        aria-label={NAV.find((n) => n.view === view)?.label}
        className={`mt-[var(--titlebar-inset)] min-w-0 flex-1 overflow-y-auto bg-bg outline-none ${
          info.backdrop ? "rounded-tl-[var(--r-sheet)] border-l border-t border-line" : "border-l border-line"
        }`}
      >
        <div
          key={view}
          className={`page-enter mx-auto w-full px-10 py-10 ${view === "setup" ? "flex min-h-full max-w-[1180px] flex-col" : view === "history" || view === "wrapped" ? "flex min-h-full max-w-[var(--content-max)] flex-col" : "max-w-[var(--content-max)]"}`}
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
  );
}
