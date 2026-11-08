import { useEffect, useMemo, useState } from "react";
import { ArrowBendDownRight, ArrowLeft, CaretRight, ChatsCircle, Clock, Hash, UsersThree, Wrench } from "@phosphor-icons/react";
import { Button, Card, SegmentedControl } from "../components/controls";
import { Bars } from "../components/charts/Bars";
import { Ridge } from "../components/charts/Ridge";
import { StackBar } from "../components/charts/StackBar";
import { IconMotion } from "../components/IconMotion";
import { CostText } from "../components/usage/CostText";
import { Breakdown, ModelSplit, Stat } from "../components/usage/detailParts";
import { AgentAvatar, CostFigure, ModelChip, sessionName } from "../components/usage/helperKit";
import { ErrorBlock, SectionTitle, Skeleton } from "../components/usage/StateBlocks";
import { hasClearPeak, spendRidge, timelineBars } from "../components/usage/timelineBars";
import { getBackend } from "../lib/ipc";
import { helperTree, type HelperNode } from "../lib/helperTree";
import { useIntro } from "../lib/motion";
import { useFetched, useLiveReload } from "../lib/useUsage";
import { compact, exact, formatDuration, formatUsd, formatWhen, headline, percent, plural, share } from "../lib/usage";
import { AgentDetailView, typeLabel } from "./AgentDetail";
import type { AgentSummary, TranscriptItem } from "../lib/types";

/** One helper as a card: who it was, what it spent, how much of the session that is. */
function HelperCard({
  agent,
  parentName,
  sessionUsd,
  index,
  onOpen,
}: {
  agent: AgentSummary;
  parentName: string | null;
  sessionUsd: number;
  index: number;
  onOpen: (id: string) => void;
}) {
  const frac = share(agent.cost.usd ?? 0, sessionUsd);
  return (
    <Card onClick={() => onOpen(agent.agentId)} className="flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <AgentAvatar type={agent.agentType} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-body font-semibold text-ink">{agent.name}</div>
          <div className="flex min-w-0 items-center gap-1 truncate text-caption text-ink-2">
            {parentName ? (
              <>
                <ArrowBendDownRight size={12} aria-hidden="true" className="shrink-0" />
                <span className="truncate">{`Started by ${parentName}`}</span>
              </>
            ) : (
              <span>{typeLabel(agent.agentType)}</span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="d d-small text-ink">
            <CostText cost={agent.cost} />
          </div>
          <div className="text-caption tabular-nums text-ink-2" title={`${exact(headline(agent.tokens))} tokens`}>
            {compact(headline(agent.tokens))} tokens
          </div>
        </div>
      </div>
      <div>
        <div className="share-bar" role="img" aria-label={`${percent(frac)} of the session's spend`}>
          <i style={{ width: `${Math.max(frac > 0 ? 2 : 0, frac * 100)}%`, ["--i" as string]: Math.min(index, 12) }} />
        </div>
        <div className="mt-1 text-caption text-ink-2">{`${percent(frac)} of the session`}</div>
      </div>
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-ink-2">
        <ModelChip model={agent.model} />
        <span className="inline-flex items-center gap-1">
          <Clock size={12} aria-hidden="true" />
          {formatDuration(agent.durationMs)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Wrench size={12} aria-hidden="true" />
          {plural(agent.toolCalls, "tool call")}
        </span>
        <CaretRight size={12} aria-hidden="true" className="row-caret ml-auto" />
      </div>
    </Card>
  );
}

function HelperBranch({
  node,
  names,
  sessionUsd,
  onOpen,
}: {
  node: HelperNode;
  names: Map<string, string>;
  sessionUsd: number;
  onOpen: (id: string) => void;
}) {
  const a = node.agent;
  return (
    <>
      <HelperCard
        agent={a}
        parentName={a.parentAgentId ? (names.get(a.parentAgentId) ?? null) : null}
        sessionUsd={sessionUsd}
        index={node.index}
        onOpen={onOpen}
      />
      {node.kids.length > 0 && (
        <ul className="helper-kids">
          {node.kids.map((k) => (
            <li key={k.agent.agentId} className="helper-kid">
              <HelperBranch node={k} names={names} sessionUsd={sessionUsd} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * The helper cards. Started order with nesting reads as a tree in one column (the rail needs a
 * straight run of cards); otherwise two columns, and an odd last card takes the whole row.
 */
function HelperList({
  agents,
  order,
  sessionId,
  sessionUsd,
  names,
  onOpen,
}: {
  agents: AgentSummary[];
  order: "started" | "spend";
  sessionId: string;
  sessionUsd: number;
  names: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  const intro = useIntro(`helpers:${sessionId}`);
  const roots = useMemo(() => helperTree(agents), [agents]);
  const nested = order === "started" && roots.some((r) => r.kids.length > 0);
  const flat = order === "spend" ? [...agents].sort((a, b) => (b.cost.usd ?? 0) - (a.cost.usd ?? 0)) : agents;

  if (nested) {
    return (
      <ul className={`grid grid-cols-1 gap-3${intro ? " intro" : ""}`}>
        {roots.map((r) => (
          <li key={r.agent.agentId}>
            <HelperBranch node={r} names={names} sessionUsd={sessionUsd} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className={`grid grid-cols-1 gap-3 @2xl:grid-cols-2${intro ? " intro" : ""}`}>
      {flat.map((a, i) => (
        <li key={a.agentId} className="@2xl:[&:last-child:nth-child(odd)]:col-span-2">
          <HelperCard
            agent={a}
            parentName={a.parentAgentId ? (names.get(a.parentAgentId) ?? null) : null}
            sessionUsd={sessionUsd}
            index={i}
            onOpen={onOpen}
          />
        </li>
      ))}
    </ul>
  );
}

function Conversation({ sessionId, names }: { sessionId: string; names: Map<string, string> }) {
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
                    {m.agentId && <span>{names.get(m.agentId) ?? "A helper"}</span>}
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
  const [agentId, setAgentId] = useState<string | null>(null);
  const [order, setOrder] = useState<"started" | "spend">("started");
  const [scope, setScope] = useState<"all" | "main">("all");

  useEffect(() => {
    setAgentId(null);
    setScope("all");
  }, [id]);
  useEffect(() => {
    document.querySelector("main")?.scrollTo?.({ top: 0 });
  }, [agentId]);

  const bins = useMemo(() => timelineBars(d.data?.timeline ?? [], d.data?.row.durationMs ?? 0), [d.data]);
  const spend = useMemo(() => spendRidge(d.data?.timeline ?? [], d.data?.row.durationMs ?? 0), [d.data]);

  const back = (
    <Button onClick={onBack} className="mb-4">
      <IconMotion motion="nudge">
        <ArrowLeft />
      </IconMotion>
      All sessions
    </Button>
  );

  if (agentId && d.data) {
    return (
      <AgentDetailView
        sessionId={id}
        agentId={agentId}
        sessionLabel={sessionName(d.data.row)}
        onBack={() => setAgentId(null)}
      />
    );
  }

  if (d.loading && !d.data) {
    return (
      <div role="status" aria-label="Loading the session">
        {back}
        <Skeleton className="h-8 w-80" />
        <Skeleton className="mt-6 h-36" />
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-4">
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

  const { row, byModel, agents, main, files, claudeCodeCostUsd } = d.data;
  const total = row.tokens;
  const name = sessionName(row);
  const sessionUsd = row.cost.usd ?? 0;
  const mainUsd = main.cost.usd ?? 0;
  const helperUsd = agents.reduce((s, a) => s + (a.cost.usd ?? 0), 0);
  const toolCalls = main.toolCalls + agents.reduce((s, a) => s + a.toolCalls, 0);
  const names = new Map(agents.map((a) => [a.agentId, a.name]));

  return (
    <div className="@container">
      {back}
      <h2 className="d d-figure break-words text-ink">{name}</h2>
      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-ink-2">
        <span className="font-medium text-ink">{row.projectName}</span>
        <code className="selectable break-all">{row.projectPath}</code>
        <span>{formatWhen(row.startedAt)}</span>
        <span>{formatDuration(row.durationMs)}</span>
        {row.models.map((m) => (
          <ModelChip key={m} model={m} />
        ))}
      </div>

      <Card className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 px-6 py-5 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <div className="min-w-0">
          <div className="text-caption font-medium text-ink-2">This session cost about</div>
          <div className="mt-2">
            <CostFigure cost={row.cost} id={`session:${id}:cost`} className="d d-hero text-ink" />
          </div>
          <p className="mt-2 text-body text-ink-2">
            {claudeCodeCostUsd !== null ? `Claude Code showed ${formatUsd(claudeCodeCostUsd)} for this session.` : "An estimate from the price list."}
          </p>
          {agents.length > 0 && (
            <div className="mt-4 max-w-[34rem]">
              <StackBar
                id={`session:${id}:split`}
                label="Who spent it: the main conversation and its helpers"
                items={[
                  {
                    key: "main",
                    label: "You and Claude",
                    value: mainUsd,
                    tone: 2,
                    right: formatUsd(mainUsd),
                    share: percent(share(mainUsd, sessionUsd)),
                  },
                  {
                    key: "helpers",
                    label: plural(agents.length, "helper"),
                    value: helperUsd,
                    tone: 1,
                    right: formatUsd(helperUsd),
                    share: percent(share(helperUsd, sessionUsd)),
                  },
                ]}
              />
            </div>
          )}
        </div>
        {spend.length > 1 && (
          <div className="flex min-w-0 flex-col justify-end">
            <div className="mb-1 text-caption font-medium text-ink-2">Spend as it ran</div>
            <Ridge
              id={`session:${id}:spend`}
              data={spend}
              label="Spend as it ran"
              height={132}
              summit={hasClearPeak(spend.map((s) => s.value))}
            />
          </div>
        )}
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-4 @3xl:grid-cols-4">
        <Stat label="Tokens" sub={total.cacheRead > 0 ? `plus ${compact(total.cacheRead)} cache reads` : undefined}>
          <span title={exact(headline(total))}>{compact(headline(total))}</span>
        </Stat>
        <Stat
          label="Messages"
          icon={<Hash size={14} aria-hidden="true" />}
          sub={row.subagentMessages > 0 ? `${exact(row.subagentMessages)} from helpers` : undefined}
        >
          {exact(row.messages)}
        </Stat>
        <Stat label="Tool calls" icon={<Wrench size={14} aria-hidden="true" />}>
          {exact(toolCalls)}
        </Stat>
        <Stat label="Helpers" icon={<UsersThree size={14} aria-hidden="true" />} sub={agents.length === 0 ? "Just you and Claude" : undefined}>
          {exact(agents.length)}
        </Stat>
      </div>

      {agents.length > 0 ? (
        <section aria-label="Helpers" className="mt-8">
          <SectionTitle
            aside={
              <SegmentedControl
                label="Order helpers by"
                value={order}
                onChange={setOrder}
                options={[
                  { value: "started", label: "Started" },
                  { value: "spend", label: "Spend" },
                ]}
              />
            }
          >
            {`${plural(agents.length, "helper")} ran in this session`}
          </SectionTitle>
          <HelperList agents={agents} order={order} sessionId={id} sessionUsd={sessionUsd} names={names} onOpen={setAgentId} />
        </section>
      ) : (
        <p className="mt-6 text-body text-ink-2">No helpers were started in this session. It was all the main conversation.</p>
      )}

      {bins.length > 0 && (
        <section aria-label="Tokens through the session" className="mt-8">
          <SectionTitle>Through the session</SectionTitle>
          <Card className="px-5 py-4">
            <Bars id={`session:${id}:bars`} data={bins} label="Tokens through the session" formatTick={compact} />
          </Card>
        </section>
      )}

      <div className="mt-8 grid grid-cols-1 gap-8 @3xl:grid-cols-2">
        <section aria-label="Token breakdown">
          <SectionTitle
            aside={
              agents.length > 0 ? (
                <SegmentedControl
                  label="Count tokens for"
                  value={scope}
                  onChange={setScope}
                  options={[
                    { value: "all", label: "With helpers" },
                    { value: "main", label: "Main only" },
                  ]}
                />
              ) : undefined
            }
          >
            Token breakdown
          </SectionTitle>
          <Breakdown t={scope === "main" ? main.tokens : total} />
        </section>
        {byModel.length > 1 && (
          <section aria-label="By model">
            <SectionTitle>By model</SectionTitle>
            <ModelSplit rows={byModel} />
          </section>
        )}
      </div>

      <Conversation sessionId={id} names={names} />

      <section aria-label="Files" className="mt-8">
        <SectionTitle>Files</SectionTitle>
        <Card>
          <ul className="divide-y divide-line">
            {files.map((f) => (
              <li key={f.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5">
                <code className="selectable min-w-0 flex-1 break-all text-ink">{f.path}</code>
                {f.isSubagent && <span className="rounded-full border border-line px-2 text-caption text-ink-2">helper</span>}
                {f.missing && <span className="rounded-full border border-line px-2 text-caption text-ink-2">removed from disk</span>}
              </li>
            ))}
          </ul>
        </Card>
      </section>
    </div>
  );
}
