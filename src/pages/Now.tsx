import { useLayoutEffect, useMemo, useRef } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Binoculars,
  CheckCircle,
  Coffee,
  DotsThree,
  FilePlus,
  FileText,
  Globe,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  Question,
  TerminalWindow,
  UsersThree,
  Wrench,
  type IconProps,
} from "@phosphor-icons/react";
import { PageTitle } from "../components/controls";
import { Topo } from "../components/Topo";
import { prefersReducedMotion } from "../lib/motion";
import { HelperTracker } from "../components/now/HelperTracker";
import { ago, clock, groupChats, nowCost } from "../lib/nowFormat";
import type { NowChat, NowLast, NowStep } from "../lib/nowTypes";
import { useClimb, useClock, useNowSnapshot } from "../lib/useNow";
import { CALM_MS, useSteadyDoing } from "../lib/useSteadyDoing";
import { compact, formatDuration, modelLabel, plural, tokenHint } from "../lib/usage";
import "../styles/now.css";

/** More running chats than this and the cards turn into a compact grid that scrolls. */
const STACK_MAX = 3;
const FILES_SHOWN = 3;
/** A step stays marked as new this long, so a second one landing does not cut its entrance short. */
const FRESH_MS = 700;

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
  const snap = useNowSnapshot();
  const groups = useMemo(() => (snap ? groupChats(snap) : null), [snap]);
  // One clock for every "x min ago" on the page; it only ticks when something shows one.
  const idle = !!groups && (groups.waiting.length > 0 || groups.finished.length > 0);
  const now = useClock(idle, 30_000);

  return (
    <>
      <PageTitle title="Now" />
      <div className="now-root">
        {snap === null || groups === null ? null : !snap.watching ? (
          <Quiet title="No Claude folder found" />
        ) : (
          <>
            {groups.running.length > 0 ? (
              <Running chats={groups.running} />
            ) : groups.waiting.length === 0 ? (
              <Quiet title={groups.finished.length > 0 ? "Nothing running" : "No chats yet"} last={groups.finished[0] ?? null} now={now} />
            ) : null}
            {(groups.waiting.length > 0 || groups.finished.length > 0) && (
              <div className="now-band" data-fill={groups.running.length === 0 && groups.waiting.length > 0 ? "" : undefined} data-cols={(groups.waiting.length > 0 ? 1 : 0) + (groups.finished.length > 0 ? 1 : 0)}>
                {groups.waiting.length > 0 && (
                  <List title="Waiting for you" count={groups.waiting.length}>
                    {groups.waiting.map((c) => (
                      <WaitRow key={c.sessionId} chat={c} now={now} />
                    ))}
                  </List>
                )}
                {groups.finished.length > 0 && (
                  <List title="Finished recently" count={groups.finished.length}>
                    {groups.finished.map((l) => (
                      <DoneRow key={l.sessionId} last={l} now={now} />
                    ))}
                  </List>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}

// ---- nothing running -----------------------------------------------------------------

function Quiet({ title, last, now }: { title: string; last?: NowLast | null; now?: number }) {
  return (
    <section className="now-quiet card" aria-label={title}>
      <Topo seed={21} />
      <div className="now-quiet-tile">
        <Binoculars size={28} weight="duotone" aria-hidden="true" />
      </div>
      <h2 className="d d-title now-quiet-title">{title}</h2>
      {last && now !== undefined && <p className="now-quiet-when">{`Last chat ended ${ago(last.endedMs, now)}`}</p>}
    </section>
  );
}

// ---- lists: waiting for you, finished recently ----------------------------------------

function List({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="now-list" aria-label={title}>
      <h2 className="now-list-head">
        <span>{title}</span>
        <span className="now-count">{count}</span>
      </h2>
      <ul className="now-rows">{children}</ul>
    </section>
  );
}

/** `optional` ranks what a narrow row drops: 1 goes first, then 2; the unranked figure always stays. */
function Stat({ fig, cap, title, optional, dim }: { fig: string; cap: string; title?: string; optional?: 1 | 2; dim?: boolean }) {
  return (
    <div className="now-stat" title={title} data-opt={optional} data-dim={dim || undefined}>
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
        <KindIcon kind={asking ? "ask" : "wait"} size={22} />
      </div>
      <div className="now-row-main">
        <h3 className="now-row-title" title={name}>
          {name}
        </h3>
        <p className="now-row-sub">
          {chat.title && <span className="chip">{chat.project}</span>}
          <span className="now-row-doing" title={line}>
            {line}
          </span>
        </p>
      </div>
      {chat.workedMs !== null && <Stat fig={formatDuration(chat.workedMs)} cap="Last turn" optional={1} />}
      <Stat fig={compact(chat.tokens)} cap="Tokens" title={tokenHint(chat.tokens, nowCost(chat.costUsd, chat.unpriced))} optional={2} />
      <Stat fig={ago(chat.lastWriteMs, now).replace(/ ago$/, "")} cap="Stopped" />
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
          {last.title && <span className="chip">{last.project}</span>}
          {last.model && <span className="chip">{modelLabel(last.model)}</span>}
        </p>
      </div>
      {last.tokens !== null ? (
        <Stat fig={compact(last.tokens)} cap="Tokens" title={tokenHint(last.tokens, nowCost(null, false))} optional={2} />
      ) : (
        // A chat that was already over when Atlas started: only the end of its transcript is read, so a
        // total would be a fraction of the real one. The slot stays, so the rows line up.
        <Stat fig="-" cap="Tokens" title="Atlas was not watching this chat, so it has no total" optional={2} dim />
      )}
      <Stat fig={ago(last.endedMs, now).replace(/ ago$/, "")} cap="Ended" />
    </li>
  );
}

// ---- running chats ---------------------------------------------------------------------

function Running({ chats }: { chats: NowChat[] }) {
  const stacked = chats.length <= STACK_MAX;
  return (
    <section className="now-run" aria-label="Running" style={{ ["--n" as string]: chats.length }}>
      <h2 className="now-list-head">
        <span>Running</span>
        <span className="now-count">{chats.length}</span>
      </h2>
      {stacked ? (
        <div className="now-stack">
          {chats.map((c) => (
            <ChatCard key={c.sessionId} chat={c} />
          ))}
        </div>
      ) : (
        <div className="now-grid">
          {chats.map((c) => (
            <ChatCard key={c.sessionId} chat={c} />
          ))}
        </div>
      )}
      <HelperTracker chats={chats} />
    </section>
  );
}

function ChatCard({ chat }: { chat: NowChat }) {
  const working = chat.state === "working";
  const tokens = useClimb(chat.tokens);
  const { doing, swapKey } = useSteadyDoing(chat.doing);
  const name = chat.title ?? chat.project;
  const out = chat.helpers.filter((h) => !h.done).length;

  return (
    <article className="now-card card" data-state={chat.state} aria-label={name}>
      <div className="nc-body">
        <header className="nc-head">
          <h3 className="d d-figure nc-title" title={name}>
            {name}
          </h3>
          <div className="now-chips">
            {chat.title && <span className="chip">{chat.project}</span>}
            {chat.model && <span className="chip">{modelLabel(chat.model)}</span>}
            {out > 0 && (
              <span
                className="chip chip-clay nc-helpers-chip"
                title={chat.helpers
                  .filter((h) => !h.done)
                  .map((h) => h.name)
                  .join(", ")}
              >
                {plural(out, "helper")}
              </span>
            )}
          </div>
        </header>

        <Elapsed chat={chat} />

        <section className="nc-doing" aria-label="Doing now">
          <div className="nc-doing-row">
            <div className="nc-tile" data-kind={doing.kind}>
              <KindIcon kind={doing.kind} size={28} />
            </div>
            <div className="nc-doing-text" key={swapKey}>
              <p className="d nc-verb">{doing.verb}</p>
              {doing.target && (
                <p className="nc-target" title={doing.target}>
                  {doing.target}
                </p>
              )}
            </div>
          </div>
          <span className={`nc-sweep${working ? " is-on" : ""}`} aria-hidden="true" />
          <People chat={chat} />
        </section>

        <section className="nc-numbers" aria-label="Tokens used">
          <div className="nc-spend" title={tokenHint(chat.tokens, nowCost(chat.costUsd, chat.unpriced))}>
            <p className="d nc-spend-fig">{compact(Math.round(tokens))}</p>
            <p className="nc-cap">Tokens</p>
          </div>
        </section>

        <Trail steps={chat.steps} working={working} />
      </div>
    </article>
  );
}

export { useSteadyDoing };

function Elapsed({ chat }: { chat: NowChat }) {
  const working = chat.state === "working";
  const now = useClock(working, 1000);
  let text = "";
  if (working) text = chat.startedMs === null ? "" : clock(now - chat.startedMs);
  else if (chat.workedMs !== null) text = formatDuration(chat.workedMs);
  if (!text) return <div className="nc-clock" />;
  return (
    <div className="nc-clock">
      <p className="d d-stat nc-clock-fig">{text}</p>
      <p className="nc-cap">{working ? "Elapsed" : "Last turn"}</p>
    </div>
  );
}

// ---- files ----------------------------------------------------------------

function People({ chat }: { chat: NowChat }) {
  const files = chat.files.slice(0, FILES_SHOWN);
  if (files.length === 0) return null;
  return (
    <section className="nc-people" aria-label="Files">
      <ul className="nc-files">
        {files.map((f) => (
          <li key={f.path} className="nc-file" title={f.path} data-edited={f.edited || undefined}>
            {f.edited ? <PencilSimple size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
            <span>{f.path}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---- the trail ------------------------------------------------------------------------

function Trail({ steps, working }: { steps: NowStep[]; working: boolean }) {
  // Steps already on the page at mount do not animate in. A new step slides in and the rest slide
  // one slot left, but at most once per CALM_MS: when calls arrive faster than that the trail just
  // updates in place, so it never flickers.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(steps.map((s) => s.id));
  const nodes = useRef(new Map<string, HTMLLIElement>());
  const lefts = useRef(new Map<string, number>());
  const lastAnim = useRef(0);
  const ids = steps.map((s) => s.id).join("|");
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    nodes.current.forEach((el, id) => next.set(id, el.offsetLeft));
    const fresh = new Set([...next.keys()].filter((id) => !seen.current!.has(id)));
    seen.current = new Set(next.keys());
    const t = performance.now();
    if (!prefersReducedMotion() && t - lastAnim.current >= CALM_MS) {
      let moved = false;
      next.forEach((left, id) => {
        const el = nodes.current.get(id);
        if (!el) return;
        if (fresh.has(id)) {
          el.classList.add("is-new");
          setTimeout(() => el.classList.remove("is-new"), FRESH_MS);
          moved = true;
          return;
        }
        const before = lefts.current.get(id);
        if (before !== undefined && Math.abs(before - left) > 1 && typeof el.animate === "function") {
          el.animate([{ transform: `translateX(${before - left}px)` }, { transform: "none" }], {
            duration: 260,
            easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          });
          moved = true;
        }
      });
      if (moved) lastAnim.current = t;
    }
    lefts.current = next;
  }, [ids]);

  if (steps.length === 0) return <div className="nc-trail" />;
  const newest = steps[steps.length - 1]!.id;
  return (
    <ol className="nc-trail" aria-label="Recent steps">
      {steps.map((s) => (
        <li
          key={s.id}
          ref={(el) => {
            if (el) nodes.current.set(s.id, el);
            else nodes.current.delete(s.id);
          }}
          className="nc-step"
          data-done={s.done || undefined}
          data-helper={s.by ? "" : undefined}
          data-now={working && s.id === newest ? "" : undefined}
          title={[s.verb, s.target, s.count > 1 ? `(${s.count} times)` : "", s.by ? `by ${s.by}` : ""].filter(Boolean).join(" ")}
        >
          <span className="nc-dot" aria-hidden="true" />
          <span className="nc-step-verb">
            {s.verb}
            {s.count > 1 && <span className="nc-step-count">{` x${s.count}`}</span>}
          </span>
          <span className="nc-step-target">{s.target ?? ""}</span>
        </li>
      ))}
    </ol>
  );
}
