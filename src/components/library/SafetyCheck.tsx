import { useId, useState } from "react";
import { CaretRight, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { Chip } from "../setup/parts";
import { badge } from "../../lib/tagWords";
import type { SafetyFlag, SafetyReport, Shaped } from "../../lib/libraryTypes";

function Flag({ flag }: { flag: SafetyFlag }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const has = flag.evidence.length > 0;
  return (
    <li>
      <button
        type="button"
        aria-expanded={has ? open : undefined}
        aria-controls={has ? id : undefined}
        disabled={!has}
        onClick={() => setOpen((v) => !v)}
        title={open ? undefined : flag.words}
        className="flex w-full cursor-pointer items-start gap-2.5 rounded-control px-2 py-1.5 text-left text-body text-ink enabled:hover:bg-raised disabled:cursor-default"
      >
        <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warning" />
        {/* Two lines at rest; the whole finding once it is opened (or on hover when there is nothing to open). */}
        <span className={`min-w-0 flex-1 break-words ${open ? "" : "line-clamp-2"}`}>{flag.words}</span>
        {has && (
          <CaretRight size={14} weight="bold" aria-hidden="true" className={`mt-1 shrink-0 text-ink-2 transition-transform duration-[var(--dur-fast)] ${open ? "rotate-90" : ""}`} />
        )}
      </button>
      {open && has && (
        <ul id={id} className="mx-2 mb-1.5 ml-9 grid gap-1">
          {flag.evidence.map((e, i) => (
            <li key={i} className="min-w-0 rounded-control bg-raised px-2.5 py-1.5">
              <div title={`${e.path}${e.line !== null ? `:${e.line}` : ""}`} className="mono truncate text-caption text-ink-2">
                {e.path}
                {e.line !== null ? `:${e.line}` : ""}
              </div>
              <code className="selectable mono block break-all text-caption text-ink">{e.excerpt}</code>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** "Before you install": what Atlas found in the files, in plain words. Calm: nothing moves but the carets. */
export function SafetyCheck({ report, notInstalled }: { report: SafetyReport; notInstalled?: Shaped["notInstalled"] }) {
  const clean = report.flags.length === 0;
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      {/* The verdict: the one line to read before the button, so it is the strongest thing in the sheet after the name. */}
      <p className={`flex items-center gap-2.5 px-4 py-3 text-lead font-semibold text-ink ${clean ? "bg-success-tint" : "bg-warning-tint"}`}>
        {clean ? (
          <CheckCircle size={22} weight="fill" aria-hidden="true" className="shrink-0 text-success" />
        ) : (
          <WarningCircle size={22} weight="fill" aria-hidden="true" className="shrink-0 text-warning" />
        )}
        <span className="min-w-0 break-words">{report.summary}</span>
      </p>
      {!clean && (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-0.5 border-t border-line p-2" aria-label="Things to look at">
          {report.flags.map((f) => (
            <Flag key={f.code} flag={f} />
          ))}
        </ul>
      )}
      {/* What the repository holds that Atlas leaves behind. Said as a reason the verdict above
          stays true ("nothing here runs": the hook is not copied, so it never runs), not as a
          second list of things that sound installed. */}
      {notInstalled && notInstalled.length > 0 && (
        <ul className="grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-line px-4 py-2.5" aria-label="Left out">
          {notInstalled.map((n) => (
            <li key={n.path} className="flex flex-wrap items-center gap-2 text-caption text-ink-2">
              <Chip tone="muted" title={badge("leftOut").tip}>
                {badge("leftOut").label}
              </Chip>
              <span className="min-w-0 break-words">
                {n.what} in <span className="mono break-all">{n.path}</span>. Atlas does not copy {/^1\s/.test(n.what) ? "it" : "them"}, so {/^1\s/.test(n.what) ? "it never runs" : "they never run"}.
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="border-t border-line px-4 py-2.5 text-caption text-ink-2">{report.caption}</p>
    </div>
  );
}
