import type { ReactNode } from "react";
import { CaretRight, FileX, Robot } from "@phosphor-icons/react";
import { IconMotion } from "../IconMotion";
import { formatDuration, formatWhen, compact, exact, plural } from "../../lib/usage";
import type { SessionRow } from "../../lib/types";
import { CostText } from "./CostText";
import { ModelDots, sessionName } from "./helperKit";

/**
 * A list of session rows. One column in a narrow page, two from 56rem, three from 100rem, so a
 * wide window reads as a table of rows and not one row stretched across the screen.
 */
export function SessionGrid({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden">
      <ul className="session-grid">{children}</ul>
    </div>
  );
}

/**
 * One session: what it was, where, when, how long, how much. Its helpers (subagents) are
 * counted inside it and shown on its page, never as rows of their own. A row is a list row,
 * not a card: it washes on hover, never lifts, and the whole row is the click target.
 */
export function SessionLine({ row, onOpen, index = 0 }: { row: SessionRow; onOpen: (id: string) => void; index?: number }) {
  const name = sessionName(row);
  return (
    <li className="row-in" style={{ ["--i" as string]: index }}>
      <button type="button" onClick={() => onOpen(row.sessionId)} className="row-btn items-center gap-4 px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={`truncate text-body font-semibold ${row.name ? "text-ink" : "text-ink-2"}`}>{name}</span>
            {row.agentCount > 0 && (
              <span
                title={`${plural(row.agentCount, "helper")} ran inside this session. Their usage is counted here.`}
                className="chip chip-clay shrink-0"
              >
                <IconMotion motion="tilt">
                  <Robot />
                </IconMotion>
                {plural(row.agentCount, "helper")}
              </span>
            )}
            {row.missing && (
              <span
                title="The file for this session is no longer on disk. Its numbers are kept."
                className="inline-flex shrink-0 items-center gap-1 rounded-full border border-line px-2 text-caption text-ink-2"
              >
                <FileX size={12} aria-hidden="true" />
                File removed
              </span>
            )}
          </div>
          {/* One quiet line that never wraps: it is cut with an ellipsis instead. */}
          <div className="mt-0.5 truncate text-caption text-ink-2">
            {row.projectName}
            <span aria-hidden="true"> &middot; </span>
            {formatWhen(row.startedAt)}
            <span aria-hidden="true"> &middot; </span>
            {formatDuration(row.durationMs)}
            {row.models.length > 0 && (
              <>
                <span aria-hidden="true"> &middot; </span>
                <ModelDots models={row.models} />
              </>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="d d-small text-ink">
            <CostText cost={row.cost} />
          </div>
          <div className="text-caption tabular-nums text-ink-2" title={`${exact(row.tokens.total)} tokens`}>
            {compact(row.tokens.total)} tokens
          </div>
        </div>
        <CaretRight size={14} aria-hidden="true" className="row-caret shrink-0 text-ink-2" />
      </button>
    </li>
  );
}
