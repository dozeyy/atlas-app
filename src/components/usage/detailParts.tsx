import { createContext, useContext, useLayoutEffect, useRef, useState } from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { Copy } from "@phosphor-icons/react";
import { Card, IconButton } from "../controls";
import { pushToast } from "../../state/toastStore";
import { CostText } from "./CostText";
import { KIND_WORDS } from "../../lib/receiptView";
import { compact, effortMix, exact, headline, mergeModelRows, plural } from "../../lib/usage";
import type { Cost, Tokens } from "../../lib/types";
import type { EffortUse } from "../../lib/usageTypes";

/** A small number card: a label, one figure, an optional line under it. */
export function Stat({ label, children, sub, icon }: { label: string; children: ReactNode; sub?: ReactNode; icon?: ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <div className="flex items-center gap-2 text-caption font-medium text-ink-2">
        {icon}
        {label}
      </div>
      <div className="d d-stat mt-1 text-ink">{children}</div>
      {sub && <div className="mt-1 text-caption text-ink-2">{sub}</div>}
    </Card>
  );
}

/** How long a list's width has to hold still before its clamped texts are measured again. */
export const CLAMP_SETTLE_MS = 140;

/** The width a list of clamped texts last settled at; null outside a `ClampList`. */
const ClampWidth = createContext<number | null>(null);

/**
 * A list of clamped texts that share ONE size watcher. A long conversation holds hundreds of
 * messages; with a watcher each, every one of them fired and read the layout on every frame of a
 * pane resize. Here the list watches its own width, waits for it to settle, and the texts inside
 * measure once for that width. Height changes (rows loading, a text opening) measure nothing.
 */
export function ClampList({ className, children, ...rest }: { className?: string; children: ReactNode } & Omit<HTMLAttributes<HTMLOListElement>, "className" | "children">) {
  const ref = useRef<HTMLOListElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let timer = 0;
    let last = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w === last) return;
      last = w;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWidth(w), CLAMP_SETTLE_MS);
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(timer);
      ro.disconnect();
    };
  }, []);
  return (
    <ol ref={ref} className={className} {...rest}>
      <ClampWidth.Provider value={width}>{children}</ClampWidth.Provider>
    </ol>
  );
}

/**
 * Long text cut to a few lines with a plain way to the rest. The whole text stays in the page (it
 * can be found and read out); the button shows only when something is actually cut. On its own it
 * watches its own size; inside a `ClampList` it measures when the list's width settles instead.
 */
export function ClampText({ text, lines = 3, className = "" }: { text: string; lines?: number; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const listWidth = useContext(ClampWidth);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || open) return;
    const read = () => setCut(el.scrollHeight > el.clientHeight + 1);
    read();
    if (listWidth !== null || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open, lines, listWidth]);
  return (
    <div className="min-w-0 flex-1">
      <p ref={ref} className={`${className}${open ? "" : " clamp-lines"}`} style={open ? undefined : { WebkitLineClamp: lines }}>
        {text}
      </p>
      {(cut || open) && (
        <button type="button" className="clamp-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="text-caption font-semibold text-accent-text">{open ? "Show less" : "Show all"}</span>
        </button>
      )}
    </div>
  );
}

/**
 * The four kinds of token, each with its exact figure, in plain words: the exact term and what it
 * means are the row's hover. Cache reads sit apart (Q2). With `main`, the main chat's own figures
 * stand beside the whole chat's (`t`), so nothing has to be switched to compare the two.
 */
export function Breakdown({ t, main }: { t: Tokens; main?: Tokens }) {
  const W = KIND_WORDS;
  const rows: [name: string, pick: (x: Tokens) => number, hover: string, note?: string][] = [
    [W.input.label, (x) => x.input, `${W.input.term}\n${W.input.about}`],
    [W.output.label, (x) => x.output, `${W.output.term}\n${W.output.about}`],
    ["Saved for 5 minutes", (x) => x.cacheWrite5m, `${W.cacheWrite.term}, 5-minute\n${W.cacheWrite.about}`],
    ["Saved for 1 hour", (x) => x.cacheWrite1h, `${W.cacheWrite.term}, 1-hour\n${W.cacheWrite.about}`],
    ["Reused", (x) => x.cacheRead, `${W.cacheRead.term}\n${W.cacheRead.about}`, "Counted apart, not in the total"],
  ];
  const cols: [string, Tokens][] = main ? [["Main session", main], ["With helpers", t]] : [["Tokens", t]];
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-body">
        <caption className="sr-only">Tokens by kind</caption>
        <thead className={main ? "text-caption text-ink-2" : "sr-only"}>
          <tr className="border-b border-line">
            <th scope="col" className="px-5 py-2 text-left font-medium">Kind</th>
            {cols.map(([name]) => (
              <th key={name} scope="col" className="px-5 py-2 text-right font-medium whitespace-nowrap">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, pick, hover, note]) => (
            <tr key={name} className="border-b border-line last:border-b-0">
              <th scope="row" className="px-5 py-2.5 text-left font-normal text-ink" title={hover}>
                {name}
                {note && <span className="ml-2 text-caption text-ink-2">{note}</span>}
              </th>
              {cols.map(([col, x]) => (
                <td key={col} className="px-5 py-2.5 text-right tabular-nums text-ink">
                  {exact(pick(x))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

/**
 * Usage split by model: the full name ("Opus 5.5"), its reasoning-effort mix under it when the
 * transcripts recorded one, "not priced" for a model the price list does not know, its tokens
 * and its cost.
 */
export function ModelSplit({ rows }: { rows: { model: string; tokens: Tokens; cost: Cost; known?: boolean; efforts?: EffortUse[] }[] }) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-body">
        <caption className="sr-only">Usage by model</caption>
        <thead className="text-left text-caption text-ink-2">
          <tr className="border-b border-line">
            <th scope="col" className="px-5 py-2 font-medium">Model</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Tokens</th>
            <th scope="col" className="px-5 py-2 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {mergeModelRows(rows).map((r) => (
            <tr key={r.label} className="border-b border-line last:border-b-0">
              {/* The exact model ids and the effort mix are detail: they are the name's hover. */}
              <th
                scope="row"
                className="px-5 py-2 text-left font-normal text-ink"
                title={`${r.models.join(", ")}${effortMix(r.efforts) ? `\nReasoning effort: ${effortMix(r.efforts)}` : ""}`}
              >
                {r.label}
                {!r.known && <span className="ml-2 text-caption text-ink-2">not priced</span>}
              </th>
              <td className="px-3 py-2 text-right" title={exact(headline(r.tokens))}>{compact(headline(r.tokens))}</td>
              <td className="px-5 py-2 text-right"><CostText cost={r.cost} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export const toolCallsText = (n: number): string => plural(n, "tool call");

/** Puts a saved chat file's path on the clipboard and says so. */
async function copyPath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
    pushToast({ message: "Path copied", tone: "success" });
  } catch {
    pushToast({ message: "Could not reach the clipboard.", tone: "error" });
  }
}

/**
 * One saved chat file, named by whose it is. The path is never on the surface: it is the row's
 * hover and one press away on the clipboard.
 */
export function FileRow({ who, path, missing = false, as: Tag = "li" }: { who: string; path: string; missing?: boolean; as?: "li" | "div" }) {
  return (
    <Tag className="flex items-center gap-3 py-1 pl-4 pr-2">
      <span className="min-w-0 flex-1 truncate text-body text-ink" title={path}>
        {who}
      </span>
      {missing && <span className="shrink-0 text-caption text-warning">removed from disk</span>}
      <IconButton aria-label={`Copy the file path of ${who}`} title={`Copy path\n${path}`} onClick={() => void copyPath(path)}>
        <Copy size={14} aria-hidden="true" />
      </IconButton>
    </Tag>
  );
}
