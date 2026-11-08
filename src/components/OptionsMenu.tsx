import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { SlidersHorizontal } from "@phosphor-icons/react";
import { Button } from "./controls";

/**
 * One compact button that holds a screen's option controls (filters, sort, view): a sliders icon
 * with a count badge when something is changed, opening a small panel under it. Escape or a click
 * outside closes it and focus goes back to the button. Nothing here is a menu of commands: the
 * panel is a form, so Tab moves through its fields like anywhere else.
 */
export function OptionsMenu({
  label = "Filters",
  count = 0,
  onReset,
  children,
  width = 300,
}: {
  label?: string;
  /** How many options differ from their defaults. Shown as a badge; 0 hides it. */
  count?: number;
  /** Puts every option back to its default. The panel offers it only while count > 0. */
  onReset?: () => void;
  children: ReactNode;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0">
      <Button
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={count > 0 ? `${label}, ${count} changed` : label}
        title={label}
        onClick={() => setOpen((v) => !v)}
        className="options-trigger"
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
        {count > 0 && (
          <span aria-hidden="true" className="options-badge">
            {count}
          </span>
        )}
      </Button>
      {open && (
        <div id={panelId} role="dialog" aria-label={label} className="options-panel" style={{ width }}>
          <div className="flex flex-col gap-3.5">{children}</div>
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
