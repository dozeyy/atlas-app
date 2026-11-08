import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * A centred modal: scrim, focus kept inside, Escape closes, focus goes back to
 * where it was. Every key is stopped from reaching a sheet behind it.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
  alert = false,
  width = 460,
  closeOnScrim = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** An alertdialog for questions that need an answer (delete, discard). */
  alert?: boolean;
  width?: number;
  closeOnScrim?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    // An element that asked for focus (autoFocus) keeps it; else the first input, else the panel.
    if (panel.current?.contains(document.activeElement)) return () => before?.focus?.({ preventScroll: true });
    const first = panel.current?.querySelector<HTMLElement>("input, textarea, select");
    (first ?? panel.current)?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const f = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute("disabled"));
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onKeyDown={onKey}>
      <div aria-hidden="true" onClick={closeOnScrim ? onClose : undefined} className="fade-in absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={panel}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width: `min(${width}px, 100%)` }}
        className="pop-enter relative flex max-h-[min(720px,100%)] flex-col rounded-sheet border border-line-strong bg-bg shadow-float outline-none"
      >
        <h2 id={titleId} className="selectable break-words px-6 pt-5 text-subtitle font-semibold text-ink">
          {title}
        </h2>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3 text-body text-ink-2">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 px-6 pb-5 pt-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
