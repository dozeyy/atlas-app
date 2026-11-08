import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, SlidersHorizontal } from "@phosphor-icons/react";
import { Button } from "./controls";

/**
 * One compact icon button that opens a small panel under it: a screen's filters, its sort order,
 * its view. A count badge shows how many options differ from their defaults. Escape or a click
 * outside closes it and focus goes back to the button. Nothing here is a menu of commands: the
 * panel is a form (or a short list of choices), so Tab moves through it like anywhere else.
 *
 * A screen can have several (Sessions has Filter and Sort); each is its own button and panel.
 * `children` may be a function that receives `close`, for a panel that picks one value and is done.
 */
export function OptionsMenu({
  label = "Filters",
  icon,
  status,
  count = 0,
  onReset,
  children,
  width = 300,
}: {
  label?: string;
  /** The button's icon, 16px. Defaults to sliders. */
  icon?: ReactNode;
  /** The current setting in words, read out after the label ("Sort, Newest first"). */
  status?: string;
  /** How many options differ from their defaults. Shown as a badge; 0 hides it. */
  count?: number;
  /** Puts every option back to its default. The panel offers it only while count > 0. */
  onReset?: () => void;
  children: ReactNode | ((close: () => void) => ReactNode);
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open, close]);

  const spoken = [label, status, count > 0 ? `${count} changed` : ""].filter(Boolean).join(", ");

  return (
    <div ref={root} className="relative shrink-0">
      <Button
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={spoken}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className="options-trigger"
      >
        {icon ?? <SlidersHorizontal size={16} aria-hidden="true" />}
        {count > 0 && (
          <span aria-hidden="true" className="options-badge">
            {count}
          </span>
        )}
      </Button>
      {open && (
        <div id={panelId} role="dialog" aria-label={label} className="options-panel" style={{ width }}>
          <div className="flex flex-col gap-3.5">{typeof children === "function" ? children(close) : children}</div>
          {onReset && count > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <Button onClick={onReset}>Reset</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A captioned option inside the panel. */
export function OptionField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-caption font-medium text-ink-2">{label}</span>
      {children}
    </div>
  );
}

/**
 * One choice out of a short list, inside an OptionsMenu panel. The chosen one is bold with a
 * check; the rest are plain. Picking calls `onChange`, then `onPick` (usually the panel's close).
 */
export function ChoiceList<T extends string>({
  label,
  value,
  choices,
  onChange,
  onPick,
}: {
  label: string;
  value: T;
  choices: { value: T; label: string }[];
  onChange: (v: T) => void;
  onPick?: () => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="-mx-2 -my-1 flex flex-col">
      {choices.map((c) => {
        const on = c.value === value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              onChange(c.value);
              onPick?.();
            }}
            className={`row-btn items-center justify-between gap-3 rounded-control px-2 py-1.5 text-body ${on ? "font-semibold text-ink" : "text-ink-2"}`}
          >
            {c.label}
            {on && <Check size={14} weight="bold" aria-hidden="true" className="text-accent-text" />}
          </button>
        );
      })}
    </div>
  );
}
