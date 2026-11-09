import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getBackend } from "../lib/ipc";
import { applyTheme } from "../lib/theme";
import { pushToast } from "./toastStore";
import { guardLeave } from "./unsavedStore";
import type { AppInfo, Theme, View } from "../lib/types";

interface AtlasContext {
  info: AppInfo;
  view: View;
  setView: (v: View) => void;
  /** Back to the page before this one (the dashboard when there is none). */
  goBack: () => void;
  setTheme: (t: Theme) => void;
  setLaunchAnimation: (on: boolean) => void;
  setCloseToTray: (on: boolean) => void;
  setNotifyOnFinish: (on: boolean) => void;
  setHistoryKeep: (n: number) => void;
  setSandbox: (enabled: boolean) => Promise<void>;
  chooseConfigDir: () => Promise<void>;
  clearConfigDir: () => Promise<void>;
  openConfigDir: () => Promise<void>;
  openDataDir: () => Promise<void>;
}

const Ctx = createContext<AtlasContext | null>(null);

export function useAtlas(): AtlasContext {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAtlas outside AtlasProvider");
  return v;
}

export function AtlasProvider({ children }: { children: ReactNode }) {
  const backend = getBackend();
  const [info, setInfo] = useState<AppInfo>(() => backend.boot());
  const [view, setViewState] = useState<View>(info.settings.lastView);
  const alive = useRef(true);
  // Newest snapshot taken so far. An event and a command result can cross on
  // the way; whichever carries the lower sequence number is stale and dropped.
  const newest = useRef(info.seq);
  const accept = useCallback((next: AppInfo) => {
    if (!alive.current || next.seq < newest.current) return;
    newest.current = next.seq;
    setInfo(next);
  }, []);

  // Live updates from Rust (the sandbox copy finishing in the background).
  useEffect(() => {
    alive.current = true;
    let off: (() => void) | undefined;
    backend
      .onInfo(accept)
      .then((fn) => {
        if (alive.current) off = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      off?.();
    };
  }, [backend, accept]);

  const run = useCallback(
    async (p: Promise<AppInfo>) => {
      try {
        accept(await p);
      } catch (e) {
        console.error("[atlas] command failed", e);
      }
    },
    [accept],
  );

  // Every way to change the view (sidebar, Ctrl+1..7, the quick jump, the Wrapped gift, the app
  // menu) comes through here, so an editor with unsaved edits is asked about once, in one place.
  const viewNow = useRef(view);
  viewNow.current = view;
  // The page you were on before this one, so Esc on a full-page story can take you back to it.
  const cameFrom = useRef<View | null>(null);
  const setView = useCallback(
    (v: View) => {
      if (v === viewNow.current) return;
      guardLeave(() => {
        cameFrom.current = viewNow.current;
        setViewState(v);
        void run(backend.updateSettings({ lastView: v }));
      });
    },
    [backend, run],
  );
  const goBack = useCallback(() => {
    const to = cameFrom.current;
    setView(to && to !== viewNow.current ? to : "dashboard");
  }, [setView]);

  const setTheme = useCallback(
    (t: Theme) => {
      applyTheme(t); // instant; the save follows
      void run(backend.updateSettings({ theme: t }));
    },
    [backend, run],
  );

  const setLaunchAnimation = useCallback(
    (on: boolean) => void run(backend.updateSettings({ launchAnimation: on })),
    [backend, run],
  );

  const setCloseToTray = useCallback(
    (on: boolean) => void run(backend.updateSettings({ closeToTray: on })),
    [backend, run],
  );

  const setNotifyOnFinish = useCallback(
    (on: boolean) => void run(backend.updateSettings({ notifyOnFinish: on })),
    [backend, run],
  );

  // A chat Atlas watched working has stopped. Rust only sends this while the setting is on;
  // the toast is the in-window half (a desktop notice covers the window being behind).
  useEffect(() => {
    let dead = false;
    let off: (() => void) | undefined;
    backend
      .onNowFinished((f) => {
        pushToast({ message: f.kind === "ask" ? `${f.name} has a question for you` : `${f.name} finished`, tone: "info", ms: 6_000 });
      })
      .then((fn) => (dead ? fn() : (off = fn)))
      .catch(() => {});
    return () => {
      dead = true;
      off?.();
    };
  }, [backend]);

  const setHistoryKeep = useCallback(
    (n: number) => void run(backend.updateSettings({ historyKeepVersions: n })),
    [backend, run],
  );

  const value = useMemo<AtlasContext>(
    () => ({
      info,
      view,
      setView,
      goBack,
      setTheme,
      setLaunchAnimation,
      setCloseToTray,
      setNotifyOnFinish,
      setHistoryKeep,
      setSandbox: (enabled) => run(backend.setSandbox(enabled)),
      chooseConfigDir: () => run(backend.chooseConfigDir()),
      clearConfigDir: () => run(backend.clearConfigDir()),
      openConfigDir: () => backend.openConfigDir().catch(() => {}),
      openDataDir: () => backend.openDataDir().catch(() => {}),
    }),
    [info, view, setView, goBack, setTheme, setLaunchAnimation, setCloseToTray, setNotifyOnFinish, setHistoryKeep, run, backend],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
