import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { ComponentType } from "react";
import {
  Binoculars,
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
import { ago, clock } from "../lib/nowFormat";
import type { NowChat, NowHelper, NowLast, NowStep } from "../lib/nowTypes";
import { useClimb, useClock, useNowSnapshot } from "../lib/useNow";
import { compact, formatDuration, modelLabel, plural, tokenHint } from "../lib/usage";
import type { Cost } from "../lib/usageTypes";
import "../styles/now.css";

/** More chats than this and the cards turn into a compact grid. */
const STACK_MAX = 3;
const GRID_MAX = 5;
const HELPERS_SHOWN = 3;
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
  return (
    <>
      <PageTitle title="Now" />
      <div className="now-root">
        {snap === null ? null : !snap.watching ? (
          <Quiet title="No Claude folder found" />
        ) : snap.chats.length === 0 ? (
          <Quiet title={snap.last ? (snap.last.title ?? snap.last.project) : "No chats yet"} last={snap.last} />
        ) : snap.chats.length <= STACK_MAX ? (
          <div className="now-stack" style={{ ["--n" as string]: snap.chats.length }}>
            {snap.chats.map((c) => (
              <ChatCard key={c.sessionId} chat={c} />
            ))}
          </div>
        ) : (
          <div className="now-grid">
            {snap.chats.slice(0, GRID_MAX).map((c) => (
              <ChatCard key={c.sessionId} chat={c} />
            ))}
            {snap.chats.length > GRID_MAX && (
              <p className="now-more chip">{`+${snap.chats.length - GRID_MAX} more`}</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}

// ---- nothing running -----------------------------------------------------------------

function Quiet({ title, last }: { title: string; last?: NowLast | null }) {
  const now = useClock(!!last, 30_000);
  return (
    <section className="now-quiet card">
      <Topo seed={21} />
      <div className="now-quiet-tile">
        <Binoculars size={28} weight="duotone" aria-hidden="true" />
      </div>
      <h2 className="d d-title now-quiet-title">{title}</h2>
      {last && (
        <>
          <div className="now-chips">
            {last.title && <span className="chip">{last.project}</span>}
            {last.model && <span className="chip">{modelLabel(last.model)}</span>}
          </div>
          <p className="now-quiet-when">{`Ended ${ago(last.endedMs, now)}`}</p>
        </>
      )}
    </section>
  );
}

// ---- a running chat ------------------------------------------------------------------

/** The live snapshot carries a dollar estimate and a flag, not a full Cost: rebuild one for the hover. */
function nowCost(usd: number | null, unpriced: boolean): Cost {
  return { usd, complete: !unpriced, unpricedTokens: 0 };
}

function ChatCard({ chat }: { chat: NowChat }) {
  const working = chat.state === "working";
  const tokens = useClimb(chat.tokens);
  const name = chat.title ?? chat.project;
  const out = chat.helpers.filter((h) => !h.done).length;

  return (
    <article className="now-card card" data-state={chat.state} aria-label={name}>
      <div className="nc-body">
      <header className="nc-head">
        <h2 className="d d-figure nc-title" title={name}>
          {name}
        </h2>
        <div className="now-chips">
          {chat.title && <span className="chip">{chat.project}</span>}
          {chat.model && <span className="chip">{modelLabel(chat.model)}</span>}
          {out > 0 && <span className="chip chip-clay nc-helpers-chip">{plural(out, "helper")}</span>}
        </div>
      </header>

      <Elapsed chat={chat} />

      <section className="nc-doing" aria-label="Doing now">
        <div className="nc-doing-row">
          <div className="nc-tile" data-kind={chat.doing.kind}>
            <KindIcon kind={chat.doing.kind} size={28} />
          </div>
          <div className="nc-doing-text" key={chat.doing.verb + "|" + (chat.doing.target ?? "")}>
            <p className="d nc-verb">{chat.doing.verb}</p>
            {chat.doing.target && (
              <p className="nc-target" title={chat.doing.target}>
                {chat.doing.target}
              </p>
            )}
          </div>
        </div>
        <span className={`nc-sweep${working ? " is-on" : ""}`} aria-hidden="true" />
      </section>

      <section className="nc-numbers" aria-label="Tokens used">
        <div className="nc-spend" title={tokenHint(chat.tokens, nowCost(chat.costUsd, chat.unpriced))}>
          <p className="d nc-spend-fig">{compact(Math.round(tokens))}</p>
          <p className="nc-cap">Tokens</p>
        </div>
      </section>

      <People chat={chat} />
      <Trail steps={chat.steps} working={working} />
      </div>
    </article>
  );
}

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

// ---- helpers and files ----------------------------------------------------------------

function People({ chat }: { chat: NowChat }) {
  const shown = chat.helpers.slice(0, HELPERS_SHOWN);
  const more = chat.helpers.length - shown.length;
  const files = chat.files.slice(0, FILES_SHOWN);
  if (shown.length === 0 && files.length === 0) return <div className="nc-people" />;
  return (
    <section className="nc-people" aria-label="Helpers and files">
      {shown.map((h) => (
        <Helper key={h.id} helper={h} />
      ))}
      {more > 0 && <span className="chip nc-more">{`+${more} more`}</span>}
      {files.length > 0 && (
        <ul className="nc-files">
          {files.map((f) => (
            <li key={f.path} className="nc-file" title={f.path} data-edited={f.edited || undefined}>
              {f.edited ? <PencilSimple size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />}
              <span>{f.path}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Helper({ helper }: { helper: NowHelper }) {
  const tokens = useClimb(helper.tokens);
  const line = helper.done ? "Done" : helper.doing ? [helper.doing.verb, helper.doing.target].filter(Boolean).join(" ") : "";
  return (
    <div className="nc-helper" data-done={helper.done || undefined}>
      <KindIcon kind={helper.doing?.kind ?? "think"} size={18} />
      <div className="nc-helper-text">
        <p className="nc-helper-name" title={helper.name}>
          {helper.name}
        </p>
        <p className="nc-helper-doing" title={line}>
          {line}
        </p>
      </div>
      <p className="d d-small nc-helper-spend" title={tokenHint(helper.tokens, nowCost(helper.costUsd, false))}>
        {compact(Math.round(tokens))}
      </p>
    </div>
  );
}

// ---- the trail ------------------------------------------------------------------------

function Trail({ steps, working }: { steps: NowStep[]; working: boolean }) {
  // Steps already on the page at mount (or already shown a moment ago) do not animate in.
  const seen = useRef<Set<string> | null>(null);
  if (seen.current === null) seen.current = new Set(steps.map((s) => s.id));
  const fresh = useMemo(() => steps.filter((s) => !seen.current!.has(s.id)).map((s) => s.id), [steps]);
  useEffect(() => {
    if (fresh.length === 0) return;
    const t = setTimeout(() => fresh.forEach((id) => seen.current!.add(id)), FRESH_MS);
    return () => clearTimeout(t);
  }, [fresh]);

  // When the oldest step drops off, the rest slide one slot left instead of jumping.
  const nodes = useRef(new Map<string, HTMLLIElement>());
  const lefts = useRef(new Map<string, number>());
  const ids = steps.map((s) => s.id).join("|");
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    nodes.current.forEach((el, id) => next.set(id, el.offsetLeft));
    if (!prefersReducedMotion()) {
      next.forEach((left, id) => {
        const before = lefts.current.get(id);
        const el = nodes.current.get(id);
        if (before !== undefined && Math.abs(before - left) > 1 && el && typeof el.animate === "function") {
          el.animate([{ transform: `translateX(${before - left}px)` }, { transform: "none" }], {
            duration: 320,
            easing: "cubic-bezier(0.34, 1.56, 0.64, 1)",
          });
        }
      });
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
          className={`nc-step${fresh.includes(s.id) ? " is-new" : ""}`}
          data-done={s.done || undefined}
          data-helper={s.by ? "" : undefined}
          title={[s.verb, s.target, s.by ? `by ${s.by}` : ""].filter(Boolean).join(" ")}
        >
          {working && s.id === newest ? <span className="spark nc-spark" aria-hidden="true" /> : <span className="nc-dot" aria-hidden="true" />}
          <span className="nc-step-verb">{s.verb}</span>
          <span className="nc-step-target">{s.target ?? ""}</span>
        </li>
      ))}
    </ol>
  );
}
