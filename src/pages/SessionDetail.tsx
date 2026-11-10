import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowBendDownRight,
  ArrowLeft,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CaretUp,
  ChatsCircle,
  Copy,
  FolderOpen,
  Hash,
  ListBullets,
  TreeStructure,
  UsersThree,
  Wrench,
} from "@phosphor-icons/react";
import { Button, Card, IconButton, SegmentedControl } from "../components/controls";
import { Bars } from "../components/charts/Bars";
import { IconMotion } from "../components/IconMotion";
import { TokenText } from "../components/usage/TokenText";
import { Breakdown, ClampList, ClampText, FileRow, ModelSplit, Stat } from "../components/usage/detailParts";
import { HelperMap } from "../components/usage/HelperMap";
import { HelperSlice } from "../components/usage/HelperSlice";
import { AgentAvatar, ModelDots, OutcomeMark, sessionName, shownName, TokenFigure } from "../components/usage/helperKit";
import { ReceiptPane } from "../components/usage/ReceiptPane";
import { SessionTools, useSessionItems } from "../components/usage/SessionTools";
import { ErrorBlock, Skeleton } from "../components/usage/StateBlocks";
import { timelineBars } from "../components/usage/timelineBars";
import type { BarDatum } from "../components/charts/shared";
import { getBackend } from "../lib/ipc";
import { clearPendingAgent, peekPendingAgent } from "../lib/nav";
import { copyResume, openFolder } from "../lib/sessionActions";
import { resumeCommand } from "../lib/sessionBrowse";
import { useAtlas } from "../state/AtlasProvider";
import { KIND_WORDS } from "../lib/receiptView";
import { useKeyHints } from "../lib/keyHints";
import { helperTree, type HelperNode } from "../lib/helperTree";
import { MAIN_ID } from "../lib/helperMap";
import { useIntro } from "../lib/motion";
import { useFetched, useLiveReload } from "../lib/useUsage";
import { compact, effortMix, exact, formatDuration, formatUsd, formatWhen, headline, modelWithEffort, percent, plural, share, topEffort } from "../lib/usage";
import { AgentDetailView, typeLabel } from "./AgentDetail";
import type { AgentSummary, Outcome, SessionDetail, TranscriptItem } from "../lib/types";

type Tab = "receipt" | "helpers" | "messages" | "details";

/** Anything that owns Escape while it is open: the going-back keys stand down for it. */
const OVERLAY_OPEN = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/** Focus is somewhere text is being typed or picked, where Escape and Alt+Left mean something else. */
function isTyping(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || el.matches("input, textarea, select, [contenteditable='true'], [role='textbox']");
}


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
        <div className="truncate text-body font-semibold text-ink" title={shownName(agent)}>
          {shownName(agent)}
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
  order: "started" | "tokens";
  sessionId: string;
  sessionTokens: number;
  names: Map<string, string>;
  outcomes: Map<string, Outcome | null>;
  onOpen: (id: string) => void;
}) {
  const intro = useIntro(`helpers:${sessionId}`);
  const roots = useMemo(() => helperTree(agents), [agents]);
  const nested = order === "started" && roots.some((r) => r.kids.length > 0);
  const flat = order === "tokens" ? [...agents].sort((a, b) => headline(b.tokens) - headline(a.tokens)) : agents;

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
            <ClampList className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
              {items.map((m, i) => (
                <li key={i} className="px-5 py-3">
                  <div className="flex items-baseline gap-3 text-caption text-ink-2">
                    <span className="font-medium text-ink">{m.role === "user" ? "You" : "Claude"}</span>
                    {m.agentId && <span>{names.get(m.agentId) ?? "A helper"}</span>}
                    {m.ts !== null && <span>{formatWhen(m.ts)}</span>}
                  </div>
                  {/* A long message shows six lines and a way to the rest, so the page reads as turns, not one wall. */}
                  <div className="mt-1">
                    <ClampText text={m.text} lines={6} className="selectable whitespace-pre-wrap break-words text-body text-ink" />
                  </div>
                  {m.truncated && <p className="mt-1 text-caption text-ink-2">Shortened. The full message is in the file.</p>}
                </li>
              ))}
            </ClampList>
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
  bins,
}: {
  id: string;
  d: SessionDetail;
  bins: BarDatum[];
}) {
  const { row, byModel, agents, main, files } = d;
  const total = row.tokens;
  const toolCalls = main.toolCalls + agents.reduce((s, a) => s + a.toolCalls, 0);
  const groups = useSessionItems(id);
  const hasItems = groups.some((g) => g.items.length > 0);

  const jumps: { key: string; label: string }[] = [{ key: "tokens", label: "Breakdown" }];
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
          {/* The chat's tokens are the figure at the top of the page; this tile is what sits apart from it. */}
          {total.cacheRead > 0 ? (
            <Stat label="Reused" icon={<ArrowsClockwise size={14} aria-hidden="true" />} sub={`not part of the ${compact(headline(total))}`}>
              <span title={`${KIND_WORDS.cacheRead.term}: ${exact(total.cacheRead)} tokens\n${KIND_WORDS.cacheRead.about}`}>{compact(total.cacheRead)}</span>
            </Stat>
          ) : (
            <Stat label="Tokens">
              <span title={exact(headline(total))}>{compact(headline(total))}</span>
            </Stat>
          )}
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
          {/* With helpers, the main chat and the whole chat stand side by side: no switch to flip. */}
          <Breakdown t={total} main={agents.length > 0 ? main.tokens : undefined} />
        </section>

        {/* The one chart of the run over time, in tokens; each bar's dollar estimate is in its hover.
            (A dollar ridge used to sit here: in tokens it would be this same chart again.) */}
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
          <h3 className="rcpt-head" title="The saved chat files these figures were read from">{`Files (${files.length})`}</h3>
          {/* A row says whose file it is; the path is its hover and one press away on the clipboard.
              (The project folder is the first fact on the page's line and behind "Open folder".) */}
          <Card>
            <ul className="max-h-52 divide-y divide-line overflow-y-auto">
              {files.map((f) => {
                const helper = f.isSubagent ? agents.find((a) => f.path.includes(`agent-${a.agentId}`)) : undefined;
                const who = f.isSubagent ? (helper ? shownName(helper) : "A helper") : "Main chat";
                return <FileRow key={f.path} who={who} path={f.path} missing={f.missing} />;
              })}
            </ul>
          </Card>
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
  const { tip, show: showKeys } = useKeyHints();
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
  // Esc and Alt+Left step back one level: a helper's page to its session, the session to the list.
  // Never while a sheet, menu or dialog is open (Esc is theirs), or while typing.
  const onHelperPage = agentId !== null && !!d.data;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const wanted = e.altKey ? e.key === "ArrowLeft" : e.key === "Escape";
      if (!wanted || document.querySelector(OVERLAY_OPEN) || isTyping(document.activeElement)) return;
      e.preventDefault();
      if (onHelperPage) setAgentId(null);
      else onBack();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onHelperPage, onBack]);
  const [tab, setTab] = useState<Tab>("receipt");
  const [view, setView] = useState<"map" | "list">("map");
  const [order, setOrder] = useState<"started" | "tokens">("started");
  const [picked, setPicked] = useState<string>(MAIN_ID);
  const [visitedMessages, setVisitedMessages] = useState(false);
  const costSeen = useRef<number | null>(null);

  useEffect(() => {
    // Only another chat resets the helper: the first run belongs to a helper asked for by name.
    if (agentChat.current !== id) {
      agentChat.current = id;
      setAgentId(null);
    }
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

  const back = (
    <Button onClick={onBack} className="shrink-0" title={showKeys ? tip("All sessions", "Esc") : undefined}>
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
        outcome={receipt.data?.threads.find((t) => t.agentId === agentId)?.outcome}
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
  const mix = effortMix(row.efforts);
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
      {/* Top to bottom: which chat, the one figure, one line of plain facts, then the tabs. */}
      <div className="flex shrink-0 items-center gap-3">
        {back}
        <h2 className="d d-figure min-w-0 flex-1 truncate text-ink" title={name}>
          {name}
        </h2>
      </div>
      <div className="sd-hero">
        <TokenFigure
          tokens={row.tokens.total}
          cost={row.cost}
          id={`session:${id}:tokens`}
          note={claudeCodeCostUsd !== null ? `Claude Code showed ${formatUsd(claudeCodeCostUsd)}.` : undefined}
          className="d d-hero text-ink"
        />
        <p className="sd-line">
          <span className="sd-line-where" title={row.projectPath || row.projectName}>
            {row.projectName}
          </span>
          <span>{formatWhen(row.startedAt)}</span>
          <span title="From the first message to the last">{formatDuration(row.durationMs)}</span>
          {/* The effort mix is exact detail: it is the second line of the model's hover, not a fact on the line. */}
          <span>
            <ModelDots
              models={row.models}
              main={row.mainModel}
              effort={topEffort(row.efforts)}
              hint={mix ? `${row.models.join(" + ")}\nReasoning effort in the main chat: ${mix}` : undefined}
            />
          </span>
          {hasHelpers && <span>{plural(agents.length, "helper")}</span>}
        </p>
      </div>

      {/* One row of tabs. A tab's own switch is two small buttons beside them, or sits in its pane. */}
      <div className="mt-3 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <SegmentedControl label="Session view" value={shownTab} onChange={choose} options={tabs} />
        {shownTab === "helpers" && (
          <div className="sd-view" role="group" aria-label="Show helpers as">
            <IconButton aria-label="Show as a map" title="Show as a map" aria-pressed={view === "map"} onClick={() => setView("map")}>
              <TreeStructure size={16} aria-hidden="true" />
            </IconButton>
            <IconButton aria-label="Show as a list" title="Show as a list" aria-pressed={view === "list"} onClick={() => setView("list")}>
              <ListBullets size={16} aria-hidden="true" />
            </IconButton>
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {resume && (
            <Button className="sd-act" title={"Copy resume command\nPaste it in a terminal to reopen this chat."} onClick={() => void copyResume(resume)}>
              <Copy size={14} aria-hidden="true" />
              <span className="sd-act-label">Copy resume</span>
            </Button>
          )}
          {row.projectPath && (
            <Button className="sd-act" title={`Open folder\n${row.projectPath}`} onClick={() => void openFolder(id)}>
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
            types={helperTypes}
            effortOf={(m) => topEffort(d.data?.byModel.find((b) => b.model === m)?.efforts)}
          />}

        {shownTab === "helpers" &&
          (view === "list" ? (
            <>
              {agents.length > 1 && (
                <div className="mb-3 flex justify-end">
                  <SegmentedControl
                    label="Order helpers by"
                    value={order}
                    onChange={setOrder}
                    options={[
                      { value: "started", label: "Started" },
                      { value: "tokens", label: "Most tokens" },
                    ]}
                  />
                </div>
              )}
              <HelperList agents={agents} order={order} sessionId={id} sessionTokens={sessionTokens} names={names} outcomes={outcomes} onOpen={setAgentId} />
            </>
          ) : receipt.data ? (
            <div className="map-grid">
              <HelperMap receipt={receipt.data} sessionId={id} selected={picked} onSelect={setPicked} types={helperTypes} />
              <HelperSlice
                receipt={receipt.data}
                nodeId={picked}
                onOpenHelper={setAgentId}
                effortOf={(a) => topEffort(a ? agents.find((x) => x.agentId === a)?.efforts : row.efforts)}
                types={helperTypes}
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

        {shownTab === "details" && <DetailsTab id={id} d={d.data} bins={bins} />}
      </div>
    </div>
  );
}
