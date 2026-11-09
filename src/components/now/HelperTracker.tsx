// "Helpers at work": one row per helper that is running, under the chat cards. Each row shows how
// far the helper is from its goal as a trail (a dotted path, a clay fill, a spark at the far end),
// what it is up to, and how long it has been going. Counts only: never a step, a command or a
// prompt. Calm by rule: the fill and the phase word each animate at most once per CALM_MS, and
// the one clock ticks only while a row is on screen. Spec: docs/specs/agent-scorecard.md D40-D47.

import { SPARK } from "../wrapped/graphics";
import { AgentAvatar } from "../usage/helperKit";
import { clock, nowCost } from "../../lib/nowFormat";
import { modelEffort, progressOf, statusOf, typeName } from "../../lib/helperProgress";
import type { Progress, Status } from "../../lib/helperProgress";
import type { NowChat, NowHelper } from "../../lib/nowTypes";
import { useClimb, useClock } from "../../lib/useNow";
import { useCalmFill, useHeldWord } from "../../lib/useSteadyDoing";
import { compact, plural, tokenHint } from "../../lib/usage";

/** Oldest first, and a helper with no start time after the ones that have one. Never changes while running. */
function byStart(a: NowHelper, b: NowHelper): number {
  const x = a.startedMs ?? Number.MAX_SAFE_INTEGER;
  const y = b.startedMs ?? Number.MAX_SAFE_INTEGER;
  return x - y || a.id.localeCompare(b.id);
}

interface Group {
  key: string;
  name: string;
  helpers: NowHelper[];
}

function groupsOf(chats: NowChat[]): Group[] {
  return chats
    .filter((c) => c.helpers.length > 0)
    .map((c) => ({ key: c.sessionId, name: c.title ?? c.project, helpers: [...c.helpers].sort(byStart) }));
}

export function HelperTracker({ chats }: { chats: NowChat[] }) {
  const groups = groupsOf(chats);
  const count = groups.reduce((n, g) => n + g.helpers.length, 0);
  // One clock for every row, and none when no row is on screen.
  const now = useClock(count > 0, 1000);
  if (count === 0) return null;
  const named = groups.length > 1;
  return (
    <section className="ht" aria-label="Helpers at work">
      <h2 className="now-list-head">
        <span>Helpers at work</span>
        <span className="now-count">{count}</span>
      </h2>
      <div className="ht-rows">
        {groups.map((g) => (
          <div key={g.key} className="ht-group">
            {named && (
              <p className="ht-chat" title={g.name}>
                {g.name}
              </p>
            )}
            <ul className="ht-list">
              {g.helpers.map((h) => (
                <HelperRow key={h.id} helper={h} now={now} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function HelperRow({ helper, now }: { helper: NowHelper; now: number }) {
  const progress = progressOf(helper);
  const status = statusOf(helper, now);
  const tokens = useClimb(helper.tokens);
  const name = typeName(helper.agentType);
  const model = modelEffort(helper);
  const goal = helper.goal ?? helper.name;
  return (
    <li className="ht-row card" data-done={helper.done || undefined}>
      <AgentAvatar type={helper.agentType} size={32} />
      <div className="ht-id">
        <p className="ht-head">
          <span className="ht-name">{name}</span>
          {model && (
            <span className="ht-model" title={helper.model ?? undefined}>
              {model}
            </span>
          )}
        </p>
        <p className="ht-goal" title={goal}>
          {goal}
        </p>
      </div>
      <Trail progress={progress} done={helper.done} />
      <div className="ht-prog" title={progress.hint}>
        <p className="ht-prog-text">{helper.done ? "Finished" : progress.text}</p>
        <p className="nc-cap">{plural(helper.toolCalls, "tool call")}</p>
      </div>
      <PhaseWord phase={helper.phase} status={status} done={helper.done} />
      <p className="d d-small ht-elapsed">{helper.startedMs === null ? "" : clock(now - helper.startedMs)}</p>
      <p className="d d-small ht-tokens" data-opt="2" title={tokenHint(helper.tokens, nowCost(helper.costUsd, false))}>
        {compact(Math.round(tokens))}
      </p>
    </li>
  );
}

/**
 * The phase word, or the quiet-for-a-while line. The phase word is held for PHASE_HOLD_MS before the
 * next one replaces it (it flips on nearly every call otherwise). The quiet line shows at once and
 * its minute count changes in place, so the line never re-mounts when only the count moves.
 */
function PhaseWord({ phase, status, done }: { phase: string; status: Status; done: boolean }) {
  const held = useHeldWord(phase);
  if (done) {
    return (
      <p className="ht-status" data-tone="phase" key="done">
        Done
      </p>
    );
  }
  if (status.tone !== "phase") {
    return (
      <p className="ht-status" data-tone={status.tone} title={status.text} key="stuck">
        {status.text}
      </p>
    );
  }
  return (
    <p className="ht-status" data-tone="phase" title={held.text} key={`phase-${held.swapKey}`}>
      {held.text}
    </p>
  );
}

/**
 * The trail: a dotted path, the fill from the start up to the progress point, and a spark at the
 * goal. The spark rests as an outline and fills with the clay only when the helper finishes.
 */
function Trail({ progress, done }: { progress: Progress; done: boolean }) {
  const { fill, animate } = useCalmFill(done ? 1 : progress.fill);
  return (
    <div className="ht-trail" data-kind={progress.kind} data-done={done || undefined} aria-hidden="true">
      <span className="ht-path" />
      {fill !== null && <span className="ht-fill" data-anim={animate || undefined} style={{ ["--fill" as string]: Math.round(fill * 1000) / 10 }} />}
      <svg className="ht-spark" viewBox="-1.25 -1.25 2.5 2.5" width="16" height="16">
        <path d={SPARK} />
      </svg>
    </div>
  );
}
