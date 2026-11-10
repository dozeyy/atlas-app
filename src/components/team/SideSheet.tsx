import { useEffect, useId, useRef } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "@phosphor-icons/react";

/**
 * A calm side sheet (no spring, no count-up, no spark): scrim, panel, focus moves in and back to
 * what opened it, Escape closes from anywhere, Tab stays inside, and toasts centre inside the
 * panel while it is open. The Toolkit's item sheet does the same; this one holds the Team tab's
 * two sheets (one helper type, and "Make this a rule").
 */
export function SideSheet({
  title,
  subtitle,
  lead,
  onClose,
  children,
  footer,
  width = 640,
}: {
  title: string;
  subtitle?: ReactNode;
  /** A picture for what the sheet is about (a helper's avatar), left of the title. */
  lead?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--toast-inset", `calc(var(--app-w) - min(${width}px, var(--app-w)))`);
    return () => {
      root.style.removeProperty("--toast-inset");
    };
  }, [width]);

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onWindowKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (panel.current?.contains(document.activeElement)) return;
      if (document.querySelectorAll('[aria-modal="true"]').length > 1) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, []);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const f = Array.from(panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
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
    <div className="fixed inset-0 z-50 flex justify-end">
      <div aria-hidden="true" onClick={onClose} className="fade-in absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        data-allow-jump=""
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKey}
        style={{ width: `min(${width}px, var(--app-w))` }}
        className="sheet-enter relative flex h-full flex-col overflow-y-auto border-l border-line bg-bg shadow-float outline-none"
      >
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-line bg-bg px-6 py-4">
          {lead}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="selectable break-words text-subtitle font-semibold text-ink">
              {title}
            </h2>
            {subtitle && <div className="mt-1 break-words text-body text-ink-2">{subtitle}</div>}
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="press flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="flex-1">{children}</div>
        {footer && <footer className="sticky bottom-0 border-t border-line bg-bg px-6 py-3">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** One titled block inside a sheet. */
export function SheetSection({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line px-6 py-4 last:border-b-0">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <h3 className="text-body font-semibold text-ink">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}
