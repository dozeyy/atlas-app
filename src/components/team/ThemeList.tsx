import { useState } from "react";
import type { ReactNode } from "react";
import { CaretRight, Check } from "@phosphor-icons/react";
import { Button } from "../controls";
import { AgentAvatar } from "../usage/helperKit";
import { madeLabel, severityLine } from "../../lib/teamModel";
import { exact, formatWhen, plural } from "../../lib/usage";
import type { ReviewTheme, ThemeExample, Themes } from "../../lib/teamTypes";

const SHOWN = 12;

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-0.5 text-body">
      <dt className="w-32 shrink-0 text-ink-2">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-ink">{children}</dd>
    </div>
  );
}

/**
 * Helpers as avatar, name and count: the same picture a helper has on its card. The count is a
 * plain number after the name ("Code reviewer 4"), never in brackets; hovering says "4 times".
 */
function Who({ list, nameOf, extra, none }: { list: { agentType: string; count: number }[]; nameOf: (type: string) => string; extra?: { label: string; count: number }; none: string }) {
  if (list.length === 0 && !extra) return <>{none}</>;
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
      {list.map((x) => (
        <li key={x.agentType} className="flex min-w-0 max-w-full items-center gap-1.5">
          <AgentAvatar type={x.agentType} size={20} quiet />
          <span title={nameOf(x.agentType)} className="min-w-0 truncate">
            {nameOf(x.agentType)}
          </span>
          <span title={plural(x.count, "time")} className="shrink-0 tabular-nums text-ink-2">
            {exact(x.count)}
          </span>
        </li>
      ))}
      {extra && (
        <li className="flex min-w-0 max-w-full items-center gap-1.5 text-ink-2">
          <span className="min-w-0">{extra.label}</span>
          <span title={plural(extra.count, "time")} className="shrink-0 tabular-nums">
            {exact(extra.count)}
          </span>
        </li>
      )}
    </ul>
  );
}

function ThemeRow({
  theme,
  made,
  nameOf,
  onMakeRule,
  onOpenExample,
}: {
  theme: ReviewTheme;
  made: { path: string; madeMs: number } | undefined;
  nameOf: (type: string) => string;
  onMakeRule: (t: ReviewTheme) => void;
  onOpenExample: (e: ThemeExample) => void;
}) {
  const [open, setOpen] = useState(false);
  const sev = severityLine(theme);
  return (
    <li className="team-theme border-b border-line last:border-b-0">
      <div className="flex items-start gap-3 py-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="press team-theme-head flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-control text-left"
        >
          <CaretRight size={14} weight="bold" aria-hidden="true" className={`team-caret mt-1 shrink-0 text-ink-2 ${open ? "team-caret-open" : ""}`} />
          {/* A long theme is two lines until it is opened (the whole text on hover); it never runs under the button beside it. */}
          <span className="min-w-0 flex-1 break-words">
            <span title={open ? undefined : theme.label} className={`selectable block text-body font-medium text-ink ${open ? "" : "line-clamp-2"}`}>
              {theme.label}
            </span>
            <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-2">
              {theme.foundInWorkBy.length > 0 && (
                <span title={`Found in work by ${theme.foundInWorkBy.map((x) => nameOf(x.agentType)).join(", ")}`} className="flex shrink-0 items-center gap-1">
                  {theme.foundInWorkBy.slice(0, 3).map((x) => (
                    <AgentAvatar key={x.agentType} type={x.agentType} size={20} quiet />
                  ))}
                </span>
              )}
              <span className="min-w-0">
                {`Raised ${plural(theme.count, "time")} in ${plural(theme.runs, "run")}`}
                {sev ? `. ${sev}` : ""}
              </span>
            </span>
          </span>
        </button>
        {made ? (
          <span title={made.path} className="mt-1 flex shrink-0 items-center gap-1.5 text-body text-success">
            <Check size={14} weight="bold" aria-hidden="true" />
            {madeLabel(made.madeMs)}
          </span>
        ) : (
          <Button className="shrink-0" onClick={() => onMakeRule(theme)}>
            Make this a rule
          </Button>
        )}
      </div>
      {open && (
        <dl className="mb-3 ml-5 rounded-control bg-raised px-4 py-3">
          <Detail label="Found in work by">
            <Who list={theme.foundInWorkBy} nameOf={nameOf} extra={theme.notTied > 0 ? { label: "Not tied to one helper", count: theme.notTied } : undefined} none="Not tied to one helper" />
          </Detail>
          <Detail label="Raised by">
            <Who list={theme.reviewers} nameOf={nameOf} none="Not known" />
          </Detail>
          {theme.projects.length > 0 && (
            <Detail label="Projects">
              <span title={theme.projects.join(", ")} className="line-clamp-2">
                {theme.projects.join(", ")}
              </span>
            </Detail>
          )}
          <Detail label="Last seen">{formatWhen(theme.lastSeen)}</Detail>
          {theme.examples.length > 0 && (
            <Detail label="Seen like this">
              <ul className="space-y-1">
                {theme.examples.map((e) => (
                  <li key={`${e.sessionId}-${e.agentId}-${e.ts}`}>
                    <button
                      type="button"
                      onClick={() => onOpenExample(e)}
                      title={`${e.text}\nOpens the review that said this.`}
                      className="selectable cursor-pointer text-left text-ink hover:text-accent-text hover:underline"
                    >
                      <span className="line-clamp-2">{e.text}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Detail>
          )}
        </dl>
      )}
    </li>
  );
}

/** The repeated things reviewers caught, most often first. The top twelve, then "Show all". */
export function ThemeList({
  data,
  nameOf,
  onMakeRule,
  onOpenExample,
}: {
  data: Themes;
  nameOf: (type: string) => string;
  onMakeRule: (t: ReviewTheme) => void;
  onOpenExample: (e: ThemeExample) => void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? data.themes : data.themes.slice(0, SHOWN);
  const hidden = data.themes.length - shown.length;
  return (
    <section aria-label="Caught in review" className="rounded-card border border-line bg-surface px-5">
      <ul>
        {shown.map((t) => (
          <ThemeRow key={t.id} theme={t} made={data.made[t.id]} nameOf={nameOf} onMakeRule={onMakeRule} onOpenExample={onOpenExample} />
        ))}
      </ul>
      {hidden > 0 && (
        <div className="border-t border-line py-3">
          <Button onClick={() => setAll(true)}>{`Show all ${data.themes.length}`}</Button>
        </div>
      )}
    </section>
  );
}
