import { useEffect, useRef, useState } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { Button } from "../controls";
import { getBackend } from "../../lib/ipc";
import { cardBytes, drawShareCard, loadCardFonts } from "../../lib/shareCard";
import type { ShareCard } from "../../lib/wrappedModel";

type Status = { kind: "idle" } | { kind: "busy" } | { kind: "saved"; path: string } | { kind: "error"; text: string };

function describe(card: ShareCard): string {
  const tiles = card.tiles.map((t) => `${t.label} ${t.value}`).join(", ");
  return `${card.title}: ${card.tokens} ${card.unit}, ${card.days}${tiles ? `. ${tiles}` : ""}.`;
}

/**
 * The last slide: the story on one card, drawn to a canvas, and a button that saves that same
 * canvas as a PNG through a picker that starts in Pictures. `note` is the honest coverage line.
 */
export function CardSlide({ card, note, noteHint }: { card: ShareCard; note: string; noteHint?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [drawn, setDrawn] = useState(true);

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
  }, [card]);

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
    <div className="wr-card">
      <canvas ref={canvas} className="wr-card-pic" role="img" aria-label={describe(card)} width={1200} height={675} />
      <div className="wr-card-foot">
        <p className="wr-card-note" title={noteHint} tabIndex={noteHint ? 0 : undefined}>
          {note}
        </p>
        <div className="wr-card-save">
          <span
            role="status"
            className="wr-card-status"
            data-bad={status.kind === "error" ? "" : undefined}
            title={status.kind === "saved" ? status.path : undefined}
          >
            {status.kind === "saved" ? `Saved to ${status.path}` : status.kind === "error" ? status.text : !drawn ? "The picture could not be drawn." : ""}
          </span>
          <Button variant="primary" onClick={() => void save()} disabled={status.kind === "busy" || !drawn}>
            <DownloadSimple size={14} aria-hidden="true" />
            Save image
          </Button>
        </div>
      </div>
    </div>
  );
}
