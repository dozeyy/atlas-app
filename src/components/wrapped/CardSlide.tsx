import { useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { DownloadSimple } from "@phosphor-icons/react";
import { getBackend } from "../../lib/ipc";
import { cardBytes, drawShareCard, loadCardFonts } from "../../lib/shareCard";
import type { ShareCard, Slide } from "../../lib/wrappedModel";
import type { PosterSpec } from "../../lib/wrappedPoster";
import { ClockProvider, useClockCtx, useTick } from "./clock";
import { beatValue, put, useEl } from "./heroKit";
import { Field, useFit } from "./Poster";

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved"; path: string }
  | { kind: "error"; text: string };

function describe(card: ShareCard): string {
  const tiles = card.tiles.map((t) => `${t.label} ${t.value}`).join(", ");
  return `${card.title}: ${card.tokens} ${card.unit}, ${card.days}${tiles ? `. ${tiles}` : ""}.`;
}

/** The picture pops in on the poster's clock; the words under it arrive after. */
function Pop({
  card,
  canvas,
}: {
  card: ShareCard;
  canvas: RefObject<HTMLCanvasElement | null>;
}) {
  const ctx = useClockCtx();
  const pic = useEl();
  useTick((t) => {
    const p = beatValue(ctx, "hero", t);
    const s = 0.84 + 0.16 * p;
    put(pic.el.current, {
      sx: s,
      sy: s,
      y: (1 - p) * 40,
      o: Math.min(1, p * 4),
    });
  });
  return (
    <div ref={pic.ref} className="pr-card-pic">
      <canvas
        ref={canvas}
        role="img"
        aria-label={describe(card)}
        width={1200}
        height={675}
      />
    </div>
  );
}

function Rise({
  className,
  children,
}: {
  className: string;
  children: ReactNode;
}) {
  const ctx = useClockCtx();
  const el = useEl();
  useTick((t) => {
    const p = beatValue(ctx, "line", t);
    put(el.el.current, { y: (1 - p) * 20, o: p });
  });
  return (
    <div ref={el.ref} className={className}>
      {children}
    </div>
  );
}

/**
 * The last slide: the story on one poster card, drawn to a canvas, and a button that saves that same
 * canvas as a PNG through a picker that starts in Pictures. The note under it is the honest coverage line.
 */
export function CardPoster({
  slide,
  spec,
  frozen = false,
  paused = false,
  delay = 0,
  onFrame,
}: {
  slide: Slide;
  spec: PosterSpec;
  frozen?: boolean;
  paused?: boolean;
  delay?: number;
  onFrame?: (t: number) => void;
}) {
  const card = slide.card as ShareCard;
  const root = useRef<HTMLDivElement>(null);
  useFit(root);
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
      const path = await getBackend().wrappedSaveCard(
        await cardBytes(el),
        card.day,
      );
      setStatus(path ? { kind: "saved", path } : { kind: "idle" });
    } catch (e) {
      setStatus({
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div
      ref={root}
      className="pr"
      data-pair={spec.pair}
      data-layout="card"
      data-mood="snappy"
      data-slide={slide.id}
      data-frozen={frozen ? "" : undefined}
    >
      <ClockProvider
        mood="snappy"
        delay={delay}
        frozen={frozen}
        paused={paused}
        onFrame={onFrame}
        runRef={root}
      >
        <Field spec={spec} id={slide.id} />
        <div className="pr-cardwrap">
          <Pop card={card} canvas={canvas} />
          <Rise className="pr-card-foot">
            <p
              className="pr-card-note"
              title={slide.hint}
              tabIndex={slide.hint ? 0 : undefined}
            >
              {slide.line}
            </p>
            <div className="pr-card-save">
              <span
                role="status"
                className="pr-card-status"
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
              <button
                type="button"
                className="pr-save"
                onClick={() => void save()}
                disabled={status.kind === "busy" || !drawn}
              >
                <DownloadSimple size={16} weight="bold" aria-hidden="true" />
                Save image
              </button>
            </div>
          </Rise>
        </div>
        <div className="pr-grain" aria-hidden="true" />
      </ClockProvider>
    </div>
  );
}
