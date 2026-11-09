import { useMemo } from "react";
import { ArrowRight, Copy } from "@phosphor-icons/react";
import { Button, IconButton } from "../controls";
import { ProjectDot } from "./SessionList";
import { sessionName } from "./helperKit";
import { TokenText } from "./TokenText";
import { timelineBars } from "./timelineBars";
import { getBackend } from "../../lib/ipc";
import { copyResume } from "../../lib/sessionActions";
import { projectTone, resumeCommand } from "../../lib/sessionBrowse";
import { sparkShape } from "../../lib/todayStat";
import { useAtlas } from "../../state/AtlasProvider";
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
  const { info } = useAtlas();
  const resume = resumeCommand(row.sessionId, row.projectPath, info.platform);
  const detail = useFetched(() => backend.sessionDetail(row.sessionId), [row.sessionId]);
  const values = useMemo(
    () => timelineBars(detail.data?.timeline ?? [], row.durationMs).map((b) => b.value),
    [detail.data, row.durationMs],
  );
  // A trace needs a few steps to say anything; with fewer, only the floor is drawn. It is smoothed
  // monotonically, so it never dips below its baseline.
  const shape = useMemo(() => sparkShape(values, W, H), [values]);
  const trace = values.length >= 3 && !shape.empty;
  const color = `var(--chart-${projectTone(row.projectPath || row.projectName)})`;

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
        <title>Tokens through the chat</title>
        <line x1="0" x2={W} y1={shape.baseline} y2={shape.baseline} className="today-base" />
        {trace && (
          <>
            <path d={shape.area} fill={color} opacity={0.16} />
            <path d={shape.line} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            {shape.last && <circle cx={shape.last[0]} cy={shape.last[1]} r={2} fill={color} />}
          </>
        )}
      </svg>
      <div className="pick-actions">
        {resume && (
          <IconButton aria-label="Copy resume command" title="Copy resume command" onClick={() => void copyResume(resume)}>
            <Copy size={16} aria-hidden="true" />
          </IconButton>
        )}
        <Button variant="primary" onClick={() => onOpen(row.sessionId)}>
          Open
          <ArrowRight size={14} aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
