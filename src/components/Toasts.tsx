import { useLayoutEffect, useRef, useState } from "react";
import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import { dismissToast, useToasts, type Toast } from "../state/toastStore";

const ICON = { info: Info, success: CheckCircle, error: WarningCircle } as const;
const TONE = { info: "text-ink-2", success: "text-success", error: "text-danger" } as const;

function ToastCard({ toast }: { toast: Toast }) {
  const [busy, setBusy] = useState(false);
  const Icon = ICON[toast.tone];
  const act = toast.action;
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className="toast-card fade-in"
    >
      <Icon size={18} weight="fill" aria-hidden="true" className={`shrink-0 ${TONE[toast.tone]}`} />
      <p className="selectable min-w-0 flex-1 text-body text-ink">{toast.message}</p>
      {act && (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await act.onClick();
            } finally {
              dismissToast(toast.id);
            }
          }}
          className="press h-8 shrink-0 cursor-pointer rounded-control px-3 text-body hover:bg-accent-tint disabled:cursor-wait disabled:opacity-60"
        >
          {/* On a span: a colour or weight set on the button itself loses to the page's button reset. */}
          <span className="font-semibold text-accent-text">{act.label}</span>
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => dismissToast(toast.id)}
        className="press flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
      >
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Mounted once in App. Sits above the page and the detail sheet. While a side sheet is open it
 * sets --toast-inset (the width the sheet leaves free), so toasts centre inside the sheet and
 * never straddle its edge. With no sheet open the toasts centre in the page pane, and the pane
 * ends above them (--toast-room, `.page-pane` in trail.css): a toast never covers a row or a button.
 * In a short window the pile folds to its newest toast (trail.css), so that room is one row.
 */
export function ToastHost() {
  const toasts = useToasts();
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const h = host.current?.offsetHeight ?? 0;
    // A sheet covers the page: there the toast lies over the sheet's own bottom edge, not the page.
    const inSheet = root.style.getPropertyValue("--toast-inset") !== "";
    if (toasts.length === 0 || h === 0 || inSheet) root.style.removeProperty("--toast-room");
    // The pane ends where the toasts begin (they sit 20 px off the bottom); the page's own bottom gutter is the gap.
    else root.style.setProperty("--toast-room", `${h + 20}px`);
    return () => {
      root.style.removeProperty("--toast-room");
    };
  }, [toasts]);
  return (
    <div ref={host} aria-live="polite" className="toast-host">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
