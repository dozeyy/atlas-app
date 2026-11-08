import type { AppInfo, Theme } from "./types";

/**
 * Pin the theme on <html>. "system" removes the attribute so the OS decides
 * (tokens.css reacts to prefers-color-scheme).
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** Everything that must be on <html> before React paints. */
export function applyBoot(info: AppInfo, root: HTMLElement = document.documentElement): void {
  applyTheme(info.settings.theme, root);
  root.dataset.platform = info.platform;
  root.classList.toggle("backdrop", info.backdrop);
}
