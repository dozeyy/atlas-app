import { useMemo } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  CheckCircle,
  Coffee,
  DotsThree,
  FilePlus,
  FileText,
  Globe,
  HourglassMedium,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  Question,
  TerminalWindow,
  UsersThree,
  Warning,
  Wrench,
  type IconProps,
} from "@phosphor-icons/react";
import { PageTitle } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { HelperTracker } from "../components/now/HelperTracker";
import { useAtlas } from "../state/AtlasProvider";
import { rememberSettingsSection } from "../lib/settingsSection";
import { ago, clock, groupChats, nowCost, splitPath } from "../lib/nowFormat";
import type { NowChat, NowLast } from "../lib/nowTypes";
import { useClimb, useClock, useNowSnapshot } from "../lib/useNow";
import { useSteadyDoing } from "../lib/useSteadyDoing";
import { compact, formatDuration, modelWithEffort, plural, tokenHint } from "../lib/usage";
import "../styles/now.css";

/** How many of a chat's files the hover on what it is doing names. */
const FILES_SHOWN = 3;

const KIND_ICON: Record<string, ComponentType<IconProps>> = {
  read: FileText,
  edit: PencilSimple,
  write: FilePlus,
  run: TerminalWindow,
  search: MagnifyingGlass,
  web: Globe,
  helper: UsersThree,
  plan: ListChecks,
  ask: Question,
  tool: Wrench,
  think: DotsThree,
  wait: Coffee,
};

function KindIcon({ kind, size }: { kind: string; size: number }) {
  const Icon = KIND_ICON[kind] ?? Wrench;
  return <Icon size={size} weight="duotone" aria-hidden="true" />;
}

// ---- the page ------------------------------------------------------------------------

export function Now() {
  const { info, setView } = useAtlas();
  const snap = useNowSnapshot();
  const groups = useMemo(() => (snap ? groupChats(snap) : null), [snap]);
  // One clock for every "x min ago" on the page; it only ticks when something shows one.
  const idle = !!groups && (groups.waiting.length > 0 || groups.finished.length > 0);
  const now = useClock(idle, 30_000);
  // "Nothing to watch" has two causes and only one of them is a missing folder. The engine's
  // `watching` is false for both (it looks for the sessions folder inside the Claude folder); the
  // app's own look at the Claude folder says which. A folder that is there but has no sessions in
  // it yet is simply "No sessions yet".
  const noFolder = !!snap && !snap.watching && info.config?.dirExists === false;
  const last = groups?.finished[0] ?? null;

  return (
    <>
      <PageTitle title="Now" />
      <div className="now-root">
        {snap === null || groups === null ? null : noFolder ? (
          <EmptyState
            fill
            seed={44}
            title="No Claude folder found"
            body="Choose it in Settings, under Claude folder."
            action={{
              label: "Open Settings",
              onClick: () => {
                rememberSettingsSection("folder");
                setView("settings");
              },
            }}
          />
        ) : (
          // One column, read top to bottom in the order it matters: what is waiting for you, what is
          // running, what just finished. Nothing scrolls inside itself; the page does.
          <>
            {groups.waiting.length > 0 && (
              <List title="Waiting for you" count={groups.waiting.length} needsYou>
                {groups.waiting.map((c) => (
                  <WaitRow key={c.sessionId} chat={c} now={now} />
                ))}
              </List>
            )}
            {groups.running.length > 0 ? (
              <Running chats={groups.running} />
            ) : groups.waiting.length === 0 ? (
              // The shared empty state: the spark, one title, one plain line (when the last session
              // ended, or else what to do next). It takes the room the lists leave.
              <EmptyState
                fill
                seed={44}
                className="min-h-[240px]"
                title={last ? "Nothing running" : "No sessions yet"}
                body={last ? `Last session ended ${ago(last.endedMs, now)}` : "Start a session in Claude Code and it shows up here while it works."}
              />
            ) : null}
            {groups.finished.length > 0 && (
              <List title="Finished recently" count={groups.finished.length}>
                {groups.finished.map((l) => (
                  <DoneRow key={l.sessionId} last={l} now={now} />
                ))}
              </List>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---- lists: waiting for you, finished recently ----------------------------------------

/** `needsYou` marks the one list that is waiting on the person: a warning sign beside its name. */
function List({ title, count, needsYou, children }: { title: string; count: number; needsYou?: boolean; children: ReactNode }) {
  return (
    <section className="now-list" aria-label={title} data-needs-you={needsYou || undefined}>
      <h2 className="h-section now-list-head">
        {needsYou && <Warning size={16} weight="fill" aria-hidden="true" />}
        <span>{title}</span>
        <span className="now-count">{count}</span>
      </h2>
      <ul className="now-rows">{children}</ul>
    </section>
  );
}

/** `optional` ranks what a narrow row drops: 1 goes first, then 2; the unranked figure always stays. */
function Stat({ fig, cap, title, optional }: { fig: string; cap: string; title?: string; optional?: 1 | 2 }) {
  return (
    <div className="now-stat" title={title} data-opt={optional}>
      <p className="d d-small now-stat-fig">{fig}</p>
      <p className="nc-cap">{cap}</p>
    </div>
  );
}

function WaitRow({ chat, now }: { chat: NowChat; now: number }) {
  const name = chat.title ?? chat.project;
  const asking = chat.doing.kind === "ask";
  const line = [chat.doing.verb, chat.doing.target].filter(Boolean).join(" ");
  return (
    <li className="now-row card" data-state={asking ? "ask" : "wait"}>
      <div className="now-tile" aria-hidden="true">
        {asking ? <Question size={22} weight="duotone" /> : <HourglassMedium size={22} weight="duotone" />}
      </div>
      <div className="now-row-main">
        <h3 className="now-row-title" title={name}>
          {name}
        </h3>
        <p className="now-row-sub">
          {chat.title && (
            <span className="chip now-chip-name" title={chat.project}>
              {chat.project}
            </span>
          )}
          {chat.model && <span className="chip">{modelWithEffort(chat.model, chat.effort)}</span>}
          <span className="now-row-doing" title={line}>
            {line}
          </span>
        </p>
      </div>
      {chat.workedMs !== null && <Stat fig={formatDuration(chat.workedMs)} cap="Last turn took" optional={1} />}
      <Stat fig={compact(chat.tokens)} cap="Tokens" title={tokenHint(chat.tokens, nowCost(chat.costUsd, chat.unpriced), chat.tokenKinds)} optional={2} />
      {/* "3 min ago" under "Stopped": a time, never mistaken for a length. */}
      <Stat fig={ago(chat.lastWriteMs, now)} cap="Stopped" />
    </li>
  );
}

function DoneRow({ last, now }: { last: NowLast; now: number }) {
  const name = last.title ?? last.project;
  return (
    <li className="now-row card" data-state="done">
      <div className="now-tile" aria-hidden="true">
        <CheckCircle size={22} weight="duotone" />
      </div>
      <div className="now-row-main">
        <h3 className="now-row-title" title={name}>
          {name}
        </h3>
        <p className="now-row-sub">
          {last.title && (
            <span className="chip now-chip-name" title={last.project}>
              {last.project}
            </span>
          )}
          {last.model && <span className="chip">{modelWithEffort(last.model, last.effort)}</span>}
        </p>
      </div>
      {/* A session that was already over when Atlas started has no total (the engine reads only the
          end of its file), so its row shows no token figure at all: a dash read as missing data, and
          right after a launch every row had one. */}
      {last.tokens !== null && <Stat fig={compact(last.tokens)} cap="Tokens" title={tokenHint(last.tokens, nowCost(null, false), last.tokenKinds)} optional={2} />}
      <Stat fig={ago(last.endedMs, now)} cap="Ended" />
    </li>
  );
}

// ---- running chats ---------------------------------------------------------------------

/**
 * One row per running chat, the same row whether one chat runs or thirty: its name and where it
 * runs, what it is doing this second, its tokens, its clock. The rows line up down the page and the
 * page scrolls; a row never grows, shrinks or turns into another kind of card with the count.
 */
function Running({ chats }: { chats: NowChat[] }) {
  // One clock for every row.
  const now = useClock(true, 1000);
  return (
    <section className="now-run" aria-label="Running">
      <h2 className="h-section now-list-head">
        <span>Running</span>
        <span className="now-count">{chats.length}</span>
      </h2>
      <div className="now-chats">
        {chats.map((c) => (
          <ChatRow key={c.sessionId} chat={c} now={now} />
        ))}
      </div>
      <HelperTracker chats={chats} />
    </section>
  );
}

function ChatRow({ chat, now }: { chat: NowChat; now: number }) {
  const tokens = useClimb(chat.tokens);
  const { doing, swapKey } = useSteadyDoing(chat.doing);
  const name = chat.title ?? chat.project;
  const out = chat.helpers.filter((h) => !h.done);
  // The files it has touched are the second line of the hover, not chips on the row.
  const files = chat.files.map((f) => f.path).filter((p) => p !== doing.target);
  const more = files.length - FILES_SHOWN;
  const fileLine = files.length > 0 ? `Files so far: ${files.slice(0, FILES_SHOWN).join(", ")}${more > 0 ? ` and ${more} more` : ""}` : "";
  const doingTip = [[doing.verb, doing.target].filter(Boolean).join(" "), fileLine].filter(Boolean).join("\n");

  return (
    <article className="now-card card" aria-label={name}>
      <header className="nc-head">
        <h3 className="nc-title" title={name}>
          {name}
        </h3>
        <div className="now-chips">
          {chat.title && (
            <span className="chip now-chip-name" title={chat.project}>
              {chat.project}
            </span>
          )}
          {chat.model && <span className="chip">{modelWithEffort(chat.model, chat.effort)}</span>}
          {out.length > 0 && (
            <span className="chip chip-clay nc-helpers-chip" title={out.map((h) => h.name).join(", ")}>
              {plural(out.length, "helper")}
            </span>
          )}
        </div>
      </header>

      <section className="nc-doing" aria-label="Doing now" title={doingTip}>
        <div className="now-tile nc-tile" data-kind={doing.kind}>
          <KindIcon kind={doing.kind} size={22} />
        </div>
        <div className="nc-doing-text" key={swapKey}>
          <p className="d nc-verb">{doing.verb}</p>
          {doing.target && (
            <p className="nc-target">
              <TargetText text={doing.target} />
            </p>
          )}
        </div>
      </section>

      <div className="nc-num" title={tokenHint(chat.tokens, nowCost(chat.costUsd, chat.unpriced), chat.tokenKinds)}>
        <p className="d d-figure nc-spend-fig">{compact(Math.round(tokens))}</p>
        <p className="nc-cap">Tokens</p>
      </div>

      <div className="nc-num">
        {chat.startedMs !== null && (
          <>
            <p className="d d-figure nc-clock-fig">{clock(now - chat.startedMs)}</p>
            <p className="nc-cap">Elapsed</p>
          </>
        )}
      </div>
    </article>
  );
}

export { useSteadyDoing };

/** What is being worked on. A file path gives up its folders first, so the file name stays. */
function TargetText({ text }: { text: string }) {
  const path = splitPath(text);
  if (!path) return <>{text}</>;
  return (
    <span className="now-path">
      <span className={path.head.length > 2 ? "now-path-head" : "now-path-head is-short"}>{path.head}</span>
      <span className="now-path-tail">{path.tail}</span>
    </span>
  );
}

