import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { useIntro } from "../../lib/motion";
import { layoutMap, MAIN_ID, pathTo, placePlate, restLabels, ROOT_R, zoomFor, type MapNode, type Metric } from "../../lib/helperMap";
import { AgentAvatar, agentLook, avatarIconSize, avatarName, HELPER_KINDS, MainChatIcon, OUTCOMES } from "./helperKit";
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

export const OUTCOME_LABEL: Record<Outcome, string> = { finished: OUTCOMES.finished.label, errored: OUTCOMES.errored.label, stopped: OUTCOMES.stopped.label };

/** The colour of how a helper ended where the transcript says, else neutral: the dot on its corner. */
export function outcomeColor(n: Pick<MapNode, "kind" | "outcome">): string {
  if (n.kind === "root") return "var(--accent)";
  if (n.kind === "more") return "var(--line-strong)";
  return n.outcome ? OUTCOMES[n.outcome].color : "var(--slate)";
}

/** The one line under a name: the node's tokens and how it ended. */
export function nodeDetail(n: MapNode): string {
  const tokens = `${compact(n.tokens)} tokens`;
  if (n.kind === "more") return tokens;
  return n.outcome ? `${tokens}, ${OUTCOME_LABEL[n.outcome].toLowerCase()}` : tokens;
}

/** The side of a helper's tile: its bubble's width, a little in, so a square weighs what the circle did. */
const tileSide = (n: MapNode) => Math.round(n.r * 1.8);

/**
 * The helper map: the main chat in the middle, each helper hanging from the thread that started
 * it. A helper is drawn as the same avatar it has in the list (its kind's icon on its kind's
 * tile; hollow when another helper started it), sized by its tokens, with a dot on its corner for
 * how it ended. The biggest helpers carry their name and tokens beside them wherever there is
 * clear room; every node shows its whole name on a plate when pointed at or focused. The legend
 * under the map names each kind that is on it. A big tree grows past the pane and the pane scrolls.
 */
export function HelperMap({
  receipt,
  sessionId,
  selected,
  onSelect,
  types = new Map(),
}: {
  receipt: Receipt;
  sessionId: string;
  selected: string | null;
  onSelect: (id: string) => void;
  /** Helper type per agent id (from the session's helpers), for the icons. */
  types?: Map<string, string | null>;
}) {
  const intro = useIntro(`map:${sessionId}`);
  const [box, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const layout = useMemo(() => layoutMap(receipt.threads, size, undefined, MAP_BY), [receipt.threads, size]);

  // A tree bigger than the pane is shown a little smaller (names and plates stay full size).
  const zoom = useMemo(() => zoomFor(layout, size), [layout, size]);
  const lit = useMemo(() => pathTo(layout, hover ?? selected ?? MAIN_ID), [layout, hover, selected]);
  const labels = useMemo(() => new Map(restLabels(layout, (n) => `${compact(n.tokens)} tokens`, zoom).map((l) => [l.id, l])), [layout, zoom]);
  const typeOf = (n: MapNode) => types.get(n.thread?.agentId ?? "") ?? null;
  const helpers = layout.nodes.filter((n) => n.kind === "helper");
  const present = new Set(helpers.map((n) => n.outcome).filter((o): o is Outcome => o !== null));
  const kinds = new Set(helpers.map((n) => agentLook(typeOf(n)).kind));
  const anyNested = helpers.some((n) => n.depth >= 2);

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
              const helper = n.kind === "helper";
              const look = helper ? agentLook(typeOf(n)) : null;
              const side = tileSide(n);
              const glyph = n.kind === "root" ? 24 : avatarIconSize(side);
              const Icon = n.kind === "root" ? MainChatIcon : look?.Icon;
              const label = labels.get(n.id);
              const kindName = n.kind === "root" ? "" : helper ? `, ${avatarName(typeOf(n), n.depth >= 2 ? "nested" : "helper")}` : "";
              return (
                <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
                  <g
                    className={`map-node${n.id === selected ? " sel" : ""}${lit.has(n.id) ? " on" : ""}${n.kind === "more" ? " more" : ""}${n.kind === "root" ? " root" : ""}${helper && n.depth >= 2 ? " nested" : ""}`}
                    style={{
                      ["--i" as string]: n.index,
                      ["--c" as string]: look?.fg ?? outcomeColor(n),
                      ["--cb" as string]: look?.bg ?? "var(--raised)",
                      ["--o" as string]: outcomeColor(n),
                    }}
                    tabIndex={0}
                    role="button"
                    aria-pressed={n.id === selected}
                    aria-label={`${n.name}, ${nodeDetail(n)}${kindName}`}
                    onClick={() => onSelect(n.id)}
                    onKeyDown={(e) => onKey(e, n.id)}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                    onFocus={() => setHover(n.id)}
                    onBlur={() => setHover((h) => (h === n.id ? null : h))}
                  >
                    <circle className="map-hit" r={n.r + 8} />
                    {helper ? (
                      <rect className="map-ring" x={-side / 2 - 5} y={-side / 2 - 5} width={side + 10} height={side + 10} rx={Math.round(side * 0.3) + 4} />
                    ) : (
                      <circle className="map-ring" r={n.r + 6} />
                    )}
                    <g className="map-body">
                      {helper ? (
                        <>
                          {/* The same tile as the helper's avatar in the list, on a backing that hides the line under it. */}
                          <rect className="map-back" x={-side / 2} y={-side / 2} width={side} height={side} rx={Math.round(side * 0.3)} />
                          <rect className="map-tile" x={-side / 2} y={-side / 2} width={side} height={side} rx={Math.round(side * 0.3)} />
                        </>
                      ) : (
                        <circle className="map-dot" r={n.r} />
                      )}
                      {Icon ? (
                        <Icon className="map-icon" x={-glyph / 2} y={-glyph / 2} size={glyph} weight="duotone" aria-hidden="true" />
                      ) : (
                        <text className="map-plus" textAnchor="middle" dominantBaseline="central">
                          {`+${n.hidden.length}`}
                        </text>
                      )}
                      {helper && n.outcome && <circle className="map-outcome" cx={side / 2 - 3} cy={-side / 2 + 3} r={5} />}
                    </g>
                    {n.kind === "root" && (
                      <text className="map-name" transform={`translate(0 ${ROOT_R + 28}) scale(${1 / zoom})`} textAnchor="middle">
                        Main chat
                      </text>
                    )}
                    {/* While the node is pointed at, its plate says the whole name: the short one steps aside, never half under it. */}
                    {label && hover !== n.id && (
                      <g className="map-rest" transform={`translate(${label.x - n.x} 0) scale(${1 / zoom})`} aria-hidden="true">
                        <text className="map-name" textAnchor={label.anchor} y={-3}>
                          {label.name}
                        </text>
                        <text className="map-rest-detail" textAnchor={label.anchor} y={12}>
                          {label.detail}
                        </text>
                      </g>
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
      {/* The key: every kind of helper on this map with its icon, then the shapes, then how they ended. */}
      <ul className="map-legend" aria-label="What the icons, shapes and dots mean">
        {HELPER_KINDS.filter((k) => kinds.has(k)).map((k) => (
          <li key={k}>
            <AgentAvatar type={k} size={20} quiet />
            {agentLook(k).label}
          </li>
        ))}
        {anyNested && (
          <li>
            <AgentAvatar type={null} size={20} level="nested" quiet />
            Started by a helper
          </li>
        )}
        {(["finished", "errored", "stopped"] as Outcome[])
          .filter((o) => present.has(o))
          .map((o) => (
            <li key={o}>
              <i aria-hidden="true" style={{ background: OUTCOMES[o].color }} />
              {OUTCOME_LABEL[o]}
            </li>
          ))}
      </ul>
    </div>
  );
}
