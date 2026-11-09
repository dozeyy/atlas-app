import type { ModelFamily } from "../../lib/modelFamily";

/**
 * The helper map's icons, drawn on a 24 px grid with a round 1.75 px line like the rest of the
 * app's icons. One per model family, and one for the main chat:
 *   Opus   a cut gem (the heavy, expensive one)
 *   Sonnet two waves (a poem's flow)
 *   Haiku  three lines, short long short (5-7-5)
 *   Fable  an open book
 *   other  a hexagon with a dot
 *   chat   a speech bubble with two lines
 */
const PATH: Record<ModelFamily | "chat", string> = {
  opus: "M7 4h10l4 5-9 11L3 9z M3 9h18 M10 4 8.5 9 12 20 M14 4l1.5 5L12 20",
  sonnet: "M3 9c3-3.5 6-3.5 9 0s6 3.5 9 0 M3 15c3-3.5 6-3.5 9 0s6 3.5 9 0",
  haiku: "M6 7h7 M6 12h12 M6 17h7",
  fable: "M12 7c-2.2-1.6-5-2-8-1.5v12.5c3-.5 5.8-.1 8 1.5 2.2-1.6 5-2 8-1.5V5.5C17 5 14.2 5.4 12 7z M12 7v12.5",
  other: "M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z",
  chat: "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 3.5V17H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M8 10h8 M8 13h5",
};

/** An icon centred on (0,0), `size` px square. Colour comes from the CSS class `map-glyph`. */
export function MapGlyph({ kind, size }: { kind: ModelFamily | "chat"; size: number }) {
  const k = size / 24;
  return (
    <g className="map-glyph" aria-hidden="true" transform={`translate(${-size / 2} ${-size / 2}) scale(${k})`}>
      <path d={PATH[kind]} strokeWidth={2} />
      {kind === "other" && <circle cx={12} cy={12} r={1.6} className="map-glyph-fill" />}
    </g>
  );
}
