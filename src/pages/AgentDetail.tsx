import { useMemo } from "react";
import type { ReactNode } from "react";
import { ArrowBendDownRight, ArrowLeft, ChatTeardropText, Clock, Hash, Wrench } from "@phosphor-icons/react";
import { Button, Card } from "../components/controls";
import { Bars } from "../components/charts/Bars";
import { IconMotion } from "../components/IconMotion";
import { Breakdown, ClampText, FileRow, ModelSplit } from "../components/usage/detailParts";
import { AgentAvatar, helperName, ModelChip, OutcomeMark, shownName, TokenFigure, type AvatarLevel } from "../components/usage/helperKit";
import { ErrorBlock, SectionTitle, Skeleton } from "../components/usage/StateBlocks";
import { timelineBars } from "../components/usage/timelineBars";
import { getBackend } from "../lib/ipc";
import { useIntro } from "../lib/motion";
import { useFetched, useLiveReload } from "../lib/useUsage";
import { compact, effortMix, exact, formatDuration, formatWhen, percent, share, topEffort } from "../lib/usage";
import type { Outcome } from "../lib/types";

/** "general-purpose" -> "General purpose", "ui-builder" -> "UI builder". */
export function typeLabel(t: string | null): string {
  if (!t) return "Helper";
  const s = t.replace(/[-_]+/g, " ").trim();
  return helperName(s.charAt(0).toUpperCase() + s.slice(1));
}

/**
 * One helper (subagent) of one session, shortest first: who it is and how it ended, the one figure
 * with its share, three small facts beside it, then what it was asked (a long prompt is cut to
 * three lines until asked for). The charts and tables follow below the fold.
 */
export function AgentDetailView({
  sessionId,
  agentId,
  onBack,
  sessionLabel,
  outcome,
  level = "helper",
}: {
  sessionId: string;
  agentId: string;
  onBack: () => void;
  sessionLabel: string;
  /** How it ended, when the chat's receipt has been read. */
  outcome?: Outcome | null;
  /** A helper started by another helper wears the hollow avatar here too. */
  level?: AvatarLevel;
}) {
  const backend = getBackend();
  const d = useFetched(() => backend.agentDetail(sessionId, agentId), [sessionId, agentId]);
  useLiveReload(d.reload);

  const intro = useIntro(`agent:${sessionId}:${agentId}:share`);
  const bars = useMemo(() => (d.data ? timelineBars(d.data.timeline, d.data.agent.durationMs) : []), [d.data]);

  const back = (
    // A long chat name shortens inside the button; the whole name is in its hover.
    <Button onClick={onBack} className="mb-4 min-w-0 max-w-[min(100%,30rem)]" title={`Back to ${sessionLabel}`}>
      <IconMotion motion="nudge">
        <ArrowLeft />
      </IconMotion>
      <span className="min-w-0 truncate">{`Back to ${sessionLabel}`}</span>
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

  const { agent, byModel, file, prompt, promptTruncated, sessionTokens } = d.data;
  const frac = share(agent.tokens.total, sessionTokens.total);
  // A type that only repeats the name ("verifier", Verifier) is not written twice.
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const type = agent.agentType && !flat(agent.name).startsWith(flat(agent.agentType)) ? typeLabel(agent.agentType) : null;
  const facts: [string, ReactNode, string][] = [
    ["Ran for", <Clock key="i" size={14} aria-hidden="true" />, formatDuration(agent.durationMs)],
    ["Tool calls", <Wrench key="i" size={14} aria-hidden="true" />, exact(agent.toolCalls)],
    ["Messages", <Hash key="i" size={14} aria-hidden="true" />, exact(agent.messages)],
  ];

  return (
    // The page is taller than the fixed-height pane it sits in, so it carries its own bottom gutter:
    // the last card never ends flush with the window's edge.
    <div className="@container pb-[var(--gutter-y)]">
      {back}
      <div className="flex items-center gap-4">
        <AgentAvatar type={agent.agentType} size={48} level={d.data.parentName ? "nested" : level} />
        <div className="min-w-0">
          {/* A name made from the type gets its short forms in capitals; one that was written stays as written. */}
          <h2 className="d d-figure break-words text-ink">{shownName(agent)}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-body text-ink-2">
            {outcome && <OutcomeMark outcome={outcome} />}
            {type && <span title={agent.agentType ?? undefined}>{type}</span>}
            {d.data.parentName && (
              <span className="inline-flex min-w-0 max-w-72 items-center gap-1" title={`Started by ${d.data.parentName}`}>
                <ArrowBendDownRight size={14} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{`Started by ${d.data.parentName}`}</span>
              </span>
            )}
            <span className="whitespace-nowrap">{formatWhen(agent.startedAt)}</span>
            <span className="inline-flex flex-wrap items-center gap-2" title={(agent.efforts?.length ?? 0) > 1 ? `Reasoning effort: ${effortMix(agent.efforts)}` : undefined}>
              {agent.models.map((m) => (
                <ModelChip key={m} model={m} effort={topEffort(byModel.find((b) => b.model === m)?.efforts)} />
              ))}
            </span>
          </div>
        </div>
      </div>

      <Card className="mt-6 grid grid-cols-1 items-center gap-x-8 gap-y-5 px-6 py-5 @2xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="text-caption font-medium text-ink-2">This helper used</div>
          <div className="mt-2">
            <TokenFigure tokens={agent.tokens.total} cost={agent.cost} id={`agent:${sessionId}:${agentId}:tokens`} className="d d-hero text-ink" />
          </div>
          <div className="mt-4 max-w-[28rem]">
            <div className={`share-bar${intro ? " intro" : ""}`} role="img" aria-label={`${percent(frac)} of the session's tokens`}>
              <i style={{ width: `${Math.max(frac > 0 ? 2 : 0, frac * 100)}%` }} />
            </div>
            <p
              className="mt-2 text-body text-ink-2"
              title={`Counted once, inside the chat's total.${agent.tokens.cacheRead > 0 ? ` Plus ${compact(agent.tokens.cacheRead)} cache reads, counted apart.` : ""}`}
            >
              <span className="font-medium text-ink">{percent(frac)}</span>
              {" of the chat"}
            </p>
          </div>
        </div>
        {/* Three small facts beside the figure: below it in a narrow window, a column beside it in a wide one. */}
        <dl className="helper-facts">
          {facts.map(([label, icon, value]) => (
            <div key={label}>
              <dt className="flex items-center gap-2 whitespace-nowrap text-caption font-medium text-ink-2">
                {icon}
                {label}
              </dt>
              <dd className="d d-figure mt-0.5 whitespace-nowrap text-ink">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <section aria-label="What it was asked" className="mt-8">
        <SectionTitle>What it was asked</SectionTitle>
        <Card className="px-5 py-4">
          {prompt ? (
            <>
              <div className="flex gap-3">
                <ChatTeardropText size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-accent-text" />
                <ClampText text={prompt} className="selectable whitespace-pre-wrap break-words text-body text-ink" />
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
            <Bars id={`agent:${sessionId}:${agentId}:bars`} data={bars} label="Tokens through the helper's run" formatTick={compact} />
          </Card>
        </section>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 @3xl:grid-cols-2">
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
          {/* Whose file it is, never its path: the path is the hover and one press away on the clipboard. */}
          <Card className="px-1">
            <FileRow as="div" who="This helper's saved chat" path={file.path} missing={file.missing} />
          </Card>
        </section>
      )}
    </div>
  );
}
