import { Clock, FileX } from "@phosphor-icons/react";
import { formatDuration, formatWhen, modelLabel, compact, exact } from "../../lib/usage";
import type { SessionRow } from "../../lib/types";
import { CostText } from "./CostText";

/** One line per session: what it was, where, when, how long, how much. */
export function SessionLine({ row, onOpen }: { row: SessionRow; onOpen: (id: string) => void }) {
  const title = row.title?.trim() || "Untitled session";
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(row.sessionId)}
        className="press grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-0.5 px-5 py-3 text-left hover:bg-raised"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`truncate text-body font-medium ${row.title ? "text-ink" : "text-ink-2"}`}>{title}</span>
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
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 text-caption text-ink-2">
            <span className="truncate">{row.projectName}</span>
            <span>{formatWhen(row.startedAt)}</span>
            <span className="inline-flex items-center gap-1">
              <Clock size={12} aria-hidden="true" />
              {formatDuration(row.durationMs)}
            </span>
            <span>{row.models.map(modelLabel).join(", ")}</span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-body tabular-nums text-ink">
            <CostText cost={row.cost} />
          </div>
          <div className="text-caption tabular-nums text-ink-2" title={`${exact(row.tokens.total)} tokens`}>
            {compact(row.tokens.total)} tokens
          </div>
        </div>
      </button>
    </li>
  );
}
