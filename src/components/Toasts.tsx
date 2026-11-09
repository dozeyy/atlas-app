import { useState } from "react";
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
      className="fade-in pointer-events-auto flex max-w-[min(520px,calc(var(--app-w)-32px))] items-center gap-3 rounded-card border border-line-strong bg-surface py-2.5 pl-4 pr-2 shadow-float"
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
          className="press h-8 shrink-0 cursor-pointer rounded-control px-3 text-body font-semibold text-accent-text hover:bg-accent-tint disabled:cursor-wait disabled:opacity-60"
        >
          {act.label}
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
 * never straddle its edge.
 */
export function ToastHost() {
  const toasts = useToasts();
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-5 left-[var(--toast-inset,0px)] right-0 z-[70] flex flex-col items-center gap-2 px-4">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
