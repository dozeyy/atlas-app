import type { AppInfo, Theme } from "./types";
import { applyDisplay } from "./zoom";

/**
 * Pin the theme on <html>. "system" removes the attribute so the OS decides
 * (tokens.css reacts to prefers-color-scheme: light gives Light, dark gives Dark).
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** The theme actually showing: "system" resolved through the OS setting. */
export function resolveTheme(theme: Theme): "light" | "silver" | "dark" {
  if (theme !== "system") return theme;
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Keeps `html.reduced` equal to the OS "reduce motion" setting; the CSS only looks at the class. */
export function syncReducedMotion(root: HTMLElement = document.documentElement): void {
  let mq: MediaQueryList | undefined;
  try {
    mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  } catch {
    return;
  }
  const set = () => root.classList.toggle("reduced", mq!.matches);
  set();
  mq.addEventListener?.("change", set);
}

/** Everything that must be on <html> before React paints. */
export function applyBoot(info: AppInfo, root: HTMLElement = document.documentElement): void {
  applyTheme(info.settings.theme, root);
  applyDisplay(info.settings, root);
  root.dataset.platform = info.platform;
  root.classList.toggle("backdrop", info.backdrop);
  syncReducedMotion(root);
}
