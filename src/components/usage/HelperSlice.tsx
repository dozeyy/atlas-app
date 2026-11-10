import { useMemo, useState } from "react";
import { ArrowRight, CaretDown, Stack, Warning } from "@phosphor-icons/react";
import { Button } from "../controls";
import { EndLine } from "./EndLine";
import { AgentAvatar, ModelChip, OutcomeMark } from "./helperKit";
import { MAP_BY } from "./HelperMap";
import { layoutMap, MAIN_ID, type MapNode } from "../../lib/helperMap";
import { KIND_WORDS, flagText, guess, itemDetail, itemTitle, itemTitleFull, kindLines, kindTitle, lineTitle, tokensText } from "../../lib/receiptView";
import { compact, formatDuration, percent, plural, share } from "../../lib/usage";
import type { Receipt } from "../../lib/types";

const HIDDEN_SHOWN = 8;

/** What a node and everything hanging from it used. */
function withKids(nodes: MapNode[], id: string): number {
  const kids = new Map<string, MapNode[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const walk = (at: string): number => (nodes.find((n) => n.id === at)?.tokens ?? 0) + (kids.get(at) ?? []).reduce((s, k) => s + walk(k.id), 0);
  return walk(id);
}

/** "general-purpose" -> "General purpose"; nothing when the name already says it. */
function typeWords(type: string | null, name: string): string | null {
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!type || flat(name).startsWith(flat(type))) return null;
  const s = type.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * One node's slice of the receipt, shortest first: who it is (the same avatar as on the map), how
 * it ended, its one figure and its share, then the way to its own page and any flag against it.
 * Where the tokens went (kinds and biggest lines) waits behind "Where it went", closed until asked.
 * A "+N" node lists the helpers folded into it instead.
 */
export function HelperSlice({
  receipt,
  nodeId,
  onOpenHelper,
  effortOf,
  types = new Map(),
}: {
  receipt: Receipt;
  nodeId: string;
  onOpenHelper: (agentId: string) => void;
  /** The most used reasoning effort of a thread (null agentId = the main chat); none when unknown. */
  effortOf?: (agentId: string | null) => string | null;
  /** Helper type per agent id, for the avatar: the same map the helper map draws from. */
  types?: Map<string, string | null>;
}) {
  const nodes = useMemo(() => layoutMap(receipt.threads, { width: 640, height: 400 }, undefined, MAP_BY).nodes, [receipt.threads]);
  // Stays as it was left while other nodes are picked: someone comparing helpers opens it once.
  const [open, setOpen] = useState(false);
  const node = nodes.find((n) => n.id === nodeId) ?? nodes.find((n) => n.id === MAIN_ID);
  if (!node) return null;
  const total = receipt.totalTokens;
  const parent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined;
  const subtotal = withKids(nodes, node.id);
  const t = node.thread;
  const type = types.get(t?.agentId ?? "") ?? null;
  const kind = node.kind === "helper" ? typeWords(type, node.name) : null;
  const used = t ? kindLines(t.tokenKinds, t.kinds) : [];
  const lines = t ? [...t.items].sort((a, b) => b.tokens - a.tokens).slice(0, 2) : [];
  const hasMore = !!t && (t.tokens > 0 || lines.length > 0);
  const ran = t && t.durationMs > 0 ? formatDuration(t.durationMs) : "";

  return (
    <aside aria-label={`Slice: ${node.name}`} className="slice">
      <div className="flex items-center gap-3">
        {node.kind === "more" ? (
          <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-full border border-dashed border-line-strong text-ink-2">
            <Stack size={16} weight="duotone" />
          </span>
        ) : (
          <AgentAvatar type={type} size={32} level={node.kind === "root" ? "main" : node.depth >= 2 ? "nested" : "helper"} quiet={node.kind !== "root" && !!kind} />
        )}
        <div className="min-w-0">
          <h2 className="h-section truncate" title={node.name}>
            {node.name}
          </h2>
          {node.kind === "more" ? (
            <div className="truncate text-caption text-ink-2">{`${plural(node.hidden.length, "small helper")}, folded together`}</div>
          ) : (
            (node.outcome || kind || (parent && parent.kind !== "root")) && (
              <div className="flex min-w-0 items-baseline gap-x-2 text-caption text-ink-2">
                {node.outcome && <OutcomeMark outcome={node.outcome} />}
                {kind && (
                  <span className="min-w-0 truncate" title={type ?? undefined}>
                    {kind}
                  </span>
                )}
                {parent && parent.kind !== "root" && (
                  <span className="min-w-0 truncate" title={`Started by ${parent.name}`}>{`by ${parent.name}`}</span>
                )}
              </div>
            )
          )}
        </div>
      </div>

      {/* In a narrow slice the share drops to its own line whole, never "81% of the" over "chat". */}
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3">
        <span className="d d-stat tabular-nums text-ink" title={node.usd > 0 ? `${node.name}: ${tokensText(node.tokens)}, ${guess(node.usd)}` : undefined}>
          {compact(node.tokens)}
        </span>
        <span className="text-body text-ink-2">tokens</span>
        <span
          className="whitespace-nowrap text-body tabular-nums text-ink-2"
          title={subtotal - node.tokens >= 1 ? `${tokensText(subtotal)} with the helpers it started` : undefined}
        >{`${percent(share(node.tokens, total))} of the session`}</span>
      </div>

      {t && (
        <div className="slice-facts">
          <ModelChip model={t.model} effort={effortOf?.(t.agentId)} />
          {ran && (
            <span className="whitespace-nowrap text-caption text-ink-2" title={`${plural(t.messages, "message")}, ${plural(t.toolCalls, "tool call")}`}>
              {ran}
            </span>
          )}
        </div>
      )}

      {t?.agentId && (
        <Button className="mt-3" onClick={() => onOpenHelper(t.agentId as string)}>
          Open helper
          <ArrowRight size={14} aria-hidden="true" />
        </Button>
      )}

      {t && t.flags.length > 0 && (
        <section aria-label="Worth a look" className="mt-4">
          <ul className="space-y-2">
            {t.flags.slice(0, 1).map((f, i) => {
              const x = flagText(f);
              return (
                <li key={`${f.kind}:${i}`} className="rcpt-flag" title={x.title}>
                  <Warning size={14} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
                  <div className="min-w-0">
                    <div className="text-caption text-warning">{x.kicker}</div>
                    <div className="text-caption text-ink-2">{x.detail}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {node.kind === "more" && (
        <section aria-label="Folded helpers" className="mt-4">
          <h4 className="rcpt-head">Folded in</h4>
          <ul>
            {node.hidden.slice(0, HIDDEN_SHOWN).map((h) => (
              <li key={h.agentId}>
                <button type="button" className="rcpt-item rcpt-line-btn w-full text-left" onClick={() => h.agentId && onOpenHelper(h.agentId)}>
                  <span className="min-w-0 truncate text-body text-ink">{h.name}</span>
                  <span className="shrink-0 text-body tabular-nums text-ink" title={`${h.name}: ${tokensText(h.tokens)}, ${guess(h.usd)}`}>
                    {compact(h.tokens)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {node.hidden.length > HIDDEN_SHOWN && <p className="mt-1 text-caption text-ink-2">{`and ${plural(node.hidden.length - HIDDEN_SHOWN, "more")}`}</p>}
        </section>
      )}

      {hasMore && t && (
        <div className="mt-3">
          <button type="button" className="rcpt-item rcpt-line-btn slice-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <span className="text-caption font-semibold text-ink-2">Where it went</span>
            <CaretDown size={12} weight="bold" aria-hidden="true" className="text-ink-2" />
          </button>
          {open && (
            <div className="slice-more-body">
              {t.tokens > 0 && (
                <section aria-label="What it used">
                  <ul>
                    {used.map((l) => (
                      <li key={l.key} className="rcpt-item" title={lineTitle(l)}>
                        <span className="text-body text-ink">{l.label}</span>
                        <span className="shrink-0 text-body tabular-nums text-ink">{compact(l.tokens)}</span>
                      </li>
                    ))}
                  </ul>
                  {t.tokenKinds.cacheRead > 0 && (
                    <p className="mt-1 text-caption text-ink-2" title={kindTitle("cacheRead", t.tokenKinds.cacheRead, t.kinds.cacheRead)}>
                      {`plus ${compact(t.tokenKinds.cacheRead)} ${KIND_WORDS.cacheRead.label}`}
                    </p>
                  )}
                </section>
              )}
              {lines.length > 0 && (
                <section aria-label="Biggest lines" className="mt-3">
                  <h4 className="rcpt-head">Biggest lines</h4>
                  <ul>
                    {lines.map((i, n) => (
                      <li key={`${i.kind}:${i.tool}:${i.path ?? ""}:${n}`} className="rcpt-item" title={itemTitleFull(i)}>
                        <div className="min-w-0">
                          <EndLine text={itemTitle(i)} path={i.path} className="text-body text-ink" />
                          {itemDetail(i) && <div className="truncate text-caption text-ink-2">{itemDetail(i)}</div>}
                        </div>
                        <span className="shrink-0 text-body tabular-nums text-ink">{`~${compact(i.tokens)}`}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
