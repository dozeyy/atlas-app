import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, RefObject } from "react";
import { ChartTooltip, type TipAt } from "../charts/ChartTooltip";
import { useIntro } from "../../lib/motion";
import { layoutMap, MAIN_ID, pathTo, type MapNode } from "../../lib/helperMap";
import { formatUsd, percent, share } from "../../lib/usage";
import type { Outcome, Receipt } from "../../lib/types";

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
  if (n.kind === "more") return "var(--raised)";
  if (n.outcome === "finished") return "var(--success)";
  if (n.outcome === "errored") return "var(--danger)";
  if (n.outcome === "stopped") return "var(--warning)";
  return "var(--slate)";
}

const clip = (s: string, n = 20) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

/** Where a node's name sits: outward from the middle, so names never run over the links. */
function labelAt(n: MapNode): { x: number; y: number; anchor: "start" | "middle" | "end" } {
  if (n.kind === "root") return { x: 0, y: n.r + 15, anchor: "middle" };
  const cos = Math.cos(n.angle);
  const sin = Math.sin(n.angle);
  if (Math.abs(cos) < 0.3) return { x: 0, y: sin >= 0 ? n.r + 14 : -n.r - 7, anchor: "middle" };
  return { x: cos >= 0 ? n.r + 6 : -n.r - 6, y: 4, anchor: cos >= 0 ? "start" : "end" };
}

/** Which nodes carry a visible name: everyone when few, else the main chat and the big spenders. */
function labelled(nodes: MapNode[], extra: (string | null)[]): Set<string> {
  const ids = new Set<string>(extra.filter((e): e is string => e !== null));
  ids.add(MAIN_ID);
  for (const n of nodes) if (n.kind === "more") ids.add(n.id);
  if (nodes.length <= 14) nodes.forEach((n) => ids.add(n.id));
  else
    [...nodes]
      .filter((n) => n.kind === "helper")
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 7)
      .forEach((n) => ids.add(n.id));
  return ids;
}

/**
 * The helper map: the main chat in the middle, each helper hanging from the thread that started
 * it, ring by ring. A dot's area follows what it spent; its colour is how it ended. Point at one
 * to see its line back to the main chat, select one to read its slice.
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
  const layout = useMemo(() => layoutMap(receipt.threads, size), [receipt.threads, size]);
  const total = receipt.totalUsd ?? 0;

  const lit = useMemo(() => pathTo(layout, hover ?? selected ?? MAIN_ID), [layout, hover, selected]);
  const names = useMemo(() => labelled(layout.nodes, [hover, selected]), [layout, hover, selected]);
  const present = new Set(layout.nodes.map((n) => n.outcome).filter((o): o is Outcome => o !== null));

  const tipNode = hover ? layout.nodes.find((n) => n.id === hover) : undefined;
  const tip: TipAt | null = tipNode
    ? {
        x: tipNode.x,
        y: tipNode.y - tipNode.r,
        title: tipNode.name,
        valueText: formatUsd(tipNode.usd),
        detail: `${percent(share(tipNode.usd, total))} of the chat${tipNode.outcome ? `, ${OUTCOME_LABEL[tipNode.outcome].toLowerCase()}` : ""}`,
      }
    : null;

  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div ref={box} className={`chart-wrap map h-full min-h-0 w-full${intro ? " intro" : ""}${hover ? " has-focus" : ""}`}>
      <svg
        className="chart"
        width={layout.width}
        height={layout.height}
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
          const isOn = lit.has(n.id);
          const lab = labelAt(n);
          const showName = names.has(n.id);
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
              <g
                className={`map-node${n.id === selected ? " sel" : ""}${isOn ? " on" : ""}${n.kind === "more" ? " more" : ""}`}
                style={{ ["--i" as string]: n.index }}
                tabIndex={0}
                role="button"
                aria-pressed={n.id === selected}
                aria-label={`${n.name}, ${formatUsd(n.usd)}${n.outcome ? `, ${OUTCOME_LABEL[n.outcome].toLowerCase()}` : ""}`}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => onKey(e, n.id)}
                onPointerEnter={() => setHover(n.id)}
                onPointerLeave={() => setHover((h) => (h === n.id ? null : h))}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover((h) => (h === n.id ? null : h))}
              >
                <circle className="map-hit" r={Math.max(n.r + 4, 13)} />
                {n.id === selected && <circle className="map-ring" r={n.r + 5} />}
                <circle className="map-dot" r={n.r} fill={outcomeColor(n)} />
                {showName && (
                  <text className="map-name" x={lab.x} y={lab.y} textAnchor={lab.anchor}>
                    {n.kind === "more" ? `+${n.hidden.length} more` : clip(n.name)}
                  </text>
                )}
              </g>
            </g>
          );
        })}
      </svg>
      <ChartTooltip tip={tip} width={layout.width} />
      {present.size > 0 && (
        <ul className="map-legend" aria-label="How helpers ended">
          {(["finished", "errored", "stopped"] as Outcome[])
            .filter((o) => present.has(o))
            .map((o) => (
              <li key={o}>
                <i aria-hidden="true" style={{ background: outcomeColor({ kind: "helper", outcome: o }) }} />
                {OUTCOME_LABEL[o]}
              </li>
            ))}
        </ul>
      )}
    </div>
  );
}
