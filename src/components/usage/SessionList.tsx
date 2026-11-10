import type { ReactNode } from "react";
import { projectTone } from "../../lib/sessionBrowse";
import { clockTime, effortMix, formatWhen, modelWithEffort, percent, plural, topEffort } from "../../lib/usage";
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

/** A found message, cut to one line: the words that matched are marked the way a title's are. */
export function Snippet({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="sl-hit font-semibold text-ink">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/**
 * `text` cut where the typed words are found (any case, anywhere in a word), so a row can mark
 * why it is in the list. Nothing typed, or nothing found: the text comes back whole.
 */
export function hitParts(text: string, query: string | undefined): SnippetPart[] {
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const low = text.toLowerCase();
  if (words.length === 0 || low.length !== text.length) return [{ text, hit: false }];
  const marks = new Array<boolean>(text.length).fill(false);
  for (const w of words) for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) marks.fill(true, i, i + w.length);
  const parts: SnippetPart[] = [];
  for (let i = 0; i < text.length; ) {
    let j = i + 1;
    while (j < text.length && marks[j] === marks[i]) j++;
    parts.push({ text: text.slice(i, j), hit: marks[i] });
    i = j;
  }
  return parts;
}

/** Text with the typed words marked. */
function Marked({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>;
  return (
    <>
      {hitParts(text, query).map((p, i) =>
        p.hit ? (
          <mark key={i} className="sl-hit">
            {p.text}
          </mark>
        ) : (
          p.text
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

/** A project name up to this many characters is never cut: there is nothing left of it to read once it is. */
const SHORT_PROJECT = 8;

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
 *   line 2  the meta line, 12/16, in the decided order (2026-11-08), left to right:
 *             which project / folder  >  the tokens (bold; the API-price estimate is in its
 *             hover)  >  whether helpers ran (accent-colored text, no chip)  >  when it happened
 *             (the time alone, "16:42", under a day band that already names the day; the
 *             whole date is then in its hover)
 *             >  the main model with its most used reasoning effort ("Opus 5.5, high effort"; the
 *             full mix is in its hover; no effort recorded shows the model alone)
 *           A removed file adds "File removed" after the date, as plain text.
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
  query,
}: {
  row: SessionRow;
  onOpen: (id: string) => void;
  index?: number;
  snippet?: SnippetPart[];
  /** What is typed in the search box: where it is found in the title or the project, it is marked. */
  query?: string;
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
          <Marked text={name} query={query} />
        </span>
        {/* One quiet line that never wraps and never shows a stub. What gives way, in order: a long project name shortens to
            its cap; the model drops out whole (it is on the chat's own page); the project shortens to a short stub; and in a
            narrow column (the Dashboard's) the helpers drop out whole. Tokens and the date always stay. Rules: .sl-meta. */}
        <span className="sl-meta mt-1 w-full min-w-0 truncate text-caption text-ink-2">
          <span className="sl-main">
            {/* The dot and the hairline each say what they are when pointed at. */}
            <span
              data-tip={`${row.projectPath || row.projectName}\nThe dot is this project's colour in every list.`}
              className={`truncate ${row.projectName.length > SHORT_PROJECT ? "sl-proj" : "flex-none"}`}
            >
              <ProjectDot path={row.projectPath || row.projectName} />
              <Marked text={row.projectName} query={query} />
            </span>
            <span className="flex-none">{DOT}</span>
            <span className="flex-none">
              <TokenText tokens={row.tokens.total} cost={row.cost} className="font-semibold text-ink" />
              {barShare !== undefined && (
                <span aria-hidden="true" className="tok-bar" data-tip={barShare >= 1 ? "The biggest session in this list" : `${percent(barShare)} of the biggest session in this list`}>
                  <i style={{ width: `${Math.round(barShare * 100)}%` }} />
                </span>
              )}
            </span>
            {row.agentCount > 0 && (
              <span className="sl-helpers flex-none">
                {DOT}
                <span
                  title={`${plural(row.agentCount, "helper")} ran inside this session. Their usage is counted here.`}
                  className="font-semibold text-accent-text"
                >
                  {plural(row.agentCount, "helper")}
                </span>
              </span>
            )}
            {/* A removed file's note matters more than the date when there is room for only one of them. */}
            <span className={`flex-none ${row.missing ? "sl-drop" : ""}`}>
              {DOT}
              {dayKnown ? <span title={formatWhen(row.startedAt)}>{clockTime(row.startedAt)}</span> : formatWhen(row.startedAt)}
            </span>
            {row.missing && (
              <span className="flex-none">
                {DOT}
                <span title="The file for this session is no longer on disk. Its numbers are kept.">File removed</span>
              </span>
            )}
          </span>
          {row.mainModel && (
            <span className="flex-none" title={effortTitle(row)}>
              {DOT}
              {modelWithEffort(row.mainModel, topEffort(row.efforts))}
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
