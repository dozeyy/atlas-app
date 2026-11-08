import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ChatsCircle } from "@phosphor-icons/react";
import { Button, Card } from "../components/controls";
import { BarChart } from "../components/usage/BarChart";
import type { BarDatum } from "../components/usage/BarChart";
import { CostText } from "../components/usage/CostText";
import { ErrorBlock, SectionTitle, Skeleton } from "../components/usage/StateBlocks";
import { getBackend } from "../lib/ipc";
import { useFetched, useLiveReload } from "../lib/useUsage";
import {
  binEvenly,
  compact,
  exact,
  formatDuration,
  formatUsd,
  formatWhen,
  headline,
  modelLabel,
  plural,
} from "../lib/usage";
import type { Cost, TranscriptItem, Tokens } from "../lib/types";

const agentName = (id: string | null) => (id === null ? "Main conversation" : `Subagent ${id.slice(0, 8)}`);

function Stat({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card className="px-5 py-4">
      <div className="text-caption font-medium text-ink-2">{label}</div>
      <div className="mt-1 text-subtitle font-semibold tabular-nums text-ink">{children}</div>
      {sub && <div className="mt-1 text-caption text-ink-2">{sub}</div>}
    </Card>
  );
}

function Breakdown({ t }: { t: Tokens }) {
  const rows: [string, number, string?][] = [
    ["Input", t.input],
    ["Output", t.output],
    ["Cache writes, 5-minute", t.cacheWrite5m],
    ["Cache writes, 1-hour", t.cacheWrite1h],
    ["Cache reads", t.cacheRead, "Counted apart, not in the total above"],
  ];
  return (
    <Card>
      <dl className="divide-y divide-line">
        {rows.map(([name, value, note]) => (
          <div key={name} className="flex items-baseline justify-between gap-4 px-5 py-2.5">
            <dt className="text-body text-ink">
              {name}
              {note && <span className="ml-2 text-caption text-ink-2">{note}</span>}
            </dt>
            <dd className="text-body tabular-nums text-ink">{exact(value)}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function SplitTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string;
  rows: { key: string; name: string; messages?: number; tokens: Tokens; cost: Cost }[];
}) {
  return (
    <Card className="overflow-hidden">
      <table className="w-full text-body">
        <caption className="sr-only">{caption}</caption>
        <thead className="text-left text-caption text-ink-2">
          <tr className="border-b border-line">
            <th scope="col" className="px-5 py-2 font-medium">{head}</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Tokens</th>
            <th scope="col" className="px-5 py-2 text-right font-medium">Est. cost</th>
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line last:border-b-0">
              <th scope="row" className="px-5 py-2 text-left font-normal text-ink">
                {r.name}
                {r.messages !== undefined && <span className="ml-2 text-caption text-ink-2">{plural(r.messages, "message")}</span>}
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

function Conversation({ sessionId }: { sessionId: string }) {
  const backend = getBackend();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = (from: string | null) => {
    setBusy(true);
    setError(null);
    backend
      .sessionTranscript(sessionId, from, 50)
      .then((p) => {
        setItems((cur) => (from ? [...cur, ...p.items] : p.items));
        setCursor(p.nextCursor);
        setMissing(p.sourceMissing);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    setOpen(false);
    setItems([]);
    setCursor(null);
    setMissing(false);
    setError(null);
  }, [sessionId]);

  return (
    <section aria-label="Conversation" className="mt-8">
      <SectionTitle>Conversation</SectionTitle>
      {!open ? (
        <Card className="flex items-center justify-between gap-4 px-5 py-4">
          <p className="text-body text-ink-2">
            Read the messages in this session. They are read from your files when you ask and are never copied anywhere.
          </p>
          <Button
            variant="primary"
            onClick={() => {
              setOpen(true);
              load(null);
            }}
          >
            <ChatsCircle size={14} aria-hidden="true" />
            Show conversation
          </Button>
        </Card>
      ) : (
        <Card>
          {missing ? (
            <p className="px-5 py-4 text-body text-ink-2">The file for this session is no longer on disk, so its messages cannot be shown.</p>
          ) : error ? (
            <div className="px-5 py-4">
              <p role="alert" className="text-body text-danger">{error}</p>
              <Button className="mt-3" onClick={() => load(cursor)}>Try again</Button>
            </div>
          ) : items.length === 0 && !busy ? (
            <p className="px-5 py-4 text-body text-ink-2">There are no readable messages in this session.</p>
          ) : (
            <ol className="divide-y divide-line">
              {items.map((m, i) => (
                <li key={i} className="px-5 py-3">
                  <div className="flex items-baseline gap-3 text-caption text-ink-2">
                    <span className="font-medium text-ink">{m.role === "user" ? "You" : "Claude"}</span>
                    {m.agentId && <span>{agentName(m.agentId)}</span>}
                    {m.ts !== null && <span>{formatWhen(m.ts)}</span>}
                  </div>
                  <p className="selectable mt-1 whitespace-pre-wrap break-words text-body text-ink">{m.text}</p>
                  {m.truncated && <p className="mt-1 text-caption text-ink-2">Shortened. The full message is in the file.</p>}
                </li>
              ))}
            </ol>
          )}
          {busy && (
            <div role="status" aria-label="Loading messages" className="px-5 py-3">
              <Skeleton className="h-4 w-2/3" />
            </div>
          )}
          {cursor && !busy && !error && (
            <div className="border-t border-line px-5 py-3">
              <Button onClick={() => load(cursor)}>Show more messages</Button>
            </div>
          )}
        </Card>
      )}
    </section>
  );
}

export function SessionDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const backend = getBackend();
  const d = useFetched(() => backend.sessionDetail(id), [id]);
  useLiveReload(d.reload);

  const bins: BarDatum[] = useMemo(() => {
    const tl = d.data?.timeline ?? [];
    if (tl.length === 0) return [];
    const dur = d.data?.row.durationMs ?? 0;
    const longRun = dur > 24 * 3_600_000;
    const withSeconds = dur < 10 * 60_000; // a short run needs seconds or neighbouring bars share a label
    return binEvenly(tl, 48).map((group, i) => {
      const tokens = group.reduce((s, m) => s + headline(m.tokens), 0);
      const usd = group.reduce((s, m) => s + (m.cost.usd ?? 0), 0);
      const first = group[0].ts;
      const hhmm = new Date(first).toLocaleTimeString(
        "en-US",
        withSeconds ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false } : { hour: "2-digit", minute: "2-digit", hour12: false },
      );
      return {
        key: String(i),
        value: tokens,
        axis: longRun ? new Date(first).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : hhmm,
        title: `${formatWhen(first)}, ${plural(group.length, "message")}`,
        valueText: compact(tokens),
        detail: `tokens, ${formatUsd(usd)} estimated`,
      };
    });
  }, [d.data]);

  const back = (
    <Button onClick={onBack} className="mb-4">
      <ArrowLeft size={14} aria-hidden="true" />
      All sessions
    </Button>
  );

  if (d.loading && !d.data) {
    return (
      <div role="status" aria-label="Loading the session">
        {back}
        <Skeleton className="h-8 w-80" />
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      </div>
    );
  }
  if (d.error) {
    return (
      <>
        {back}
        <ErrorBlock title="Could not load this session" message={d.error} onRetry={() => d.reload(false)} />
      </>
    );
  }
  if (!d.data) {
    return (
      <>
        {back}
        <ErrorBlock title="This session is not here any more" message="It is no longer in the usage cache. Go back to the list to see what is left." />
      </>
    );
  }

  const { row, byModel, byAgent, files, claudeCodeCostUsd } = d.data;
  const total = row.tokens;

  return (
    <div>
      {back}
      <h2 className="text-subtitle font-semibold text-ink">{row.title?.trim() || "Untitled session"}</h2>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-body text-ink-2">
        <span className="font-medium text-ink">{row.projectName}</span>
        <code className="selectable break-all">{row.projectPath}</code>
        <span>{formatWhen(row.startedAt)}</span>
        <span>{formatDuration(row.durationMs)}</span>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Tokens"
          sub={total.cacheRead > 0 ? `plus ${compact(total.cacheRead)} cache reads` : undefined}
        >
          <span title={exact(headline(total))}>{compact(headline(total))}</span>
        </Stat>
        <Stat
          label="Estimated cost"
          sub={claudeCodeCostUsd !== null ? `Claude Code showed ${formatUsd(claudeCodeCostUsd)} for this session` : "An estimate from the price list"}
        >
          <CostText cost={row.cost} />
        </Stat>
        <Stat
          label="Messages"
          sub={row.subagentMessages > 0 ? `${exact(row.subagentMessages)} from subagents` : undefined}
        >
          {exact(row.messages)}
        </Stat>
        <Stat label={row.models.length === 1 ? "Model" : "Models"}>
          <span className="text-lead">{row.models.map(modelLabel).join(", ") || "None"}</span>
        </Stat>
      </div>

      {bins.length > 0 && (
        <section aria-label="Tokens through the session" className="mt-8">
          <SectionTitle>Through the session</SectionTitle>
          <Card className="px-5 py-4">
            <BarChart
              data={bins}
              label="Tokens through the session"
              formatTick={compact}
              fallback={{ title: "Whole session", valueText: compact(headline(total)), detail: `tokens in ${plural(row.messages, "message")}` }}
            />
          </Card>
        </section>
      )}

      <section aria-label="Token breakdown" className="mt-8">
        <SectionTitle>Token breakdown</SectionTitle>
        <Breakdown t={total} />
      </section>

      {byModel.length > 1 && (
        <section aria-label="By model" className="mt-8">
          <SectionTitle>By model</SectionTitle>
          <SplitTable
            caption="Usage by model"
            head="Model"
            rows={byModel.map((m) => ({ key: m.model, name: modelLabel(m.model), tokens: m.tokens, cost: m.cost }))}
          />
        </section>
      )}

      {byAgent.length > 1 && (
        <section aria-label="By agent" className="mt-8">
          <SectionTitle>Main conversation and subagents</SectionTitle>
          <SplitTable
            caption="Usage by agent"
            head="Agent"
            rows={byAgent.map((a) => ({ key: a.agentId ?? "main", name: agentName(a.agentId), messages: a.messages, tokens: a.tokens, cost: a.cost }))}
          />
        </section>
      )}

      <Conversation sessionId={id} />

      <section aria-label="Files" className="mt-8">
        <SectionTitle>Files</SectionTitle>
        <Card>
          <ul className="divide-y divide-line">
            {files.map((f) => (
              <li key={f.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
                <code className="selectable min-w-0 flex-1 break-all text-ink">{f.path}</code>
                {f.isSubagent && <span className="rounded-full border border-line px-2 text-caption text-ink-2">subagent</span>}
                {f.missing && <span className="rounded-full border border-line px-2 text-caption text-ink-2">removed from disk</span>}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
