import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { MapGlyph } from "./MapGlyph";
import { useIntro } from "../../lib/motion";
import { layoutMap, MAIN_ID, pathTo, placePlate, ROOT_R, zoomFor, type MapNode, type Metric } from "../../lib/helperMap";
import { FAMILIES, FAMILY_NAME, modelFamily, type ModelFamily } from "../../lib/modelFamily";
import { compact } from "../../lib/usage";
import type { Outcome, Receipt } from "../../lib/types";

/** Nodes are sized (and the crowd folded) by tokens, the unit the app leads with. */
export const MAP_BY: Metric = "tokens";

/** Size used before the first measure, and in jsdom where nothing has a size. */
const FALLBACK = { width: 640, height: 400 };

function useSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const width = Math.round(el.clientWidth);
      const height = Math.round(el.clientHeight);
      if (width > 0 && height > 0) setSize((p) => (p.width === width && p.height === height ? p : { width, height }));
    };
    read();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size.width > 0 ? size : FALLBACK];
}

export const OUTCOME_LABEL: Record<Outcome, string> = { finished: "Finished", errored: "Errored", stopped: "Stopped" };

/** The colour a node wears: how the helper ended where the transcript says, else neutral. */
export function outcomeColor(n: Pick<MapNode, "kind" | "outcome">): string {
  if (n.kind === "root") return "var(--accent)";
  if (n.kind === "more") return "var(--line-strong)";
  if (n.outcome === "finished") return "var(--success)";
  if (n.outcome === "errored") return "var(--danger)";
  if (n.outcome === "stopped") return "var(--warning)";
  return "var(--slate)";
}

/** The one line under a name: the node's tokens and how it ended. */
export function nodeDetail(n: MapNode): string {
  const tokens = `${compact(n.tokens)} tokens`;
  if (n.kind === "more") return tokens;
  return n.outcome ? `${tokens}, ${OUTCOME_LABEL[n.outcome].toLowerCase()}` : tokens;
}

const glyphOf = (n: MapNode): ModelFamily | "chat" => (n.kind === "root" ? "chat" : modelFamily(n.thread?.model));

/**
 * The helper map: the main chat in the middle, each helper hanging from the thread that started
 * it. A bubble wears its model's icon and the colour of how it ended; its size follows its
 * tokens. Names show only on a plate when a bubble is pointed at or focused, placed where it
 * covers no other bubble. A big tree grows past the pane and the pane scrolls.
 */
export function HelperMap({
  receipt,
  sessionId,
  selected,
  onSelect,
}: {
  receipt: Receipt;
  sessionId: string;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const intro = useIntro(`map:${sessionId}`);
  const [box, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => layoutMap(receipt.threads, size, undefined, MAP_BY), [receipt.threads, size]);

  // A tree bigger than the pane is shown a little smaller (names and plates stay full size).
  const zoom = useMemo(() => zoomFor(layout, size), [layout, size]);
  const lit = useMemo(() => pathTo(layout, hover ?? selected ?? MAIN_ID), [layout, hover, selected]);
  const present = new Set(layout.nodes.map((n) => n.outcome).filter((o): o is Outcome => o !== null));
  const families = FAMILIES.filter((f) => layout.nodes.some((n) => n.kind === "helper" && modelFamily(n.thread?.model) === f));

  const plateNode = hover ? layout.nodes.find((n) => n.id === hover) : undefined;
  const plate = useMemo(() => {
    if (!plateNode) return null;
    // What the pane shows right now, so the plate lands where it can be read.
    const el = box.current;
    const view = el ? { x: el.scrollLeft / zoom, y: el.scrollTop / zoom, w: el.clientWidth / zoom, h: el.clientHeight / zoom } : undefined;
    return placePlate(layout, plateNode.id, nodeDetail(plateNode), view, zoom);
  }, [layout, plateNode, box, zoom]);

  // Open on the main chat, in the middle of a canvas that is bigger than the pane.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.scrollLeft = Math.max(0, (layout.width * zoom - el.clientWidth) / 2);
    el.scrollTop = Math.max(0, (layout.height * zoom - el.clientHeight) / 2);
    // Only when the picture itself changes size: scrolling about must not be undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.width, layout.height, zoom, sessionId]);

  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div className="map-shell">
      <div ref={box} className="map-scroll">
        <div className={`chart-wrap map${intro ? " intro" : ""}${hover ? " has-focus" : ""}`} style={{ width: layout.width * zoom, height: layout.height * zoom }}>
          <svg
            className="chart"
            width={layout.width * zoom}
            height={layout.height * zoom}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
            role="group"
            aria-label={`Helper map: the main chat and ${layout.nodes.length - 1} ${layout.nodes.length === 2 ? "helper" : "helpers"}`}
          >
            <g aria-hidden="true">
              {layout.links.map((l, i) => (
                <path
                  key={l.id}
                  d={l.d}
                  pathLength={1}
                  className={`map-link${lit.has(l.from) && lit.has(l.to) ? " on" : ""}`}
                  style={{ ["--i" as string]: i }}
                />
              ))}
            </g>
            {layout.nodes.map((n) => {
              const kind = n.kind === "more" ? null : glyphOf(n);
              const glyphSize = n.kind === "root" ? 30 : Math.round(Math.min(26, n.r * 1.15));
              return (
                <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
                  <g
                    className={`map-node${n.id === selected ? " sel" : ""}${lit.has(n.id) ? " on" : ""}${n.kind === "more" ? " more" : ""}${n.kind === "root" ? " root" : ""}`}
                    style={{ ["--i" as string]: n.index, ["--c" as string]: outcomeColor(n) }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={n.id === selected}
                    aria-label={`${n.name}, ${nodeDetail(n)}`}
                    onClick={() => onSelect(n.id)}
                    onKeyDown={(e) => onKey(e, n.id)}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                    onFocus={() => setHover(n.id)}
                    onBlur={() => setHover((h) => (h === n.id ? null : h))}
                  >
                    <circle className="map-hit" r={n.r + 8} />
                    <circle className="map-ring" r={n.r + 6} />
                    <g className="map-body">
                      <circle className="map-dot" r={n.r} />
                      {kind ? (
                        <MapGlyph kind={kind} size={glyphSize} />
                      ) : (
                        <text className="map-plus" textAnchor="middle" dominantBaseline="central">
                          {`+${n.hidden.length}`}
                        </text>
                      )}
                    </g>
                    {n.kind === "root" && (
                      <text className="map-name" transform={`translate(0 ${ROOT_R + 28}) scale(${1 / zoom})`} textAnchor="middle">
                        Main chat
                      </text>
                    )}
                  </g>
                </g>
              );
            })}
            {plate && (
              <g className="map-plate" transform={`translate(${plate.x} ${plate.y}) scale(${1 / zoom})`} aria-hidden="true">
                <rect width={plate.w * zoom} height={plate.h * zoom} rx={8} />
                {plate.lines.map((line, i) => (
                  <text key={i} className="map-plate-name" x={10} y={8 + 12 + i * 16}>
                    {line}
                  </text>
                ))}
                <text className="map-plate-detail" x={10} y={8 + 12 + plate.lines.length * 16 + 2}>
                  {plate.detail}
                </text>
              </g>
            )}
          </svg>
        </div>
      </div>
      <ul className="map-legend" aria-label="What the icons and colours mean">
        {families.map((f) => (
          <li key={f}>
            <svg width={16} height={16} viewBox="-8 -8 16 16" aria-hidden="true" className="map-legend-glyph">
              <MapGlyph kind={f} size={14} />
            </svg>
            {FAMILY_NAME[f]}
          </li>
        ))}
        {(["finished", "errored", "stopped"] as Outcome[])
          .filter((o) => present.has(o))
          .map((o) => (
            <li key={o}>
              <i aria-hidden="true" style={{ background: outcomeColor({ kind: "helper", outcome: o }) }} />
              {OUTCOME_LABEL[o]}
            </li>
          ))}
      </ul>
    </div>
  );
}
