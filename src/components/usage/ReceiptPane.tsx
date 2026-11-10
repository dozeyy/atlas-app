import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { CaretDown, Stack, Warning } from "@phosphor-icons/react";
import { EndLine } from "./EndLine";
import { Skeleton } from "./StateBlocks";
import { EmptyState } from "../EmptyState";
import { AgentAvatar, modelTone } from "./helperKit";
import { useIntro } from "../../lib/motion";
import { KIND_WORDS, barWidth, byModel, cacheReads, fitColumn, flagText, itemDetail, itemTitleFull, itemTitle, kindTitle, lineTitle, tokensText, whatItUsed, whoUsed, type SpendLine } from "../../lib/receiptView";
import { compact, percent, plural, share } from "../../lib/usage";
import type { Receipt } from "../../lib/types";

const FLAGS_SHOWN = 3;
const WIDE_PX = 896; // where the receipt goes to three columns (Tailwind @4xl)
const FOOTER_PX = 0; // nothing sits under the lists any more
/** What a "~" figure is: the engine sizes each result by its length; it is not a slice of the chat's tokens. */
const ITEMS_NOTE = "~ is a rough size from the length of each result, not a share of the total.";

/** The pane's size, kept current. Starts at 0 (unknown) until the element is measured. */
function useBox(): [{ w: number; h: number }, (el: HTMLDivElement | null) => void] {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const ro = useRef<ResizeObserver | null>(null);
  useEffect(() => () => ro.current?.disconnect(), []);
  const ref = useCallback((el: HTMLDivElement | null) => {
    ro.current?.disconnect();
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => setBox((b) => (b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    read();
    ro.current = new ResizeObserver(read);
    ro.current.observe(el);
  }, []);
  return [box, ref];
}

/** The bar colour for a line: the same dots the model chips wear, one hue per kind. */
function tint(line: SpendLine): string {
  if (line.kind === "model") return `var(--chart-${modelTone(line.model ?? "")})`;
  if (line.kind === "main") return "var(--accent)";
  if (line.kind === "helper") return "var(--chart-2)";
  if (line.kind === "kind") {
    const slot: Record<string, number> = { cacheWrite: 1, cacheRead: 2, output: 3, input: 4, web: 4 };
    return `var(--chart-${slot[line.key] ?? 4})`;
  }
  return "var(--line-strong)";
}

/** Who a line is: maps a line to the mark in front of it (the "Who used it" list only). */
type Mark = (line: SpendLine) => ReactNode;

function Line({ line, total, index, onOpen, mark }: { line: SpendLine; total: number; index: number; onOpen?: (agentId: string | null) => void; mark?: Mark }) {
  const frac = share(line.tokens, total);
  const figures = (
    <>
      <span className="flex items-baseline justify-between gap-3" title={lineTitle(line)}>
        <span className={`min-w-0 truncate text-body ${line.kind === "other" || line.kind === "more" ? "text-ink-2" : "text-ink"}`}>{line.label}</span>
        <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
          <span className="text-body text-ink">{compact(line.tokens)}</span>
          <span className="w-9 text-right text-caption text-ink-2">{percent(frac)}</span>
        </span>
      </span>
      <span className="share-bar rcpt-bar mt-1 block" role="img" aria-label={`${percent(frac)} of the session`}>
        <i style={{ width: `${barWidth(line.tokens, total)}%`, ["--bar" as string]: tint(line), ["--i" as string]: Math.min(index, 12) }} />
      </span>
    </>
  );
  // With a mark, the name and its bar sit beside it: the mark is as tall as the two together.
  const body = mark ? (
    <span className="flex items-center gap-2">
      {mark(line)}
      <span className="block min-w-0 flex-1">{figures}</span>
    </span>
  ) : (
    figures
  );
  const open = onOpen && (line.kind === "helper" || line.kind === "main");
  return (
    <li>
      {open ? (
        <button type="button" className="rcpt-line rcpt-line-btn" onClick={() => onOpen(line.agentId)} aria-label={`${line.label}, ${tokensText(line.tokens)}. Show in the helper map`} title={lineTitle(line)}>
          {body}
        </button>
      ) : (
        <div className="rcpt-line">{body}</div>
      )}
    </li>
  );
}

function Lines({
  lines,
  total,
  label,
  onOpen,
  mark,
  children,
}: {
  lines: SpendLine[];
  total: number;
  label: string;
  onOpen?: (agentId: string | null) => void;
  mark?: Mark;
  children?: ReactNode;
}) {
  return (
    <section aria-label={label} className="min-w-0">
      <h3 className="rcpt-head">{label}</h3>
      {/* No total row: every list adds up to the figure at the top of the page. */}
      <ul>
        {lines.map((l, i) => (
          <Line key={l.key} line={l} total={total} index={i} onOpen={onOpen} mark={mark} />
        ))}
      </ul>
      {children}
    </section>
  );
}

function ReceiptSkeleton() {
  return (
    <div role="status" aria-label="Adding up the session" className="grid gap-x-8 gap-y-6 @xl:grid-cols-2 @4xl:grid-cols-3">
      {[0, 1, 2].map((c) => (
        <div key={c} className="space-y-3">
          <Skeleton className="h-4 w-28" />
          {[0, 1, 2, 3, 4].map((r) => (
            <Skeleton key={r} className="h-8" />
          ))}
        </div>
      ))}
    </div>
  );
}

export interface ReceiptState {
  data: Receipt | null;
  error: string | null;
  loading: boolean;
  reload: (silent?: boolean) => void;
}

/** Whether the line items were left open, remembered across chats and launches. */
const ITEMS_KEY = "atlas.chat.lineItems";
function readItemsOpen(): boolean {
  try {
    return localStorage.getItem(ITEMS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Where the chat's tokens went: who used them, what they were, and anything worth a look. The
 * biggest line items wait behind one row, closed until asked (and left as they were last time).
 * "Who used it", "What it used" and "By model" each add up to the figure at the top of the page;
 * what no line explains is "Everything else". Kinds of token wear plain words, with the exact
 * term in the hover. Dollars are only estimates and show up in the hover text. The items and
 * flags are sizes read from the transcript, marked "about" or "~": they are not shares of the
 * total, so that list carries a note instead of a total.
 */
export function ReceiptPane({
  state,
  sessionId,
  onOpenHelper,
  effortOf,
  types,
}: {
  state: ReceiptState;
  sessionId: string;
  onOpenHelper: (agentId: string | null) => void;
  /** Helper type per agent id (from the session's helpers), for the icons in "Who used it". */
  types?: Map<string, string | null>;
  /** A model's most used reasoning effort in this chat, when the transcripts recorded one. */
  effortOf?: (model: string) => string | null | undefined;
}) {
  const intro = useIntro(`receipt:${sessionId}`);
  const [box, boxRef] = useBox();
  const [itemsOpen, setItemsOpen] = useState(readItemsOpen);
  const itemsId = useId();
  const toggleItems = () => {
    const next = !itemsOpen;
    setItemsOpen(next);
    try {
      localStorage.setItem(ITEMS_KEY, next ? "1" : "0");
    } catch {
      // Not remembered this time; the row still opens.
    }
  };
  const r = state.data;

  if (state.error && !r) {
    return (
      <EmptyState compact variant="error" title="Could not load the token breakdown" reason={state.error} action={{ onClick: () => state.reload(false) }} />
    );
  }
  if (!r) {
    if (state.loading) return <ReceiptSkeleton />;
    return <p className="text-body text-ink-2">This session is no longer in your usage data.</p>;
  }

  const total = r.totalTokens;
  const reads = cacheReads(r);
  // Three columns side by side: size the third to the room it has so nothing needs a scrollbar.
  // Narrower, it sits under the others and the pane scrolls if it must.
  const wide = itemsOpen && box.w >= WIDE_PX && box.h > 0;
  const fit = wide ? fitColumn(box.h - FOOTER_PX, r.flags.length, Math.min(8, r.items.length)) : null;
  const flags = r.flags.slice(0, fit ? fit.flags : FLAGS_SHOWN);
  const itemLimit = fit ? fit.items : flags.length > 0 ? 6 : 8;
  // The figure is tokens, so the biggest in tokens comes first.
  const items = [...r.items].sort((a, b) => b.tokens - a.tokens).slice(0, itemLimit);
  // The ~ figures are sizes read off the results, not shares of the chat's tokens, so this list
  // has no total and no remainder: only the items it left out, as a count and their own size.
  const itemRest = r.items.length - items.length;
  const itemRestTokens = r.items.reduce((s, i) => s + i.tokens, 0) - items.reduce((s, i) => s + i.tokens, 0);

  // The same avatar the map and the helper list give each thread; the folded line gets the stack.
  const whoMark = (line: SpendLine): ReactNode => {
    if (line.kind === "main") return <AgentAvatar type={null} size={24} level="main" />;
    if (line.kind === "helper") {
      const nested = !!r.threads.find((t) => t.agentId === line.agentId)?.parentAgentId;
      return <AgentAvatar type={types?.get(line.agentId ?? "") ?? null} size={24} level={nested ? "nested" : "helper"} />;
    }
    return (
      <span
        aria-hidden="true"
        style={{ width: 24, height: 24 }}
        className={`flex shrink-0 items-center justify-center ${line.kind === "more" ? "rounded-full border border-dashed border-line-strong text-ink-2" : ""}`}
      >
        {line.kind === "more" && <Stack size={14} weight="duotone" />}
      </span>
    );
  };

  return (
    <div ref={boxRef} className={`flex h-full min-h-0 flex-col ${intro ? "intro" : ""}`}>
      <div className="rcpt-scroll grid min-h-0 flex-1 content-start gap-x-8 gap-y-6 @xl:grid-cols-2 @4xl:grid-cols-3">
        <Lines label="Who used it" lines={whoUsed(r)} total={total} onOpen={r.threads.length > 1 ? onOpenHelper : undefined} mark={whoMark} />

        <div className="min-w-0 space-y-6">
          <Lines label="What it used" lines={whatItUsed(r)} total={total}>
            {reads.tokens > 0 && (
              <p className="mt-1 text-caption text-ink-2" title={kindTitle("cacheRead", reads.tokens, reads.usd)}>
                {`plus ${compact(reads.tokens)} ${KIND_WORDS.cacheRead.label}`}
              </p>
            )}
          </Lines>
          {r.models.length > 1 && <Lines label="By model" lines={byModel(r, effortOf)} total={total} />}
        </div>

        <div className="min-w-0 @xl:col-span-2 @4xl:col-span-1">
          {flags.length > 0 && (
            <section aria-label="Worth a look" className="mb-4">
              <h3 className="rcpt-head">Worth a look</h3>
              <ul className="space-y-2">
                {flags.map((f, i) => {
                  const t = flagText(f);
                  return (
                    <li key={`${f.kind}:${f.label}:${i}`} className="rcpt-flag">
                      <Warning size={14} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
                      <div className="min-w-0">
                        <div className="text-caption text-warning">{t.kicker}</div>
                        <EndLine text={t.name} path={f.kind === "repeat_read" ? f.label : null} className="text-body text-ink" title={t.title} />
                        <div className="truncate text-caption text-ink-2" title={t.title}>
                          {t.detail}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {r.flags.length > flags.length && <p className="mt-1 text-caption text-ink-2">{`${plural(r.flags.length - flags.length, "more flag")}`}</p>}
            </section>
          )}

          {/* The long list waits behind its own heading: one row, closed until asked. */}
          <section aria-label="Biggest line items">
            <h3>
              <button type="button" className="rcpt-item rcpt-line-btn slice-more" aria-expanded={itemsOpen} aria-controls={itemsId} onClick={toggleItems}>
                <span className="text-caption font-semibold text-ink-2">Biggest line items</span>
                <CaretDown size={12} weight="bold" aria-hidden="true" className="text-ink-2" />
              </button>
            </h3>
            {itemsOpen && (
              <div id={itemsId} className="slice-more-body">
                {!r.scanned ? (
                  <p className="text-body text-ink-2">The session file is gone, so line items cannot be read.</p>
                ) : items.length === 0 ? (
                  <p className="text-body text-ink-2">Nothing here stood out.</p>
                ) : (
                  <>
                    <ul>
                      {items.map((i, n) => (
                        <li key={`${i.kind}:${i.tool}:${i.path ?? ""}:${i.thread ?? ""}:${n}`} className="rcpt-item" title={itemTitleFull(i)}>
                          <div className="min-w-0">
                            <EndLine text={itemTitle(i)} path={i.path} className="text-body text-ink" title={itemTitle(i)} />
                            <div className="truncate text-caption text-ink-2">{[itemDetail(i), i.thread].filter(Boolean).join(", ")}</div>
                          </div>
                          <span className="shrink-0 text-body tabular-nums text-ink">{`~${compact(i.tokens)}`}</span>
                        </li>
                      ))}
                      {itemRest > 0 && (
                        <li className="rcpt-item">
                          <span className="text-body text-ink-2">{plural(itemRest, "smaller item")}</span>
                          <span className="shrink-0 text-body tabular-nums text-ink-2">{`~${compact(itemRestTokens)}`}</span>
                        </li>
                      )}
                    </ul>
                    <p className="mt-1 border-t border-line pt-2 text-caption text-ink-2">{ITEMS_NOTE}</p>
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
