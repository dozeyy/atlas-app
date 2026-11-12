import type { Platform, Settings, TextSize } from "./types";

/** The zoom steps (percent) Ctrl/Cmd + and - walk through. Same list as `ZOOM_LEVELS` in crates/core/src/settings.rs. */
export const ZOOM_LEVELS = [80, 90, 100, 110, 125, 150, 175, 200] as const;
export const DEFAULT_ZOOM = 100;

/** One step up or down from `current` (any number: an off-step value goes to the next step in that direction). */
export function stepZoom(current: number, dir: "in" | "out"): number {
  if (dir === "in") return ZOOM_LEVELS.find((l) => l > current) ?? ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return [...ZOOM_LEVELS].reverse().find((l) => l < current) ?? ZOOM_LEVELS[0];
}

/** The nearest step (what Rust saves); nonsense, 0 included, becomes 100. */
export function snapZoom(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ZOOM;
  return ZOOM_LEVELS.reduce((best, l) => (Math.abs(l - n) < Math.abs(best - n) ? l : best), DEFAULT_ZOOM as number);
}

/** What a key press asks of the zoom, if anything: Ctrl/Cmd with plus, minus or zero (number pad too). */
export function zoomKeyAction(e: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey">, platform: Platform): "in" | "out" | "reset" | null {
  const mod = platform === "macos" ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return null;
  if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") return "in";
  if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Numpad0") return "reset";
  return null;
}

/** Text size and zoom on <html>: the CSS reads `data-text` and `--zoom`. Cheap, so it runs before the first paint. */
export function applyDisplay(s: Pick<Settings, "textSize" | "zoomPercent">, root: HTMLElement = document.documentElement): void {
  applyTextSize(s.textSize, root);
  applyZoomVar(s.zoomPercent, root);
}

export function applyTextSize(size: TextSize | undefined, root: HTMLElement = document.documentElement): void {
  if (size === "larger") root.dataset.text = "larger";
  else delete root.dataset.text;
}

/** The zoom the webview has, so the window's minimum size (in CSS px) can follow it. */
export function applyZoomVar(percent: number | undefined, root: HTMLElement = document.documentElement): void {
  const p = percent && Number.isFinite(percent) ? percent : DEFAULT_ZOOM;
  root.style.setProperty("--zoom", String(p / 100));
}
