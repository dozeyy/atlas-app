import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowBendDownRight, ArrowLeft, CaretRight, ChatsCircle, Clock, Hash, UsersThree, Wrench } from "@phosphor-icons/react";
import { Button, Card, SegmentedControl } from "../components/controls";
import { Bars } from "../components/charts/Bars";
import { Ridge } from "../components/charts/Ridge";
import { IconMotion } from "../components/IconMotion";
import { CostText } from "../components/usage/CostText";
import { Breakdown, ModelSplit, Stat } from "../components/usage/detailParts";
import { HelperMap } from "../components/usage/HelperMap";
import { HelperSlice } from "../components/usage/HelperSlice";
import { AgentAvatar, ModelChip, ModelDots, sessionName, TokenFigure } from "../components/usage/helperKit";
import { ReceiptPane } from "../components/usage/ReceiptPane";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { hasClearPeak, spendRidge, timelineBars } from "../components/usage/timelineBars";
import { getBackend } from "../lib/ipc";
import { helperTree, type HelperNode } from "../lib/helperTree";
import { MAIN_ID } from "../lib/helperMap";
import { useIntro } from "../lib/motion";
import { useFetched, useLiveReload } from "../lib/useUsage";
import { compact, exact, formatDuration, formatUsd, formatWhen, headline, percent, plural, share } from "../lib/usage";
import { AgentDetailView, typeLabel } from "./AgentDetail";
import type { AgentSummary, TranscriptItem } from "../lib/types";

type Tab = "receipt" | "helpers" | "messages" | "details";

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
    <section aria-label="Conversation" className="flex h-full min-h-0 flex-col">
      {!open ? (
        <Card className="flex items-center justify-between gap-4 px-5 py-4">
          <p className="text-body text-ink-2">Read from your files only when you ask. Nothing is copied anywhere.</p>
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
        <Card className="flex min-h-0 flex-1 flex-col">
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
            <ol className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
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
  // The receipt reads the chat's files once and is then kept, so it is not reloaded with every
  // tick: only when the chat's cost itself moved.
  const receipt = useFetched(() => backend.sessionReceipt(id), [id]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("receipt");
  const [view, setView] = useState<"map" | "list">("map");
  const [order, setOrder] = useState<"started" | "spend">("started");
  const [scope, setScope] = useState<"all" | "main">("all");
  const [picked, setPicked] = useState<string>(MAIN_ID);
  const [visitedMessages, setVisitedMessages] = useState(false);
  const costSeen = useRef<number | null>(null);

  useEffect(() => {
    setAgentId(null);
    setScope("all");
    setTab("receipt");
    setView("map");
    setPicked(MAIN_ID);
    setVisitedMessages(false);
    costSeen.current = null;
  }, [id]);
  useEffect(() => {
    document.querySelector("main")?.scrollTo?.({ top: 0 });
  }, [agentId]);

  const costNow = d.data?.row.cost.usd ?? null;
  const reloadReceipt = receipt.reload;
  useEffect(() => {
    if (costNow !== null && costSeen.current !== null && Math.abs(costNow - costSeen.current) > 0.005) reloadReceipt(true);
    costSeen.current = costNow;
  }, [costNow, reloadReceipt]);

  const bins = useMemo(() => timelineBars(d.data?.timeline ?? [], d.data?.row.durationMs ?? 0), [d.data]);
  const spend = useMemo(() => spendRidge(d.data?.timeline ?? [], d.data?.row.durationMs ?? 0), [d.data]);

  const back = (
    <Button onClick={onBack} className="shrink-0">
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
        <div className="mb-4">{back}</div>
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
        <div className="mb-4">{back}</div>
        <ErrorBlock title="Could not load this session" message={d.error} onRetry={() => d.reload(false)} />
      </>
    );
  }
  if (!d.data) {
    return (
      <>
        <div className="mb-4">{back}</div>
        <ErrorBlock title="This session is not here any more" message="It is no longer in the usage cache. Go back to the list to see what is left." />
      </>
    );
  }

  const { row, byModel, agents, main, files, claudeCodeCostUsd } = d.data;
  const total = row.tokens;
  const name = sessionName(row);
  const sessionUsd = row.cost.usd ?? 0;
  const toolCalls = main.toolCalls + agents.reduce((s, a) => s + a.toolCalls, 0);
  const names = new Map(agents.map((a) => [a.agentId, a.name]));
  const hasHelpers = agents.length > 0;
  const shownTab: Tab = tab === "helpers" && !hasHelpers ? "receipt" : tab;

  const choose = (next: Tab) => {
    setTab(next);
    if (next === "messages") setVisitedMessages(true);
  };
  /** A line on the receipt was clicked: show that helper on the map. */
  const showOnMap = (helperId: string | null) => {
    setPicked(helperId ?? MAIN_ID);
    setView("map");
    setTab("helpers");
  };

  const tabs: { value: Tab; label: string }[] = [
    { value: "receipt", label: "Tokens" },
    ...(hasHelpers ? [{ value: "helpers" as const, label: "Helpers" }] : []),
    { value: "messages", label: "Messages" },
    { value: "details", label: "Details" },
  ];

  return (
    <div className="@container session-fit">
      <div className="flex shrink-0 items-start gap-3">
        {back}
        <div className="min-w-0 flex-1">
          <h2 className="d d-figure truncate text-ink" title={name}>
            {name}
          </h2>
          <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 text-body text-ink-2">
            <span className="font-medium text-ink">{row.projectName}</span>
            <span>{formatWhen(row.startedAt)}</span>
            <span>{formatDuration(row.durationMs)}</span>
            <ModelDots models={row.models} />
            {hasHelpers && <span>{plural(agents.length, "helper")}</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <TokenFigure tokens={row.tokens.total} cost={row.cost} id={`session:${id}:tokens`} className="d d-stat text-ink" />
          {claudeCodeCostUsd !== null && <div className="text-caption text-ink-2">{`Claude Code showed ${formatUsd(claudeCodeCostUsd)}`}</div>}
        </div>
      </div>

      <div className="mt-4 flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <SegmentedControl label="Session view" value={shownTab} onChange={choose} options={tabs} />
        {shownTab === "helpers" && (
          <div className="flex items-center gap-2">
            {view === "list" && (
              <SegmentedControl
                label="Order helpers by"
                value={order}
                onChange={setOrder}
                options={[
                  { value: "started", label: "Started" },
                  { value: "spend", label: "Spend" },
                ]}
              />
            )}
            <SegmentedControl
              label="Show helpers as"
              value={view}
              onChange={setView}
              options={[
                { value: "map", label: "Map" },
                { value: "list", label: "List" },
              ]}
            />
          </div>
        )}
        {shownTab === "details" && hasHelpers && (
          <SegmentedControl
            label="Count tokens for"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "With helpers" },
              { value: "main", label: "Main only" },
            ]}
          />
        )}
      </div>

      <div className="session-pane @container">
        {shownTab === "receipt" && <ReceiptPane state={receipt} sessionId={id} onOpenHelper={showOnMap} />}

        {shownTab === "helpers" &&
          (view === "list" ? (
            <HelperList agents={agents} order={order} sessionId={id} sessionUsd={sessionUsd} names={names} onOpen={setAgentId} />
          ) : receipt.data ? (
            <div className="map-grid">
              <HelperMap receipt={receipt.data} sessionId={id} selected={picked} onSelect={setPicked} />
              <HelperSlice receipt={receipt.data} nodeId={picked} onOpenHelper={setAgentId} />
            </div>
          ) : receipt.error ? (
            <div role="alert" className="flex items-center gap-3 text-body text-ink-2">
              <span className="text-danger">{receipt.error}</span>
              <Button onClick={() => receipt.reload(false)}>Try again</Button>
            </div>
          ) : (
            <div role="status" aria-label="Drawing the helper map">
              <Skeleton className="h-64" />
            </div>
          ))}

        {(shownTab === "messages" || visitedMessages) && (
          <div hidden={shownTab !== "messages"} className="h-full min-h-0">
            <Conversation sessionId={id} names={names} />
          </div>
        )}

        {shownTab === "details" && (
          <div className="details-grid">
            <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4 @3xl:col-span-2">
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

            <section aria-label="Token breakdown" className="min-w-0">
              <h3 className="rcpt-head">Token breakdown</h3>
              <Breakdown t={scope === "main" ? main.tokens : total} />
            </section>

            {spend.length > 1 && (
              <section aria-label="Spend as it ran" className="min-w-0">
                <h3 className="rcpt-head">Spend as it ran</h3>
                <Card className="px-4 py-3">
                  <Ridge id={`session:${id}:spend`} data={spend} label="Spend as it ran" height={120} summit={hasClearPeak(spend.map((s) => s.value))} />
                </Card>
              </section>
            )}

            {bins.length > 0 && (
              <section aria-label="Tokens through the session" className="min-w-0">
                <h3 className="rcpt-head">Tokens through the session</h3>
                <Card className="px-4 py-3">
                  <Bars id={`session:${id}:bars`} data={bins} label="Tokens through the session" formatTick={compact} />
                </Card>
              </section>
            )}

            {byModel.length > 1 && (
              <section aria-label="By model" className="min-w-0">
                <h3 className="rcpt-head">By model</h3>
                <ModelSplit rows={byModel} />
              </section>
            )}

            <section aria-label="Files" className="min-w-0">
              <h3 className="rcpt-head">{`Files (${files.length})`}</h3>
              <Card>
                <ul className="max-h-40 divide-y divide-line overflow-y-auto">
                  {files.map((f) => (
                    <li key={f.path} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2">
                      <code className="selectable min-w-0 flex-1 break-all text-caption text-ink">{f.path}</code>
                      {f.isSubagent && <span className="text-caption text-ink-2">helper</span>}
                      {f.missing && <span className="text-caption text-warning">removed from disk</span>}
                    </li>
                  ))}
                </ul>
              </Card>
              <code className="selectable mt-2 block break-all text-caption text-ink-2">{row.projectPath}</code>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
