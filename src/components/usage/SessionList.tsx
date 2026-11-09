import type { ReactNode } from "react";
import { formatWhen, plural } from "../../lib/usage";
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

const DOT = (
  <span aria-hidden="true" className="mx-1.5 text-ink-2/60">
    &middot;
  </span>
);

/**
 * One session. Its helpers (subagents) are counted inside it and shown on its page, never as rows
 * of their own. A row is a list row, not a card: it washes on hover, never lifts, and the whole
 * row is the click target. No icons, pills or boxes: the hierarchy is type alone.
 *
 *   line 1  the title, one step up the type scale (16/24, bold): what the chat was
 *   line 2  the meta line, 12/16, in Will's order (2026-11-08), left to right:
 *             which project / folder  >  the tokens (bold; the API-price estimate is in its
 *             hover)  >  whether helpers ran (accent-colored text, no chip)  >  when it happened
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
}: {
  row: SessionRow;
  onOpen: (id: string) => void;
  index?: number;
  snippet?: SnippetPart[];
}) {
  const name = sessionName(row);
  return (
    <li className="row-in" style={{ ["--i" as string]: index }}>
      <button type="button" onClick={() => onOpen(row.sessionId)} className="row-btn flex-col justify-center px-5 py-3.5">
        <span className={`block w-full truncate text-lead font-bold ${row.name ? "text-ink" : "text-ink-2"}`}>{name}</span>
        {/* One quiet line that never wraps: it is cut with an ellipsis instead. */}
        <span className="mt-1 block w-full truncate text-caption text-ink-2">
          {row.projectName}
          {DOT}
          <TokenText tokens={row.tokens.total} cost={row.cost} className="font-semibold text-ink" />
          {row.agentCount > 0 && (
            <>
              {DOT}
              <span
                title={`${plural(row.agentCount, "helper")} ran inside this session. Their usage is counted here.`}
                className="font-semibold text-accent-text"
              >
                {plural(row.agentCount, "helper")}
              </span>
            </>
          )}
          {DOT}
          {formatWhen(row.startedAt)}
          {row.missing && (
            <>
              {DOT}
              <span title="The file for this session is no longer on disk. Its numbers are kept.">File removed</span>
            </>
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
