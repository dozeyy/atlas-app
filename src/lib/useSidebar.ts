import { useCallback, useSyncExternalStore } from "react";
import { FRAME_EVENT, liveFrameWidth } from "./frameSync";

/** Below this window width the sidebar folds to icons, unless the user chose otherwise. */
const NARROW_PX = 1000;
const NARROW = "(max-width: 999.98px)";
const KEY = "atlas.sidebar";

/** "auto" follows the window width; "expanded" / "collapsed" is the user's own choice and wins. */
export type SidebarPref = "auto" | "expanded" | "collapsed";

// Kept in memory too, for a browser that refuses localStorage (private mode): the choice then
// lasts for this session only.
let memory: SidebarPref = "auto";
const listeners = new Set<() => void>();

export function readSidebarPref(): SidebarPref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "expanded" || v === "collapsed" ? v : "auto";
  } catch {
    return memory;
  }
}

export function writeSidebarPref(next: SidebarPref) {
  memory = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* kept in memory above */
  }
  listeners.forEach((l) => l());
}

// While a window edge is dragged on Windows the webview is bigger than the window, so the media
// query reads the webview; the window's own width then comes from the drag (frameSync.ts).
const narrowNow = () => {
  const live = liveFrameWidth();
  if (live !== null) return live < NARROW_PX;
  return typeof window.matchMedia === "function" && window.matchMedia(NARROW).matches;
};

function subscribe(cb: () => void) {
  listeners.add(cb);
  const mq = typeof window.matchMedia === "function" ? window.matchMedia(NARROW) : null;
  mq?.addEventListener("change", cb);
  window.addEventListener(FRAME_EVENT, cb);
  return () => {
    listeners.delete(cb);
    mq?.removeEventListener("change", cb);
    window.removeEventListener(FRAME_EVENT, cb);
  };
}

/** Pure: whether the sidebar is folded, given the saved choice and the window width. */
export function isCollapsed(pref: SidebarPref, narrow: boolean): boolean {
  return pref === "auto" ? narrow : pref === "collapsed";
}

/**
 * Whether the sidebar is folded to icons, and the toggle that flips it. One shared store, so the
 * toggle in the title bar, the sidebar itself and Ctrl/Cmd+B all agree. The first toggle makes
 * an explicit choice, which is remembered on this device and beats the window width from then on.
 */
export function useSidebar(): { collapsed: boolean; toggle: () => void } {
  const collapsed = useSyncExternalStore(
    subscribe,
    () => isCollapsed(readSidebarPref(), narrowNow()),
    () => false,
  );
  const toggle = useCallback(() => {
    writeSidebarPref(isCollapsed(readSidebarPref(), narrowNow()) ? "expanded" : "collapsed");
  }, []);
  return { collapsed, toggle };
}
