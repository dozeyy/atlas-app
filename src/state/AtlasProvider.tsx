import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getBackend } from "../lib/ipc";
import { applyTheme } from "../lib/theme";
import type { AppInfo, Theme, View } from "../lib/types";

interface AtlasContext {
  info: AppInfo;
  view: View;
  setView: (v: View) => void;
  setTheme: (t: Theme) => void;
  setLaunchAnimation: (on: boolean) => void;
  setSandbox: (enabled: boolean) => Promise<void>;
  chooseConfigDir: () => Promise<void>;
  clearConfigDir: () => Promise<void>;
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

  // Live updates from Rust (the sandbox copy finishing in the background).
  useEffect(() => {
    alive.current = true;
    let off: (() => void) | undefined;
    backend
      .onInfo((next) => alive.current && setInfo(next))
      .then((fn) => {
        if (alive.current) off = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      off?.();
    };
  }, [backend]);

  const run = useCallback(async (p: Promise<AppInfo>) => {
    try {
      const next = await p;
      if (alive.current) setInfo(next);
    } catch (e) {
      console.error("[atlas] command failed", e);
    }
  }, []);

  const setView = useCallback(
    (v: View) => {
      setViewState(v);
      void run(backend.updateSettings({ lastView: v }));
    },
    [backend, run],
  );

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

  const value = useMemo<AtlasContext>(
    () => ({
      info,
      view,
      setView,
      setTheme,
      setLaunchAnimation,
      setSandbox: (enabled) => run(backend.setSandbox(enabled)),
      chooseConfigDir: () => run(backend.chooseConfigDir()),
      clearConfigDir: () => run(backend.clearConfigDir()),
    }),
    [info, view, setView, setTheme, setLaunchAnimation, run, backend],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
