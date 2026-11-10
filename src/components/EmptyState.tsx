import { useId, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { CaretRight, MagnifyingGlass, WarningCircle } from "@phosphor-icons/react";
import type { IconProps } from "@phosphor-icons/react";
import { Button } from "./controls";
import { Topo } from "./Topo";

/*
 * EmptyState: the one treatment for "nothing here yet", "nothing matches" and "this could not load".
 * Every page uses this component for those three cases; nothing else draws them.
 *
 * Which variant
 *   empty     (default) A page, pane or list that has nothing yet. Contour backdrop, the 40 px spark,
 *             a title that says what is missing, one sentence that says what will appear, and at
 *             most one action (`action`, or one Button as the child).
 *   no-match  A search or filter that found nothing. Pass `query` (what was typed) and `action`
 *             (clear it; the label defaults to "Clear search"). No backdrop and no spark: it is a
 *             passing state inside a list, not the page's first run.
 *   error     Something could not be read or loaded. A calm zone: a plain sentence, the raw reason
 *             (paths, codes, the engine's own words) only behind "Details", and an outlined action
 *             (defaults to "Try again"). Never a filled clay button, never a path in `title` or `body`.
 *
 * Rules
 *   - One per region. `fill` when the parent is a flex column and the state takes the rest of it.
 *   - `compact` inside a popup, a sheet or a card: no frame, tighter padding, a smaller mark.
 *   - Title: sentence case, no full stop, about six words. Body: one sentence, or nothing.
 *   - Not for a card that misses one datum ("No model has been used in the last 30 days"): that is
 *     one line of `text-body text-ink-2` inside the card.
 *
 *   <EmptyState title="No chats yet" body="Start Claude Code in any folder and it shows up here." />
 *   <EmptyState variant="no-match" query={query} action={{ onClick: clear }} />
 *   <EmptyState variant="error" title="Atlas could not read your toolkit" reason={message} action={{ onClick: retry }} />
 */

export interface EmptyAction {
  /** Defaults: "Clear search" (no-match), "Try again" (error). */
  label?: string;
  onClick: () => void;
}

interface Common {
  /** Grow to take the rest of a page that is a flex column, so the state never floats in blank space. */
  fill?: boolean;
  /** Inside a popup, sheet or card: no frame, tighter padding. */
  compact?: boolean;
  /** Extra classes on the outer box, e.g. a min-height. */
  className?: string;
}

interface EmptyProps extends Common {
  variant?: "empty";
  title: string;
  body?: string;
  action?: EmptyAction & { label: string };
  /** Which contour drawing; give each page its own number so two empty pages do not look identical. */
  seed?: number;
  /** One Button, when the action needs more than a label (an icon, the page's primary action). */
  children?: ReactNode;
  /** @deprecated The mark is always the spark. Kept so older call sites compile; not drawn. */
  icon?: ComponentType<IconProps>;
  /** @deprecated Not drawn: an empty state says one thing. */
  badge?: string;
}

interface NoMatchProps extends Common {
  variant: "no-match";
  /** What was typed. Left out when only filters are on. */
  query?: string;
  /** Replaces the default line, for a list that names its things ("No chats match"). */
  title?: string;
  body?: string;
  action?: EmptyAction;
}

interface ErrorProps extends Common {
  variant: "error";
  /** What happened, in plain words: "Atlas could not read your usage". */
  title: string;
  /** The next step, when "Try again" does not say it all. Never a path or a code. */
  body?: string;
  /** The raw reason. Shown only behind "Details", selectable so it can be copied. */
  reason?: string | null;
  action?: EmptyAction;
}

export type EmptyStateProps = EmptyProps | NoMatchProps | ErrorProps;

const FRAME = "rounded-card border border-line bg-surface";

function Details({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="relative mt-3 flex w-full max-w-[60ch] flex-col items-center">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
        className="press inline-flex h-7 cursor-pointer items-center gap-1 rounded-control px-2 text-caption hover:bg-raised"
      >
        <CaretRight size={12} aria-hidden="true" className={`text-ink-2 ${open ? "rotate-90" : ""}`} />
        <span className="text-ink-2">Details</span>
      </button>
      {open && (
        <p id={id} className="code-text selectable mt-2 max-h-32 w-full overflow-y-auto break-words rounded-control border border-line bg-raised px-3 py-2 text-left text-ink-2">
          {reason}
        </p>
      )}
    </div>
  );
}

export function EmptyState(props: EmptyStateProps) {
  const { fill, compact, className = "" } = props;
  const variant = props.variant ?? "empty";
  const framed = !compact && variant !== "no-match";
  const pad = compact ? "px-4 py-6" : variant === "no-match" ? "px-8 py-10" : "px-8 py-12";
  const minH = compact || className.includes("min-h-") ? "" : variant === "empty" ? "min-h-[320px]" : "min-h-[200px]";
  const box = `relative isolate flex ${fill ? "flex-1" : ""} flex-col items-center justify-center overflow-hidden text-center ${framed ? FRAME : ""} ${pad} ${minH} ${className}`;

  if (props.variant === "error") {
    const { title, body, reason, action } = props;
    return (
      <section role="alert" className={box}>
        <WarningCircle size={compact ? 20 : 24} weight="fill" aria-hidden="true" className="text-danger" />
        <h2 className="h-section mt-3 max-w-[44ch] text-balance">{title}</h2>
        {body && <p className="mt-1 max-w-[44ch] text-pretty text-body text-ink-2">{body}</p>}
        {action && (
          <Button className="mt-4" onClick={action.onClick}>
            {action.label ?? "Try again"}
          </Button>
        )}
        {reason && <Details reason={reason} />}
      </section>
    );
  }

  if (props.variant === "no-match") {
    const { query, title, body, action } = props;
    const q = query?.trim();
    return (
      <section role="status" className={box}>
        <MagnifyingGlass size={compact ? 20 : 24} aria-hidden="true" className="text-ink-2" />
        <h2 className="h-section mt-3 flex max-w-full items-baseline justify-center gap-1">
          {title ? (
            title
          ) : q ? (
            <>
              <span className="shrink-0">Nothing matches</span>
              <span className="min-w-0 truncate" title={q}>{`"${q}"`}</span>
            </>
          ) : (
            "Nothing matches these filters"
          )}
        </h2>
        {body && <p className="mt-1 max-w-[44ch] text-pretty text-body text-ink-2">{body}</p>}
        {action && (
          <Button className="mt-4" onClick={action.onClick}>
            {action.label ?? "Clear search"}
          </Button>
        )}
      </section>
    );
  }

  const { title, body, action, seed, children } = props;
  return (
    <section className={box}>
      {!compact && <Topo seed={seed} />}
      <span aria-hidden="true" className={`spark relative ${compact ? "size-6" : "size-10"}`} />
      <h2 className="h-section relative mt-4 max-w-[44ch] text-balance">{title}</h2>
      {body && <p className="relative mt-1 max-w-[44ch] text-pretty text-body text-ink-2">{body}</p>}
      {(action || children) && (
        <div className="relative mt-4">{action ? <Button onClick={action.onClick}>{action.label}</Button> : children}</div>
      )}
    </section>
  );
}
