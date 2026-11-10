import type { ReactNode } from "react";
import { clockOf, projectTone } from "../../lib/sessionBrowse";
import { effortMix, formatWhen, modelWithEffort, plural, topEffort } from "../../lib/usage";
import type { SessionRow } from "../../lib/types";
import type { SnippetPart } from "../../lib/searchTypes";
import { sessionName } from "./helperKit";
import { TokenText } from "./TokenText";

/**
 * A list of session rows. One column in a narrow page, two from 56rem, three from 100rem, so a
 * wide window reads as a table of rows and not one row stretched across the screen.
 */
export function SessionGrid({ children }: { children: ReactNode }) {
  return (
    <div className="session-clip">
      <ul className="session-grid">{children}</ul>
    </div>
  );
}

/** A found message, cut to one line: the words that matched are heavier and darker, nothing is boxed. */
export function Snippet({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <span key={i} className="font-semibold text-ink">
            {p.text}
          </span>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** A small dot in the project's colour: the same project is the same colour in every list. */
export function ProjectDot({ path }: { path: string }) {
  return <span aria-hidden="true" className="proj-dot" style={{ background: `var(--chart-${projectTone(path)})` }} />;
}

const DOT = (
  <span aria-hidden="true" className="mx-1.5 text-ink-2/60">
    &middot;
  </span>
);

/** A project name past this many characters is the first thing on the meta line to shorten. */
const LONG_PROJECT = 14;

/** The row's model hover: the exact id, then the effort mix when one was recorded. */
function effortTitle(row: SessionRow): string {
  const mix = effortMix(row.efforts);
  return mix ? `${row.mainModel}, reasoning effort: ${mix}` : `${row.mainModel}, no reasoning effort recorded`;
}

/**
 * One session. Its helpers (subagents) are counted inside it and shown on its page, never as rows
 * of their own. A row is a list row, not a card: it washes on hover, never lifts, and the whole
 * row is the click target. No icons, pills or boxes: the hierarchy is type alone.
 *
 *   line 1  the title, one step up the type scale (16/24, bold): what the chat was
 *   line 2  the meta line, 12/16, in Will's order (2026-11-08), left to right:
 *             which project / folder  >  the tokens (bold; the API-price estimate is in its
 *             hover)  >  whether helpers ran (accent-colored text, no chip)  >  when it happened
 *             (the time alone, "16:42", under a day band that already names the day; the
 *             whole date is then in its hover)
 *             >  the main model with its most used reasoning effort ("Opus 5.5 · high"; the
 *             full mix is in its hover; no effort recorded shows the model alone)
 *           A removed file adds "File removed" at the end, as plain text.
 *   line 3  only when a message search found words inside this chat: one line of it, matches bold
 *
 * Rhythm: 14 px above and below, 4 px between the title and the meta (a 72 px row without a
 * snippet), so every row is the same height and the rules fall on an even beat.
 */
export function SessionLine({
  row,
  onOpen,
  index = 0,
  snippet,
  barShare,
  dayKnown = false,
}: {
  row: SessionRow;
  onOpen: (id: string) => void;
  index?: number;
  snippet?: SnippetPart[];
  /** This chat's tokens as a share (0 to 1) of the biggest chat in view: draws a hairline bar by the count. */
  barShare?: number;
  /** The row sits under a band that names its day: it says the time only, never the day twice. */
  dayKnown?: boolean;
}) {
  const name = sessionName(row);
  return (
    <li className="row-in" style={{ ["--i" as string]: index }}>
      <button type="button" onClick={() => onOpen(row.sessionId)} className="row-btn flex-col justify-center px-5 py-3.5">
        <span title={name} className={`block w-full truncate text-lead font-bold ${row.name ? "text-ink" : "text-ink-2"}`}>
          {name}
        </span>
        {/* One quiet line that never wraps. When it is tight the project name gives way (ellipsis); the tokens, helpers and date stay whole.
            A long project name gives way first, down to a short stub, so the model after it is not the one cut. */}
        <span className="mt-1 flex w-full min-w-0 items-baseline truncate text-caption text-ink-2">
          <span
            data-tip={row.projectPath || row.projectName}
            className={`truncate ${row.projectName.length > LONG_PROJECT ? "min-w-24 shrink-[99]" : "min-w-0"}`}
          >
            <ProjectDot path={row.projectPath || row.projectName} />
            {row.projectName}
          </span>
          <span className="shrink-0">{DOT}</span>
          <span className="shrink-0">
            <TokenText tokens={row.tokens.total} cost={row.cost} className="font-semibold text-ink" />
            {barShare !== undefined && (
              <span aria-hidden="true" className="tok-bar">
                <i style={{ width: `${Math.round(barShare * 100)}%` }} />
              </span>
            )}
          </span>
          {row.agentCount > 0 && (
            <span className="shrink-0">
              {DOT}
              <span
                title={`${plural(row.agentCount, "helper")} ran inside this session. Their usage is counted here.`}
                className="font-semibold text-accent-text"
              >
                {plural(row.agentCount, "helper")}
              </span>
            </span>
          )}
          <span className="shrink-0">
            {DOT}
            {dayKnown ? <span title={formatWhen(row.startedAt)}>{clockOf(row.startedAt)}</span> : formatWhen(row.startedAt)}
          </span>
          {row.mainModel && (
            <span className="min-w-0 truncate" title={effortTitle(row)}>
              {DOT}
              {modelWithEffort(row.mainModel, topEffort(row.efforts))}
            </span>
          )}
          {row.missing && (
            <span className="shrink-0">
              {DOT}
              <span title="The file for this session is no longer on disk. Its numbers are kept.">File removed</span>
            </span>
          )}
        </span>
        {snippet && snippet.length > 0 && (
          <span className="mt-1 block w-full truncate text-caption text-ink-2">
            <Snippet parts={snippet} />
          </span>
        )}
      </button>
    </li>
  );
}
