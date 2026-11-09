import { useId, useState } from "react";
import { CaretRight, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { Chip } from "../setup/parts";
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
        className="flex w-full cursor-pointer items-start gap-2 rounded-control px-2 py-1.5 text-left text-body text-warning enabled:hover:bg-warning-tint disabled:cursor-default"
      >
        <WarningCircle size={18} weight="fill" aria-hidden="true" className="mt-px shrink-0" />
        <span className="min-w-0 flex-1 break-words">{flag.words}</span>
        {has && (
          <CaretRight size={14} weight="bold" aria-hidden="true" className={`mt-1 shrink-0 text-ink-2 transition-transform duration-[var(--dur-fast)] ${open ? "rotate-90" : ""}`} />
        )}
      </button>
      {open && has && (
        <ul id={id} className="mx-2 mb-1.5 ml-9 grid gap-1">
          {flag.evidence.map((e, i) => (
            <li key={i} className="min-w-0 rounded-control bg-raised px-2.5 py-1.5">
              <div className="mono truncate text-caption text-ink-2">
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
    <div className="rounded-card border border-line bg-surface p-3">
      {clean ? (
        <p className="flex items-start gap-2 px-2 py-1 text-body text-ink">
          <CheckCircle size={18} weight="fill" aria-hidden="true" className="mt-px shrink-0 text-success" />
          <span>{report.summary}</span>
        </p>
      ) : (
        <ul className="grid gap-0.5" aria-label="Things to look at">
          {report.flags.map((f) => (
            <Flag key={f.code} flag={f} />
          ))}
        </ul>
      )}
      {notInstalled && notInstalled.length > 0 && (
        <ul className="mt-2 grid gap-1 border-t border-line px-2 pt-2">
          {notInstalled.map((n) => (
            <li key={n.path} className="flex flex-wrap items-center gap-2 text-caption text-ink-2">
              <Chip tone="muted">Not installed</Chip>
              <span>
                {n.what} <span className="mono">{n.path}</span>. Atlas does not copy these.
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 border-t border-line px-2 pt-2 text-caption text-ink-2">{report.caption}</p>
    </div>
  );
}
