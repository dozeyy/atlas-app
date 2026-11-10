import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { getBackend } from "../../lib/ipc";
import { CARD_H, CARD_W, cardBytes, drawShareCard, loadCardFonts } from "../../lib/shareCard";
import type { ShareCard, Slide } from "../../lib/wrappedModel";

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved"; path: string }
  | { kind: "error"; text: string };

function describe(card: ShareCard): string {
  const facts = card.facts.map((f) => `${f.value} ${f.label}`).join(", ");
  return `${card.title}, ${card.range}: ${card.tokens} ${card.unit}${facts ? `. ${facts}` : ""}.`;
}

/** Calls `onChange` when the theme under the card changes: the card is drawn from the live tokens. */
function useThemeChange(onChange: () => void, on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const root = document.documentElement;
    const seen = new MutationObserver(onChange);
    seen.observe(root, { attributes: true, attributeFilter: ["data-theme", "class"] });
    let mq: MediaQueryList | undefined;
    try {
      mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener?.("change", onChange);
    } catch {
      /* no media queries here */
    }
    return () => {
      seen.disconnect();
      mq?.removeEventListener?.("change", onChange);
    };
  }, [onChange, on]);
}

/** The card on the sheet, as the action row under it needs it: its canvas, and whether it drew. */
export interface CardOnSheet {
  canvas: HTMLCanvasElement;
  drawn: boolean;
}

/** How the card tells the story it is on the sheet (null when it has left). Story.tsx provides it. */
export const CardPortContext = createContext<((card: CardOnSheet | null) => void) | null>(null);

/**
 * The last slide: the story on one card, drawn to a canvas, alone on the sheet and as large as the
 * sheet allows. The picture, the preview and the saved file are one canvas; Save image is the story's
 * own primary button, in the row under the sheet (useCardSave).
 */
export function CardView({ slide, settled }: { slide: Slide; settled: boolean }) {
  const card = slide.card as ShareCard;
  const canvas = useRef<HTMLCanvasElement>(null);
  const port = useContext(CardPortContext);
  const [redraw, setRedraw] = useState(0);

  // The slide that is leaving (settled) is a still picture for its short fade: drawn once, not watched.
  const again = useCallback(() => setRedraw((n) => n + 1), []);
  useThemeChange(again, !settled);

  useEffect(() => {
    let live = true;
    const paint = () => {
      const el = canvas.current;
      if (!el || !live) return;
      const drawn = drawShareCard(el, card);
      if (!settled) port?.({ canvas: el, drawn });
    };
    paint();
    if (!settled) void loadCardFonts().then(paint);
    return () => {
      live = false;
    };
  }, [card, redraw, settled, port]);

  // Gone from the sheet: nothing left to save.
  useEffect(() => {
    if (settled || !port) return;
    return () => port(null);
  }, [settled, port]);

  return (
    <div className="sm-frame" data-slide={slide.id} data-layout="card" data-settled={settled ? "" : undefined}>
      <div className="sm-cardwrap">
        <canvas ref={canvas} className="sm-card" role="img" aria-label={describe(card)} width={CARD_W} height={CARD_H} />
      </div>
    </div>
  );
}

/** The folder a file is in and its name: enough to find it, short enough to read at a glance. */
export function nearPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return path;
  return parts.slice(-2).join(path.includes("\\") ? "\\" : "/");
}

/** Save image, as the row under the sheet shows it. */
export interface CardSave {
  save: () => void;
  /** The card has drawn and no save is running. */
  ready: boolean;
  /** Where the picture went (its folder and name), or why it did not. Empty until there is something to say. */
  note: string;
  bad: boolean;
  /** The saved file's whole path, for the note's hover. */
  path?: string;
}

/**
 * Save image, for the row under the sheet: saves the canvas on the sheet as a PNG through a picker
 * that starts in Pictures. A cancelled picker leaves no message behind.
 */
export function useCardSave(card: ShareCard | undefined, on: CardOnSheet | null): CardSave {
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const canvas = on?.canvas ?? null;

  // A fresh visit to the card starts with a clean line.
  useEffect(() => setStatus({ kind: "idle" }), [canvas]);

  const save = () => {
    if (!card || !canvas || status.kind === "busy") return;
    setStatus({ kind: "busy" });
    void (async () => {
      try {
        const path = await getBackend().wrappedSaveCard(await cardBytes(canvas), card.day);
        setStatus(path ? { kind: "saved", path } : { kind: "idle" });
      } catch (e) {
        setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
      }
    })();
  };

  const undrawn = !!on && !on.drawn;
  return {
    save,
    ready: !!on && on.drawn && status.kind !== "busy",
    note:
      status.kind === "saved"
        ? `Saved to ${nearPath(status.path)}`
        : status.kind === "error"
          ? status.text
          : undrawn
            ? "The picture could not be drawn."
            : "",
    bad: status.kind === "error" || undrawn,
    path: status.kind === "saved" ? status.path : undefined,
  };
}
