import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowBendDownRight,
  ArrowLeft,
  CaretDown,
  CaretRight,
  CaretUp,
  ChatsCircle,
  Copy,
  FolderOpen,
  Hash,
  UsersThree,
  Wrench,
} from "@phosphor-icons/react";
import { Button, Card, IconButton, SegmentedControl } from "../components/controls";
import { Bars } from "../components/charts/Bars";
import { Ridge } from "../components/charts/Ridge";
import { IconMotion } from "../components/IconMotion";
import { TokenText } from "../components/usage/TokenText";
import { Breakdown, ModelSplit, Stat } from "../components/usage/detailParts";
import { HelperMap } from "../components/usage/HelperMap";
import { HelperSlice } from "../components/usage/HelperSlice";
import { AgentAvatar, ModelDots, OutcomeMark, sessionName, TokenFigure } from "../components/usage/helperKit";
import { ReceiptPane } from "../components/usage/ReceiptPane";
import { SessionTools, useSessionItems } from "../components/usage/SessionTools";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { hasClearPeak, spendRidge, timelineBars } from "../components/usage/timelineBars";
import type { BarDatum } from "../components/charts/shared";
import { getBackend } from "../lib/ipc";
import { clearPendingAgent, peekPendingAgent } from "../lib/nav";
import { copyResume, openFolder } from "../lib/sessionActions";
import { resumeCommand } from "../lib/sessionBrowse";
import { useAtlas } from "../state/AtlasProvider";
import { useKeyHints } from "../lib/keyHints";
import { helperTree, type HelperNode } from "../lib/helperTree";
import { MAIN_ID } from "../lib/helperMap";
import { useIntro } from "../lib/motion";
import { useFetched, useLiveReload } from "../lib/useUsage";
import { compact, effortMix, exact, formatDuration, formatUsd, formatWhen, headline, modelWithEffort, percent, plural, share, topEffort } from "../lib/usage";
import { AgentDetailView, typeLabel } from "./AgentDetail";
import type { AgentSummary, Outcome, SessionDetail, TranscriptItem } from "../lib/types";

type Tab = "receipt" | "helpers" | "messages" | "details";

/** One helper as a card: who it was, what it spent, how much of the session that is. */
function HelperCard({
  agent,
  parentName,
  inTree = false,
  outcome,
  sessionTokens,
  index,
  onOpen,
}: {
  agent: AgentSummary;
  parentName: string | null;
  /** Drawn under its starter on the rail, so the starter's name is not written out again. */
  inTree?: boolean;
  /** How it ended, once the receipt has been read; nothing until then. */
  outcome?: Outcome | null;
  /** The chat's tokens, counted the same way as the helper's (the headline kind). */
  sessionTokens: number;
  index: number;
  onOpen: (id: string) => void;
}) {
  // Tokens lead here as everywhere else (the dollar estimate is in the hover), and the share is the
  // same share the receipt and the helper map show for this helper.
  const tokens = headline(agent.tokens);
  const frac = share(tokens, sessionTokens);
  const dot = (
    <span aria-hidden="true" className="mx-1.5 text-ink-2/60">
      &middot;
    </span>
  );
  // One row a helper: who (the name), what kind (the avatar, and the type in words), did it finish,
  // how long, and on the right how much. Everything else is on the helper's own page. A type that
  // only repeats the name ("verifier", Verifier) is not written twice.
  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const type = agent.agentType && !flat(agent.name).startsWith(flat(agent.agentType)) ? typeLabel(agent.agentType) : null;
  const facts: ReactNode[] = [];
  if (outcome) facts.push(<OutcomeMark key="o" outcome={outcome} />);
  if (type)
    facts.push(
      <span key="t" className="min-w-12 truncate" title={agent.agentType ?? undefined}>
        {type}
      </span>,
    );
  if (parentName && !inTree)
    facts.push(
      <span key="p" className="inline-flex min-w-16 max-w-56 items-baseline" title={`Started by ${parentName}`}>
        <ArrowBendDownRight size={12} aria-hidden="true" className="mr-1 shrink-0 self-center" />
        <span className="truncate">{parentName}</span>
      </span>,
    );
  facts.push(
    <span key="d" className="flex-none whitespace-nowrap" title={`Ran for ${formatDuration(agent.durationMs)}, ${plural(agent.toolCalls, "tool call")}`}>
      {formatDuration(agent.durationMs)}
    </span>,
  );
  return (
    <Card onClick={() => onOpen(agent.agentId)} className="flex items-center gap-3 px-4 py-3">
      <AgentAvatar type={agent.agentType} level={parentName ? "nested" : "helper"} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold text-ink" title={agent.name}>
          {agent.name}
        </div>
        {/* The facts stay; the model leaves the line whole when there is no room (.sl-meta). */}
        <div className="sl-meta mt-0.5 min-w-0 text-caption text-ink-2">
          <span className="sl-main">
            {facts.map((f, i) => (
              <Fragment key={i}>
                {i > 0 && dot}
                {f}
              </Fragment>
            ))}
            {parentName && inTree && <span className="sr-only">{`, started by ${parentName}`}</span>}
          </span>
          <span className="flex-none whitespace-nowrap" title={agent.model}>
            {dot}
            {modelWithEffort(agent.model, topEffort(agent.efforts))}
          </span>
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="d d-small text-ink">
          <TokenText tokens={tokens} cost={agent.cost} />
        </div>
        <div className="flex items-center justify-end text-caption text-ink-2" role="img" aria-label={`${percent(frac)} of the session's tokens`}>
          {percent(frac)}
          <span aria-hidden="true" className="tok-bar">
            <i style={{ width: `${Math.max(frac > 0 ? 4 : 0, Math.round(frac * 100))}%`, ["--i" as string]: Math.min(index, 12) }} />
          </span>
        </div>
      </div>
      <CaretRight size={12} aria-hidden="true" className="row-caret shrink-0" />
    </Card>
  );
}

function HelperBranch({
  node,
  names,
  outcomes,
  sessionTokens,
  onOpen,
}: {
  node: HelperNode;
  names: Map<string, string>;
  outcomes: Map<string, Outcome | null>;
  sessionTokens: number;
  onOpen: (id: string) => void;
}) {
  const a = node.agent;
  return (
    <>
      <HelperCard
        agent={a}
        parentName={a.parentAgentId ? (names.get(a.parentAgentId) ?? null) : null}
        inTree
        outcome={outcomes.get(a.agentId)}
        sessionTokens={sessionTokens}
        index={node.index}
        onOpen={onOpen}
      />
      {node.kids.length > 0 && (
        <ul className="helper-kids">
          {node.kids.map((k) => (
            <li key={k.agent.agentId} className="helper-kid">
              <HelperBranch node={k} names={names} outcomes={outcomes} sessionTokens={sessionTokens} onOpen={onOpen} />
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
  sessionTokens,
  names,
  outcomes,
  onOpen,
}: {
  agents: AgentSummary[];
  order: "started" | "spend";
  sessionId: string;
  sessionTokens: number;
  names: Map<string, string>;
  outcomes: Map<string, Outcome | null>;
  onOpen: (id: string) => void;
}) {
  const intro = useIntro(`helpers:${sessionId}`);
  const roots = useMemo(() => helperTree(agents), [agents]);
  const nested = order === "started" && roots.some((r) => r.kids.length > 0);
  const flat = order === "spend" ? [...agents].sort((a, b) => headline(b.tokens) - headline(a.tokens)) : agents;

  if (nested) {
    return (
      <ul className={`grid grid-cols-1 gap-2${intro ? " intro" : ""}`}>
        {roots.map((r) => (
          <li key={r.agent.agentId}>
            <HelperBranch node={r} names={names} outcomes={outcomes} sessionTokens={sessionTokens} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    );
  }
  return (
    <ul className={`grid grid-cols-1 gap-2 @2xl:grid-cols-2${intro ? " intro" : ""}`}>
      {flat.map((a, i) => (
        <li key={a.agentId} className="@2xl:[&:last-child:nth-child(odd)]:col-span-2">
          <HelperCard
            agent={a}
            parentName={a.parentAgentId ? (names.get(a.parentAgentId) ?? null) : null}
            outcome={outcomes.get(a.agentId)}
            sessionTokens={sessionTokens}
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

/** The Details tab: numbers first, then a row to jump to any section, then the sections. */
function DetailsTab({
  id,
  d,
  scope,
  bins,
  spend,
}: {
  id: string;
  d: SessionDetail;
  scope: "all" | "main";
  bins: BarDatum[];
  spend: BarDatum[];
}) {
  const { row, byModel, agents, main, files } = d;
  const total = row.tokens;
  const toolCalls = main.toolCalls + agents.reduce((s, a) => s + a.toolCalls, 0);
  const groups = useSessionItems(id);
  const hasItems = groups.some((g) => g.items.length > 0);

  const jumps: { key: string; label: string }[] = [{ key: "tokens", label: "Tokens" }];
  if (spend.length > 1) jumps.push({ key: "spend", label: "Spend" });
  if (bins.length > 0) jumps.push({ key: "timeline", label: "Timeline" });
  if (byModel.length > 1) jumps.push({ key: "models", label: "Models" });
  if (hasItems) jumps.push({ key: "tools", label: "Tools" });
  jumps.push({ key: "files", label: "Files" });

  const jump = (key: string) => document.getElementById(`sd-${key}`)?.scrollIntoView({ block: "start" });

  return (
    <>
      {jumps.length >= 4 && (
        <nav aria-label="Jump to" className="jump-row">
          {jumps.map((j) => (
            <button key={j.key} type="button" className="jump-chip" onClick={() => jump(j.key)}>
              {j.label}
            </button>
          ))}
        </nav>
      )}
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

        <section id="sd-tokens" aria-label="Token breakdown" className="jump-target min-w-0">
          <h3 className="rcpt-head">Token breakdown</h3>
          <Breakdown t={scope === "main" ? main.tokens : total} />
        </section>

        {spend.length > 1 && (
          <section id="sd-spend" aria-label="Spend as it ran" className="jump-target min-w-0">
            <h3 className="rcpt-head">Spend as it ran</h3>
            <Card className="px-4 py-3">
              <Ridge id={`session:${id}:spend`} data={spend} label="Spend as it ran" height={120} summit={hasClearPeak(spend.map((s) => s.value))} />
            </Card>
          </section>
        )}

        {bins.length > 0 && (
          <section id="sd-timeline" aria-label="Tokens through the session" className="jump-target min-w-0">
            <h3 className="rcpt-head">Tokens through the session</h3>
            <Card className="px-4 py-3">
              <Bars id={`session:${id}:bars`} data={bins} label="Tokens through the session" formatTick={compact} />
            </Card>
          </section>
        )}

        {byModel.length > 1 && (
          <section id="sd-models" aria-label="By model" className="jump-target min-w-0">
            <h3 className="rcpt-head">By model</h3>
            <ModelSplit rows={byModel} />
          </section>
        )}

        {hasItems && (
          <section id="sd-tools" aria-label="Tools and skills" className="jump-target min-w-0 @3xl:col-span-2">
            <h3 className="rcpt-head">Tools and skills</h3>
            <SessionTools groups={groups} />
          </section>
        )}

        <section id="sd-files" aria-label="Files" className="jump-target min-w-0 @3xl:col-span-2">
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
    </>
  );
}

export function SessionDetailView({
  id,
  onBack,
  siblings,
  onJump,
}: {
  id: string;
  onBack: () => void;
  /** The sessions in the list this one was opened from, in order: Alt+Up / Alt+Down walk them. */
  siblings?: string[];
  onJump?: (id: string) => void;
}) {
  const backend = getBackend();
  const { info } = useAtlas();
  const { tip } = useKeyHints();
  const at = siblings ? siblings.indexOf(id) : -1;
  const prevId = siblings && at > 0 ? siblings[at - 1] : null;
  const nextId = siblings && at >= 0 && at < siblings.length - 1 ? siblings[at + 1] : null;
  useEffect(() => {
    if (!onJump) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const to = e.key === "ArrowUp" ? prevId : e.key === "ArrowDown" ? nextId : null;
      if (!to) return;
      e.preventDefault();
      onJump(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onJump, prevId, nextId]);
  const d = useFetched(() => backend.sessionDetail(id), [id]);
  useLiveReload(d.reload);
  // The receipt reads the chat's files once and is then kept, so it is not reloaded with every
  // tick: only when the chat's cost itself moved.
  const receipt = useFetched(() => backend.sessionReceipt(id), [id]);
  // The Team tab can ask for a helper of this chat: it opens straight on that helper.
  const [agentId, setAgentId] = useState<string | null>(() => peekPendingAgent(id));
  const agentChat = useRef(id);
  useEffect(() => clearPendingAgent(), []);
  const [tab, setTab] = useState<Tab>("receipt");
  const [view, setView] = useState<"map" | "list">("map");
  const [order, setOrder] = useState<"started" | "spend">("started");
  const [scope, setScope] = useState<"all" | "main">("all");
  const [picked, setPicked] = useState<string>(MAIN_ID);
  const [visitedMessages, setVisitedMessages] = useState(false);
  const costSeen = useRef<number | null>(null);

  useEffect(() => {
    // Only another chat resets the helper: the first run belongs to a helper asked for by name.
    if (agentChat.current !== id) {
      agentChat.current = id;
      setAgentId(null);
    }
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

  const { row, agents, claudeCodeCostUsd } = d.data;
  const name = sessionName(row);
  const resume = resumeCommand(id, row.projectPath, info.platform);
  const sessionTokens = headline(row.tokens);
  const names = new Map(agents.map((a) => [a.agentId, a.name]));
  const helperTypes = new Map(agents.map((a) => [a.agentId, a.agentType]));
  // How each helper ended comes with the receipt (it reads the files); the list shows it once it is in.
  const outcomes = new Map((receipt.data?.threads ?? []).flatMap((t) => (t.agentId ? [[t.agentId, t.outcome] as const] : [])));
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
            <ModelDots models={row.models} main={row.mainModel} effort={topEffort(row.efforts)} />
            {(row.efforts?.length ?? 0) > 1 && (
              <span title="Reasoning effort of the main chat's replies (helpers are on their own cards)">{`Effort ${effortMix(row.efforts)}`}</span>
            )}
            {hasHelpers && <span>{plural(agents.length, "helper")}</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <TokenFigure
            tokens={row.tokens.total}
            cost={row.cost}
            id={`session:${id}:tokens`}
            note={claudeCodeCostUsd !== null ? `Claude Code showed ${formatUsd(claudeCodeCostUsd)}.` : undefined}
            className="d d-stat text-ink"
          />
        </div>
      </div>

      <div className="mt-4 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2">
        <SegmentedControl label="Session view" value={shownTab} onChange={choose} options={tabs} />
        {shownTab === "helpers" && (
          <div className="sd-sub flex items-center gap-2">
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
          <div className="sd-sub">
            <SegmentedControl
              label="Count tokens for"
              value={scope}
              onChange={setScope}
              options={[
                { value: "all", label: "With helpers" },
                { value: "main", label: "Main only" },
              ]}
            />
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {resume && (
            <Button className="sd-act" title="Copy the command that reopens this chat in a terminal" onClick={() => void copyResume(resume)}>
              <Copy size={14} aria-hidden="true" />
              <span className="sd-act-label">Copy resume</span>
            </Button>
          )}
          {row.projectPath && (
            <Button className="sd-act" title={`Open folder: ${row.projectPath}`} onClick={() => void openFolder(id)}>
              <FolderOpen size={14} aria-hidden="true" />
              <span className="sd-act-label">Open folder</span>
            </Button>
          )}
          {onJump && siblings && at >= 0 && (
            <>
              <IconButton
                aria-label="Previous session"
                title={tip("Previous session", "Alt+Up")}
                disabled={!prevId}
                onClick={() => prevId && onJump(prevId)}
              >
                <CaretUp size={16} aria-hidden="true" />
              </IconButton>
              <IconButton aria-label="Next session" title={tip("Next session", "Alt+Down")} disabled={!nextId} onClick={() => nextId && onJump(nextId)}>
                <CaretDown size={16} aria-hidden="true" />
              </IconButton>
            </>
          )}
        </div>
      </div>

      <div className="session-pane @container">
        {shownTab === "receipt" && <ReceiptPane
            state={receipt}
            sessionId={id}
            onOpenHelper={showOnMap}
            effortOf={(m) => topEffort(d.data?.byModel.find((b) => b.model === m)?.efforts)}
          />}

        {shownTab === "helpers" &&
          (view === "list" ? (
            <HelperList agents={agents} order={order} sessionId={id} sessionTokens={sessionTokens} names={names} outcomes={outcomes} onOpen={setAgentId} />
          ) : receipt.data ? (
            <div className="map-grid">
              <HelperMap receipt={receipt.data} sessionId={id} selected={picked} onSelect={setPicked} types={helperTypes} />
              <HelperSlice
                receipt={receipt.data}
                nodeId={picked}
                onOpenHelper={setAgentId}
                effortOf={(a) => topEffort(a ? agents.find((x) => x.agentId === a)?.efforts : row.efforts)}
              />
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

        {shownTab === "details" && <DetailsTab id={id} d={d.data} scope={scope} bins={bins} spend={spend} />}
      </div>
    </div>
  );
}
