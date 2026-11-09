import { useSyncExternalStore } from "react";
import type { KeyboardEvent } from "react";
import { resolveTheme } from "../lib/theme";
import type { Platform, Theme } from "../lib/types";
import { Row, Toggle } from "./controls";

type Pinned = "light" | "silver" | "dark";

const CHOICES: { value: Pinned; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "silver", label: "Silver" },
  { value: "dark", label: "Dark" },
];

function subscribeOs(cb: () => void) {
  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", cb);
    return () => mq.removeEventListener?.("change", cb);
  } catch {
    return () => {};
  }
}

/** The theme on screen, kept current when the OS flips while Atlas follows it. */
export function useResolvedTheme(theme: Theme): Pinned {
  return useSyncExternalStore(
    subscribeOs,
    () => resolveTheme(theme),
    () => "light",
  );
}

/** "Match Windows" / "Match macOS" / "Match system". */
export function matchLabel(platform: Platform): string {
  return platform === "windows" ? "Match Windows" : platform === "macos" ? "Match macOS" : "Match system";
}

/** A tiny Atlas window drawn in the theme's own tokens, whatever theme the page is in. */
function Preview({ theme }: { theme: Pinned }) {
  return (
    <span className="theme-preview" data-theme={theme} aria-hidden="true">
      <span className="tp-side">
        <span className="tp-dot" />
        <span className="tp-pill tp-pill-on" />
        <span className="tp-pill" />
        <span className="tp-pill" />
      </span>
      <span className="tp-main">
        <span className="tp-title" />
        <span className="tp-card">
          <span className="tp-line" />
          <span className="tp-bars">
            {[38, 62, 30, 78, 52, 90, 66].map((h, i) => (
              <span key={i} className={`tp-bar${i === 6 ? " tp-bar-now" : ""}`} style={{ height: `${h}%` }} />
            ))}
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * Light, Silver and Dark as three preview cards, plus one "Match <OS>" switch. A card is
 * a radio; picking one pins that theme and turns Match off. Match on means Atlas follows
 * the OS (Light by day, Dark at night) and the card for what is showing stays marked.
 */
export function ThemePicker({
  theme,
  platform,
  onChange,
}: {
  theme: Theme;
  platform: Platform;
  onChange: (t: Theme) => void;
}) {
  const showing = useResolvedTheme(theme);
  const following = theme === "system";

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const at = CHOICES.findIndex((c) => c.value === showing);
    const next = CHOICES[(at + step + CHOICES.length) % CHOICES.length];
    onChange(next.value);
    requestAnimationFrame(() =>
      (e.currentTarget.querySelector(`[data-value="${next.value}"]`) as HTMLElement | null)?.focus(),
    );
  }

  return (
    <>
      <div className="px-5 pb-1 pt-5">
        <div role="radiogroup" aria-label="Theme" onKeyDown={onKey} className="theme-grid">
          {CHOICES.map((c) => {
            const on = c.value === showing;
            return (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={c.label}
                data-value={c.value}
                tabIndex={on ? 0 : -1}
                onClick={() => onChange(c.value)}
                className="card-hit theme-card hover-host"
              >
                <span className="card-face theme-card-face">
                  <Preview theme={c.value} />
                  <span className="theme-card-label">
                    <span className="text-body font-semibold text-ink">{c.label}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
      <Row
        label={matchLabel(platform)}
        hint={following ? `Showing ${showing}` : undefined}
      >
        <Toggle
          label={matchLabel(platform)}
          checked={following}
          onChange={(on) => onChange(on ? "system" : showing)}
        />
      </Row>
    </>
  );
}
