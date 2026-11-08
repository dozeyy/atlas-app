import { WarningCircle } from "@phosphor-icons/react";
import { Button } from "./controls";
import { formatBytes } from "../lib/labels";
import { exact } from "../lib/usage";
import type { IndexProgress as Progress, UsageStatus } from "../lib/types";

/**
 * What the usage engine is doing, said plainly. Renders nothing while it is idle and
 * healthy, so a calm app stays calm.
 */
export function IndexProgress({
  status,
  progress,
  onRetry,
}: {
  status: UsageStatus | null;
  progress: Progress | null;
  onRetry?: () => void;
}) {
  if (!status) return null;

  if (status.state === "error") {
    return (
      <div
        role="alert"
        className="mb-6 flex items-start gap-3 rounded-card border border-line bg-danger-tint px-5 py-4"
      >
        <WarningCircle size={20} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-ink">Atlas could not read your usage</div>
          <p className="mt-0.5 text-body text-ink-2">{status.error ?? "The usage cache could not be opened."}</p>
        </div>
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
      </div>
    );
  }

  if (status.state === "readOnly") {
    return (
      <div role="status" className="mb-6 flex items-start gap-3 rounded-card border border-line bg-warning-tint px-5 py-4">
        <WarningCircle size={20} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0 text-warning" />
        <p className="text-body text-ink">
          This usage cache was made by a newer Atlas. You can read it here, but this version will not change it.
        </p>
      </div>
    );
  }

  if (status.state === "recovering") {
    return (
      <div role="status" className="mb-6 rounded-card border border-line bg-surface px-5 py-4 text-body text-ink">
        The usage cache was damaged. Atlas is rebuilding it from your sessions.
      </div>
    );
  }

  if (status.state !== "indexing") return null;

  const total = progress?.bytesTotal ?? 0;
  const done = progress?.bytesDone ?? 0;
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null;
  const first = !status.firstIndexDone;

  return (
    <div className="mb-6 rounded-card border border-line bg-surface px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="text-body font-medium text-ink" id="index-progress-label">
          {first ? "Reading your sessions" : "Catching up with your latest sessions"}
        </div>
        <div className="text-caption text-ink-2">
          {progress && progress.filesTotal > 0
            ? `${exact(progress.filesDone)} of ${exact(progress.filesTotal)} files, ${formatBytes(done)} of ${formatBytes(total)}`
            : "Looking for sessions..."}
        </div>
      </div>
      <div
        role="progressbar"
        aria-labelledby="index-progress-label"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct === null ? "Starting" : `${pct} percent`}
        className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised"
      >
        <div
          className={`h-full rounded-full bg-accent ${pct === null ? "pulse-dot w-1/4" : ""}`}
          style={pct === null ? undefined : { width: `${pct}%`, transition: "width var(--dur) var(--ease-out)" }}
        />
      </div>
      {first && (
        <p className="mt-2 text-caption text-ink-2">
          This happens once. Numbers fill in as the files are read, and nothing in your Claude folder is changed.
        </p>
      )}
    </div>
  );
}
