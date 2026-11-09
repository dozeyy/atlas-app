import { useEffect, useRef, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { getBackend } from "../../lib/ipc";
import { CARD_H, CARD_W, cardBytes, drawShareCard, loadCardFonts } from "../../lib/shareCard";
import type { ShareCard, Slide } from "../../lib/wrappedModel";
import { Button } from "../controls";

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
function useThemeChange(onChange: () => void): void {
  useEffect(() => {
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
  }, [onChange]);
}

/**
 * The last slide: the story on one card, drawn to a canvas, and a button that saves that same canvas
 * as a PNG through a picker that starts in Pictures. The picture, the preview and the saved file are
 * one canvas. The status line under the button says where it went, or why it did not.
 */
export function CardView({ slide, settled }: { slide: Slide; settled: boolean }) {
  const card = slide.card as ShareCard;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [drawn, setDrawn] = useState(true);
  const [redraw, setRedraw] = useState(0);

  useThemeChange(() => setRedraw((n) => n + 1));

  useEffect(() => {
    let live = true;
    const paint = () => {
      const el = canvas.current;
      if (el && live) setDrawn(drawShareCard(el, card));
    };
    paint();
    void loadCardFonts().then(paint);
    return () => {
      live = false;
    };
  }, [card, redraw]);

  const save = async () => {
    const el = canvas.current;
    if (!el || status.kind === "busy") return;
    setStatus({ kind: "busy" });
    try {
      const path = await getBackend().wrappedSaveCard(await cardBytes(el), card.day);
      setStatus(path ? { kind: "saved", path } : { kind: "idle" });
    } catch (e) {
      setStatus({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="sm-frame" data-slide={slide.id} data-layout="card" data-settled={settled ? "" : undefined}>
      <div className="sm-cardwrap">
        <canvas ref={canvas} className="sm-card" role="img" aria-label={describe(card)} width={CARD_W} height={CARD_H} />
        <div className="sm-card-save">
          <Button variant="primary" onClick={() => void save()} disabled={status.kind === "busy" || !drawn}>
            <DownloadSimple size={16} weight="bold" aria-hidden="true" />
            Save image
          </Button>
          <span
            role="status"
            className="sm-card-status"
            data-bad={status.kind === "error" ? "" : undefined}
            title={status.kind === "saved" ? status.path : undefined}
          >
            {status.kind === "saved"
              ? `Saved to ${status.path}`
              : status.kind === "error"
                ? status.text
                : !drawn
                  ? "The picture could not be drawn."
                  : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
