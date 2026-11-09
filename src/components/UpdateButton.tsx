import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DownloadSimple } from "@phosphor-icons/react";
import { Button } from "./controls";
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_MS,
  checkForUpdate,
  dismissUpdate,
  startInstall,
  useUpdate,
} from "../lib/updateStore";

const RING = 15; // radius in the 36 px box
const CIRC = 2 * Math.PI * RING;

/** The release notes as the quiet second paragraph of the tooltip: short, plain, one block. */
function noteLine(notes: string | null): string {
  if (!notes) return "";
  const flat = notes
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/[#*_`>]+/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return flat.length > 200 ? `${flat.slice(0, 197).trimEnd()}...` : flat;
}

/**
 * The update icon at the sidebar's bottom-left corner. Absent until a newer version is known
 * (and absent after "Later" until the next launch). It never opens by itself, except to say
 * that an install the person asked for failed. Checks run quietly: once a few seconds after the
 * first paint, then every six hours.
 */
export function UpdateButton() {
  const { state, dismissed } = useUpdate();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    const first = setTimeout(() => void checkForUpdate({ manual: false }), FIRST_CHECK_MS);
    const every = setInterval(() => void checkForUpdate({ manual: false }), CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);

  // A failed install says so, once, where the person is already looking.
  const kind = state.kind;
  useEffect(() => {
    if (kind === "failed") setOpen(true);
  }, [kind]);

  // The panel is drawn on the page, not inside the sidebar (which clips), so it is placed from
  // the button's own position: above it, on its left edge.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = button.current?.getBoundingClientRect();
      if (r) setAt({ left: Math.max(8, r.left), bottom: window.innerHeight - r.top + 8 });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, dismissed, kind]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      button.current?.focus({ preventScroll: true });
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);

  // Keyboard users land on the first choice when the panel appears (or changes to its failure).
  const placed = at !== null;
  useEffect(() => {
    if (open && placed) panel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, [open, placed, kind]);

  if (state.kind === "none" || dismissed) return null;
  const { info } = state;
  const working = state.kind === "downloading" || state.kind === "installing";
  const fraction = state.kind === "downloading" ? state.fraction : null;
  const pct = fraction === null ? null : Math.round(fraction * 100);

  const label =
    state.kind === "downloading"
      ? `Downloading ${info.version}${pct === null ? "" : `, ${pct}%`}`
      : state.kind === "installing"
        ? `Installing ${info.version}`
        : state.kind === "failed"
          ? `Update to ${info.version} did not finish`
          : `Update to ${info.version}`;
  const notes = state.kind === "available" ? noteLine(info.notes) : "";

  const later = () => {
    setOpen(false);
    dismissUpdate();
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="upd-btn"
        title={notes ? `${label}\n${notes}` : label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={state.kind}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="upd-face">
          {working && (
            <svg className={`upd-ring${fraction === null ? " upd-spin" : ""}`} viewBox="0 0 36 36" aria-hidden="true">
              <circle className="upd-track" cx="18" cy="18" r={RING} />
              <circle
                className="upd-arc"
                cx="18"
                cy="18"
                r={RING}
                strokeDasharray={fraction === null ? undefined : CIRC}
                strokeDashoffset={fraction === null ? undefined : CIRC * (1 - fraction)}
              />
            </svg>
          )}
          <DownloadSimple size={18} weight="bold" aria-hidden="true" />
        </span>
      </button>
      {open &&
        at &&
        createPortal(
          <div
            ref={panel}
            role="dialog"
            aria-label="Update"
            className="upd-pop"
            style={{ left: at.left, bottom: at.bottom }}
          >
            {state.kind === "available" && (
              <>
                <p className="upd-title">Atlas {info.version} is ready</p>
                <p className="upd-sub">You are on {info.current}. Atlas restarts when it is done.</p>
                <div className="upd-actions">
                  <Button variant="primary" onClick={() => void startInstall()}>
                    Update and restart
                  </Button>
                  <Button onClick={later}>Later</Button>
                </div>
              </>
            )}
            {working && (
              <>
                <p className="upd-title">{state.kind === "installing" ? `Installing ${info.version}` : `Downloading ${info.version}`}</p>
                <p className="upd-sub" role="status">
                  {state.kind === "installing" ? "Atlas restarts in a moment." : pct === null ? "Starting." : `${pct}%`}
                </p>
              </>
            )}
            {state.kind === "failed" && (
              <>
                <p className="upd-title">Atlas {info.version}</p>
                <p className="upd-sub upd-bad" role="alert">
                  {state.message}
                </p>
                <div className="upd-actions">
                  <Button variant="primary" onClick={() => void startInstall()}>
                    Try again
                  </Button>
                  <Button onClick={later}>Later</Button>
                </div>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
