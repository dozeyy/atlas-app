import { useLayoutEffect, useRef, useState } from "react";
import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import { dismissToast, useToasts, type Toast } from "../state/toastStore";
import { liftOver, type Box } from "../lib/toastPlace";

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
      data-action={act ? "" : undefined}
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

/** A window this short has room for one toast, not a pile. */
const SHORT = "(max-height: 719px)";
/** A sheet or a dialog: every one of them is put straight into <body> (index.css). */
const MODAL = "body > .fixed.inset-0";
/** What a toast must never lie over in a sheet or dialog. Text being read or edited is not in it. */
const CONTROLS =
  'button, a[href], input, select, summary, [role="button"], [role="tab"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"]';

function openModal(): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(MODAL);
  return all.length > 0 ? all[all.length - 1] : null;
}

/**
 * True while the pile folds to its newest toast: in a short window, and whenever a sheet or a
 * dialog is open (a pile there would hide half the sheet). Only watched while a toast is up.
 */
function useFold(active: boolean): { fold: boolean; layers: number } {
  const [short, setShort] = useState(false);
  const [layers, setLayers] = useState(0);
  useLayoutEffect(() => {
    if (!active) return;
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(SHORT) : null;
    const read = () => {
      setShort(mq?.matches ?? false);
      setLayers(document.querySelectorAll(MODAL).length);
    };
    read();
    mq?.addEventListener("change", read);
    const seen = new MutationObserver(read);
    seen.observe(document.body, { childList: true });
    return () => {
      mq?.removeEventListener("change", read);
      seen.disconnect();
    };
  }, [active]);
  return { fold: active && (short || layers > 0), layers: active ? layers : 0 };
}

/** Where the pile's cards are, as one box. */
function pileBox(host: HTMLElement): Box | null {
  let box: Box | null = null;
  for (const card of host.children) {
    const r = card.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    box = box
      ? { left: Math.min(box.left, r.left), right: Math.max(box.right, r.right), top: Math.min(box.top, r.top), bottom: Math.max(box.bottom, r.bottom) }
      : { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  }
  return box;
}

/**
 * Mounted once in App. Sits above the page, the sheets and the dialogs, and never over a button:
 * - No sheet open: the toasts centre in the page pane and the pane ends above them (--toast-room,
 *   `.page-pane` in trail.css).
 * - A side sheet open: it sets --toast-inset (the width it leaves free), so the toasts centre inside
 *   the sheet. There, and over a dialog, the pile rises until it covers none of the sheet's buttons
 *   or fields (--toast-lift, lib/toastPlace.ts). The sheet itself does not move: Save stays under
 *   the pointer that just pressed it, and Cancel stays in reach, at any window size.
 * In a short window, or with a sheet or dialog open, the pile folds to its newest toast (trail.css),
 * so it takes one row; a toast that carries an action (Undo) is never folded away.
 */
export function ToastHost() {
  const toasts = useToasts();
  const host = useRef<HTMLDivElement>(null);
  const { fold, layers } = useFold(toasts.length > 0);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const el = host.current;
    if (!el || toasts.length === 0) return;
    const modal = openModal();
    let lift = 0;
    const place = (first = false) => {
      // Resting the pointer on a folded pile fans it out; nothing moves or is measured again for that.
      if (!first && el.matches(":hover, :focus-within")) return;
      const h = el.offsetHeight;
      // A sheet covers the page: there the toast rises over the sheet's buttons, the page stays as it is.
      const inSheet = root.style.getPropertyValue("--toast-inset") !== "";
      if (h === 0 || inSheet) root.style.removeProperty("--toast-room");
      // The pane ends where the toasts begin (they sit 20 px off the bottom); the page's own bottom gutter is the gap.
      else root.style.setProperty("--toast-room", `${h + 20}px`);
      const rest = modal ? pileBox(el) : null;
      let next = 0;
      if (modal && rest) {
        const controls = Array.from(modal.querySelectorAll<HTMLElement>(CONTROLS), (c) => c.getBoundingClientRect());
        next = liftOver({ ...rest, top: rest.top + lift, bottom: rest.bottom + lift }, controls, modal.getBoundingClientRect().top);
      }
      if (next === lift) return;
      lift = next;
      if (lift > 0) el.style.setProperty("--toast-lift", `${Math.round(lift)}px`);
      else el.style.removeProperty("--toast-lift");
    };
    place(true);
    // A message that wraps, a pile that folds, a window that is resized, a sheet that scrolls or
    // changes what it shows: the pile is placed again, once per frame at most.
    let frame = 0;
    const again = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    const sized = typeof ResizeObserver === "function" ? new ResizeObserver(again) : null;
    sized?.observe(el);
    const changed = modal ? new MutationObserver(again) : null;
    if (modal) changed?.observe(modal, { childList: true, subtree: true });
    window.addEventListener("resize", again);
    modal?.addEventListener("scroll", again, true);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      sized?.disconnect();
      changed?.disconnect();
      window.removeEventListener("resize", again);
      modal?.removeEventListener("scroll", again, true);
      root.style.removeProperty("--toast-room");
      el.style.removeProperty("--toast-lift");
    };
  }, [toasts, fold, layers]);
  return (
    <div ref={host} aria-live="polite" className="toast-host" data-fold={fold ? "" : undefined}>
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}

