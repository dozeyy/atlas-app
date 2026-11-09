import { useMemo } from "react";
import { ArrowRight, Copy } from "@phosphor-icons/react";
import { Button, IconButton } from "../controls";
import { ProjectDot } from "./SessionList";
import { sessionName } from "./helperKit";
import { TokenText } from "./TokenText";
import { timelineBars } from "./timelineBars";
import { getBackend } from "../../lib/ipc";
import { copyResume } from "../../lib/sessionActions";
import { projectTone, shareOfMax } from "../../lib/sessionBrowse";
import { useFetched } from "../../lib/useUsage";
import { formatWhen, plural } from "../../lib/usage";
import type { SessionRow } from "../../lib/types";

const W = 144;
const H = 30;

/**
 * The newest chat as a card above the list: what it was, how big, how long ago, and the shape of
 * its activity. The strip is read after the first paint, in a space that is already reserved, so
 * nothing shifts when it arrives.
 */
export function PickUp({ row, onOpen }: { row: SessionRow; onOpen: (id: string) => void }) {
  const backend = getBackend();
  const detail = useFetched(() => backend.sessionDetail(row.sessionId), [row.sessionId]);
  const values = useMemo(
    () => timelineBars(detail.data?.timeline ?? [], row.durationMs).map((b) => b.value),
    [detail.data, row.durationMs],
  );
  const max = Math.max(0, ...values);
  const step = values.length > 0 ? W / values.length : W;
  const tone = projectTone(row.projectPath || row.projectName);

  return (
    <section aria-label="Pick up where you left off" className="pick card">
      <button type="button" className="pick-main row-btn" onClick={() => onOpen(row.sessionId)}>
        <span className="pick-kicker">Pick up where you left off</span>
        <span className="pick-title">{sessionName(row)}</span>
        <span className="pick-meta">
          <ProjectDot path={row.projectPath || row.projectName} />
          {row.projectName}
          <i aria-hidden="true">&middot;</i>
          <TokenText tokens={row.tokens.total} cost={row.cost} className="font-semibold text-ink" />
          {row.agentCount > 0 && (
            <>
              <i aria-hidden="true">&middot;</i>
              <span className="font-semibold text-accent-text">{plural(row.agentCount, "helper")}</span>
            </>
          )}
          <i aria-hidden="true">&middot;</i>
          {formatWhen(row.startedAt)}
        </span>
      </button>
      <svg aria-hidden="true" focusable="false" width={W} height={H} className="pick-strip chart">
        <line x1="0" x2={W} y1={H - 0.5} y2={H - 0.5} className="today-base" />
        {values.map((v, i) => {
          const h = max > 0 ? Math.max(1.5, shareOfMax(v, max) * (H - 3)) : 0;
          return h > 0 ? (
            <rect
              key={i}
              x={i * step + 0.5}
              y={H - 1 - h}
              width={Math.max(1.5, step - 1.5)}
              height={h}
              rx={0.75}
              fill={`var(--chart-${tone})`}
              opacity={0.9}
            />
          ) : null;
        })}
      </svg>
      <div className="pick-actions">
        <IconButton
          aria-label="Copy resume command"
          title="Copy resume command"
          onClick={() => void copyResume(row.sessionId, row.projectPath)}
        >
          <Copy size={16} aria-hidden="true" />
        </IconButton>
        <Button variant="primary" onClick={() => onOpen(row.sessionId)}>
          Open
          <ArrowRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
