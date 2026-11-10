import { Fragment } from "react";
import type { DiffLine, HistoryDiff } from "../../lib/historyTypes";
import { plural } from "../../lib/usage";

function Line({ line }: { line: DiffLine }) {
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "-" : "";
  const segClass = line.kind === "add" ? "hx-seg-add" : "hx-seg-del";
  return (
    <div className="hx-line" data-kind={line.kind}>
      <span className="hx-no" aria-hidden="true">
        {line.oldNo ?? ""}
      </span>
      <span className="hx-no" aria-hidden="true">
        {line.newNo ?? ""}
      </span>
      <span className="hx-sign" aria-hidden="true">
        {sign}
      </span>
      <span className="selectable">
        {line.segs && line.kind !== "same"
          ? line.segs.map((s, i) => (
              <span key={i} className={s.c ? segClass : undefined}>
                {s.t}
              </span>
            ))
          : line.text}
      </span>
    </div>
  );
}

function Skip({ count, onExpand }: { count: number; onExpand?: () => void }) {
  const text = `${plural(count, "line")} the same`;
  if (!onExpand) return <div className="hx-skip">{text}</div>;
  return (
    <button type="button" className="hx-skip" onClick={onExpand} aria-label={`Show ${text}`}>
      {text}
    </button>
  );
}

/** The sentence for a diff that has no lines to draw. */
export function diffNote(d: HistoryDiff, against: "before" | "now"): string | null {
  switch (d.kind) {
    case "same":
      return against === "now" ? "This is exactly what is on disk now." : "Nothing changed in this copy.";
    case "binary":
      return "This is not a text file, so there is nothing to show line by line.";
    case "tooLarge":
      return "This file is too large to show here. Save a copy to open it elsewhere.";
    case "missing":
      return "The file is not on disk any more, so there is nothing to compare with.";
    default:
      return null;
  }
}

/**
 * Mono lines with two number columns. A run of unchanged lines is one quiet bar that opens on
 * click. Calm on purpose: no motion in here.
 */
export function DiffView({ diff, onExpand }: { diff: HistoryDiff; onExpand?: () => void }) {
  if (diff.kind !== "text" || diff.hunks.length === 0) return null;
  return (
    <div className="hx-diff" role="group" aria-label="Changes">
      {diff.hunks.map((h, i) => (
        <Fragment key={i}>
          {h.skippedBefore > 0 && <Skip count={h.skippedBefore} onExpand={onExpand} />}
          {h.lines.map((l, j) => (
            <Line key={j} line={l} />
          ))}
        </Fragment>
      ))}
      {diff.skippedAfter > 0 && <Skip count={diff.skippedAfter} onExpand={onExpand} />}
    </div>
  );
}

/** A copy shown whole, for a file that is gone: the last thing Atlas kept. */
export function TextPreview({ text, max = 400 }: { text: string; max?: number }) {
  // Nothing to draw: say so, a box holding only a line number reads as a fault.
  if (text.trim() === "") return <p className="text-body text-ink-2">The file was empty.</p>;
  const all = text.replace(/\n$/, "").split("\n");
  const lines = all.slice(0, max);
  return (
    <>
      <div className="hx-diff hx-preview" role="group" aria-label="Last copy">
        {lines.map((t, i) => (
          <div key={i} className="hx-line" data-kind="same">
            <span className="hx-no" aria-hidden="true">
              {i + 1}
            </span>
            <span className="selectable">{t}</span>
          </div>
        ))}
      </div>
      {all.length > max && <p className="mt-2 text-caption text-ink-2">Showing the first {max} lines.</p>}
    </>
  );
}
