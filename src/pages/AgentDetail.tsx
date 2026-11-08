import { useMemo } from "react";
import { ArrowBendDownRight, ArrowLeft, ChatTeardropText, Clock, Hash, Wrench } from "@phosphor-icons/react";
import { Button, Card } from "../components/controls";
import { BarChart } from "../components/usage/BarChart";
import { Breakdown, ModelSplit, Stat } from "../components/usage/detailParts";
import { AgentAvatar, CostTicker, ModelChip, Sparkline } from "../components/usage/helperKit";
import { ErrorBlock, SectionTitle, Skeleton } from "../components/usage/StateBlocks";
import { cumulativeSpend, timelineBars } from "../components/usage/timelineBars";
import { getBackend } from "../lib/ipc";
import { useFetched, useLiveReload } from "../lib/useUsage";
import { compact, exact, formatDuration, formatWhen, headline, percent, plural, share } from "../lib/usage";

/** "general-purpose" -> "General purpose". */
export function typeLabel(t: string | null): string {
  if (!t) return "Helper";
  const s = t.replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** One helper (subagent) of one session: what it was asked and what it spent. */
export function AgentDetailView({
  sessionId,
  agentId,
  onBack,
  sessionLabel,
}: {
  sessionId: string;
  agentId: string;
  onBack: () => void;
  sessionLabel: string;
}) {
  const backend = getBackend();
  const d = useFetched(() => backend.agentDetail(sessionId, agentId), [sessionId, agentId]);
  useLiveReload(d.reload);

  const bars = useMemo(() => (d.data ? timelineBars(d.data.timeline, d.data.agent.durationMs) : []), [d.data]);
  const spend = useMemo(() => (d.data ? cumulativeSpend(d.data.timeline) : []), [d.data]);

  const back = (
    <Button onClick={onBack} className="mb-4">
      <ArrowLeft size={14} aria-hidden="true" />
      {`Back to ${sessionLabel}`}
    </Button>
  );

  if (d.loading && !d.data) {
    return (
      <div role="status" aria-label="Loading the helper">
        {back}
        <Skeleton className="h-10 w-80" />
        <Skeleton className="mt-6 h-32" />
      </div>
    );
  }
  if (d.error) {
    return (
      <>
        {back}
        <ErrorBlock title="Could not load this helper" message={d.error} onRetry={() => d.reload(false)} />
      </>
    );
  }
  if (!d.data) {
    return (
      <>
        {back}
        <ErrorBlock title="This helper is not here any more" message="It is no longer in the usage cache. Go back to the session to see who is left." />
      </>
    );
  }

  const { agent, byModel, file, prompt, promptTruncated, sessionCost } = d.data;
  const frac = share(agent.cost.usd ?? 0, sessionCost.usd ?? 0);

  return (
    <div>
      {back}
      <div className="flex items-start gap-4">
        <AgentAvatar type={agent.agentType} size={48} />
        <div className="min-w-0">
          <h2 className="text-subtitle font-semibold text-ink">{agent.name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-ink-2">
            <span>{typeLabel(agent.agentType)}</span>
            {d.data.parentName && (
              <span className="inline-flex items-center gap-1">
                <ArrowBendDownRight size={14} aria-hidden="true" />
                {`Started by ${d.data.parentName}`}
              </span>
            )}
            <span>{formatWhen(agent.startedAt)}</span>
            {agent.models.map((m) => (
              <ModelChip key={m} model={m} />
            ))}
          </div>
        </div>
      </div>

      <Card className="mt-6 grid grid-cols-1 gap-x-8 gap-y-4 px-6 py-5 md:grid-cols-[minmax(0,1fr)_minmax(0,18rem)]">
        <div>
          <div className="text-caption font-medium text-ink-2">This helper spent about</div>
          <div className="mt-1 text-display font-semibold tracking-[-0.01em] text-ink">
            <CostTicker cost={agent.cost} />
          </div>
          <div className="mt-3 max-w-[28rem]">
            <div role="img" aria-label={`${percent(frac)} of the session's spend`} className="h-2.5 overflow-hidden rounded-full bg-raised">
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(frac > 0 ? 2 : 0, frac * 100)}%` }} />
            </div>
            <p className="mt-2 text-body text-ink-2">
              <span className="font-medium text-ink">{percent(frac)}</span>
              {" of this session's estimated cost. It is counted once, inside the session total."}
            </p>
          </div>
        </div>
        {spend.length > 1 && (
          <div className="flex flex-col justify-end">
            <div className="mb-1 text-caption font-medium text-ink-2">Spend as it ran</div>
            <Sparkline values={spend} className="h-14" />
          </div>
        )}
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Tokens"
          sub={agent.tokens.cacheRead > 0 ? `plus ${compact(agent.tokens.cacheRead)} cache reads` : undefined}
        >
          <span title={exact(headline(agent.tokens))}>{compact(headline(agent.tokens))}</span>
        </Stat>
        <Stat label="Ran for" icon={<Clock size={14} aria-hidden="true" />}>
          {formatDuration(agent.durationMs)}
        </Stat>
        <Stat label="Tool calls" icon={<Wrench size={14} aria-hidden="true" />}>
          {exact(agent.toolCalls)}
        </Stat>
        <Stat label="Messages" icon={<Hash size={14} aria-hidden="true" />}>
          {exact(agent.messages)}
        </Stat>
      </div>

      <section aria-label="What it was asked" className="mt-8">
        <SectionTitle>What it was asked</SectionTitle>
        <Card className="px-5 py-4">
          {prompt ? (
            <>
              <div className="flex gap-3">
                <ChatTeardropText size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
                <p className="selectable whitespace-pre-wrap break-words text-body text-ink">{prompt}</p>
              </div>
              {promptTruncated && <p className="mt-2 text-caption text-ink-2">Shortened. The whole prompt is in the file.</p>}
            </>
          ) : (
            <p className="text-body text-ink-2">
              {file?.missing
                ? "The file for this helper is no longer on disk, so its prompt cannot be shown."
                : "No prompt could be found for this helper."}
            </p>
          )}
        </Card>
      </section>

      {bars.length > 0 && (
        <section aria-label="Tokens through the run" className="mt-8">
          <SectionTitle>Through its run</SectionTitle>
          <Card className="px-5 py-4">
            <BarChart
              data={bars}
              label="Tokens through the helper's run"
              formatTick={compact}
              fallback={{ title: "Whole run", valueText: compact(headline(agent.tokens)), detail: `tokens in ${plural(agent.messages, "message")}` }}
            />
          </Card>
        </section>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-2">
        <section aria-label="Token breakdown">
          <SectionTitle>Token breakdown</SectionTitle>
          <Breakdown t={agent.tokens} />
        </section>
        {byModel.length > 0 && (
          <section aria-label="By model">
            <SectionTitle>By model</SectionTitle>
            <ModelSplit rows={byModel} />
          </section>
        )}
      </div>

      {file && (
        <section aria-label="File" className="mt-8">
          <SectionTitle>File</SectionTitle>
          <Card className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
            <code className="selectable min-w-0 flex-1 break-all text-ink">{file.path}</code>
            {file.missing && <span className="rounded-full border border-line px-2 text-caption text-ink-2">removed from disk</span>}
          </Card>
        </section>
      )}
    </div>
  );
}
