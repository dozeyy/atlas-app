import { useMemo } from "react";
import { ArrowRight, Warning } from "@phosphor-icons/react";
import { Button } from "../controls";
import { ModelChip } from "./helperKit";
import { MAP_BY, OUTCOME_LABEL, outcomeColor } from "./HelperMap";
import { layoutMap, MAIN_ID, type MapNode } from "../../lib/helperMap";
import { flagText, guess, itemDetail, itemTitle, itemTitleFull, tokensText } from "../../lib/receiptView";
import { compact, formatDuration, percent, plural, share } from "../../lib/usage";
import type { Receipt, ReceiptThread } from "../../lib/types";

const HIDDEN_SHOWN = 8;

/** What a node and everything hanging from it used. */
function withKids(nodes: MapNode[], id: string): number {
  const kids = new Map<string, MapNode[]>();
  for (const n of nodes) if (n.parentId) kids.set(n.parentId, [...(kids.get(n.parentId) ?? []), n]);
  const walk = (at: string): number => (nodes.find((n) => n.id === at)?.tokens ?? 0) + (kids.get(at) ?? []).reduce((s, k) => s + walk(k.id), 0);
  return walk(id);
}

function Facts({ t }: { t: ReceiptThread }) {
  const bits = [plural(t.messages, "message"), plural(t.toolCalls, "call"), t.durationMs > 0 ? `ran ${formatDuration(t.durationMs)}` : ""].filter(Boolean);
  return (
    <div className="slice-facts">
      <ModelChip model={t.model} />
      <span className="min-w-0 text-caption text-ink-2">{bits.join(", ")}</span>
    </div>
  );
}
/**
 * One node's slice of the receipt: what it spent, what that bought, its biggest lines and any
 * flag against it. A "+N" node lists the helpers folded into it instead.
 */
export function HelperSlice({
  receipt,
  nodeId,
  onOpenHelper,
}: {
  receipt: Receipt;
  nodeId: string;
  onOpenHelper: (agentId: string) => void;
}) {
  const nodes = useMemo(() => layoutMap(receipt.threads, { width: 640, height: 400 }, undefined, MAP_BY).nodes, [receipt.threads]);
  const node = nodes.find((n) => n.id === nodeId) ?? nodes.find((n) => n.id === MAIN_ID);
  if (!node) return null;
  const total = receipt.totalTokens;
  const parent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined;
  const subtotal = withKids(nodes, node.id);
  const t = node.thread;
  const used = t
    ? ([
        ["cacheWrite", "Cache writes"],
        ["output", "Output"],
        ["input", "Input"],
      ] as const)
        .map(([k, label]) => ({ key: k, label, tokens: t.tokenKinds[k], usd: t.kinds[k] }))
        .filter((l) => l.tokens > 0)
        .sort((a, b) => b.tokens - a.tokens)
    : [];

  return (
    <aside aria-label={`Slice: ${node.name}`} className="slice">
      <div className="flex items-start gap-2">
        <i aria-hidden="true" className="slice-dot" style={{ background: outcomeColor(node) }} />
        <div className="min-w-0">
          <h3 className="truncate text-lead font-semibold text-ink" title={node.name}>
            {node.name}
          </h3>
          <div className="truncate text-caption text-ink-2">
            {node.kind === "root"
              ? "Where it all started"
              : node.kind === "more"
                ? `Started by ${parent?.name ?? "the main chat"}`
                : [node.outcome ? OUTCOME_LABEL[node.outcome] : "", parent ? `started by ${parent.name}` : ""].filter(Boolean).join(", ")}
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-baseline gap-3">
        <span className="d d-stat tabular-nums text-ink" title={node.usd > 0 ? `${node.name}: ${tokensText(node.tokens)}, ${guess(node.usd)}` : undefined}>
          {compact(node.tokens)}
        </span>
        <span className="text-body text-ink-2">tokens</span>
        <span className="text-body tabular-nums text-ink-2">{`${percent(share(node.tokens, total))} of the chat`}</span>
      </div>
      {subtotal - node.tokens >= 1 && <div className="text-caption tabular-nums text-ink-2">{`${tokensText(subtotal)} with the helpers it started`}</div>}

      {t && <Facts t={t} />}

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

      {t && t.tokens > 0 && (
        <section aria-label="What it used" className="mt-4">
          <h4 className="rcpt-head">What it used</h4>
          <ul>
            {used.map((l) => (
              <li key={l.key} className="rcpt-item" title={`${l.label}: ${tokensText(l.tokens)}, ${guess(l.usd)}`}>
                <span className="text-body text-ink">{l.label}</span>
                <span className="shrink-0 text-body tabular-nums text-ink">{compact(l.tokens)}</span>
              </li>
            ))}
          </ul>
          {t.tokenKinds.cacheRead > 0 && (
            <p className="mt-1 text-caption text-ink-2" title={`Cache reads: ${tokensText(t.tokenKinds.cacheRead)}, ${guess(t.kinds.cacheRead)}`}>
              {`Plus ${compact(t.tokenKinds.cacheRead)} cache reads, listed apart`}
            </p>
          )}
        </section>
      )}

      {t && t.items.length > 0 && (
        <section aria-label="Biggest lines" className="mt-4">
          <h4 className="rcpt-head">Biggest lines</h4>
          <ul>
            {[...t.items].sort((a, b) => b.tokens - a.tokens).slice(0, 2).map((i, n) => (
              <li key={`${i.kind}:${i.tool}:${i.path ?? ""}:${n}`} className="rcpt-item" title={itemTitleFull(i)}>
                <div className="min-w-0">
                  <div className="truncate text-body text-ink">{itemTitle(i)}</div>
                  {itemDetail(i) && <div className="truncate text-caption text-ink-2">{itemDetail(i)}</div>}
                </div>
                <span className="shrink-0 text-body tabular-nums text-ink">{`~${compact(i.tokens)}`}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {t && t.flags.length > 0 && (
        <section aria-label="Worth a look" className="mt-4">
          <h4 className="rcpt-head">Worth a look</h4>
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

      {t?.agentId && (
        <Button className="mt-4" onClick={() => onOpenHelper(t.agentId as string)}>
          Open helper
          <ArrowRight size={14} aria-hidden="true" />
        </Button>
      )}
    </aside>
  );
}
