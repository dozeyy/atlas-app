import { useState } from "react";
import { ArrowLeft, ArrowSquareOut, Copy, FloppyDisk } from "@phosphor-icons/react";
import { getBackend } from "../../lib/ipc";
import { useFetched } from "../../lib/useUsage";
import { Button } from "../controls";
import { KindTile } from "../setup/parts";
import { ErrorBlock, Skeleton } from "../usage/StateBlocks";
import { DiffView, TextPreview, diffNote } from "./DiffView";
import type { HistoryEvent, VersionRow } from "../../lib/historyTypes";
import { agoText, scopeText, setupKind, shortDate, sourceNote, whatHappened } from "../../lib/historyModel";
import { formatBytes } from "../../lib/labels";
import { pushToast } from "../../state/toastStore";
import { openSessionNext } from "../../lib/nav";
import { useAtlas } from "../../state/AtlasProvider";

const FULL = 5000;

function Scrubber({ versions, picked, onPick }: { versions: VersionRow[]; picked: number | null; onPick: (v: VersionRow) => void }) {
  // The backend lists newest first; the line reads left (old) to right (new).
  const ordered = [...versions].filter((v) => v.hasCopy).reverse();
  if (ordered.length < 2) return null;
  return (
    <div>
      <div className="text-caption font-semibold text-ink-2">Earlier and later copies</div>
      <div className="hx-scrub" role="group" aria-label="Copies Atlas kept, oldest to newest">
        {ordered.map((v) => (
          <button
            key={v.id}
            type="button"
            className="hx-scrub-hit"
            aria-current={v.id === picked || undefined}
            aria-label={`Copy from ${agoText(v.at)}`}
            title={`${agoText(v.at)}, ${formatBytes(v.bytes)}`}
            onClick={() => onPick(v)}
          >
            <span className="hx-scrub-dot" />
          </button>
        ))}
      </div>
    </div>
  );
}

/** One change in full: what happened, the lines, and ways to keep a copy. Read-only. */
export function Detail({ event, onBack }: { event: HistoryEvent; onBack?: () => void }) {
  const backend = getBackend();
  const { setView } = useAtlas();
  const [picked, setPicked] = useState<number | null>(null);
  const [now, setNow] = useState(false);
  const [full, setFull] = useState(false);

  const removed = event.kind === "removed";
  const versionId = picked ?? event.toVersion ?? event.fromVersion;
  const hasCopy = versionId !== null && (picked !== null || event.hasCopy);

  const item = useFetched(() => backend.historyItem(event.item.key), [event.item.key]);
  const diff = useFetched(
    () =>
      versionId === null || removed || !hasCopy
        ? Promise.resolve(null)
        : backend.historyDiff({ versionId, againstCurrent: now, context: full ? FULL : undefined }),
    [versionId, removed, hasCopy, now, full],
  );
  const lastCopy = useFetched(
    () => (removed && event.fromVersion !== null ? backend.historyCopyVersion(event.fromVersion) : Promise.resolve(null)),
    [removed, event.fromVersion],
  );

  // A dated event says its own version of this below.
  const note = event.kind === "dated" ? null : sourceNote(event);
  const d = diff.data;

  const copy = async () => {
    if (versionId === null) return;
    try {
      const text = await backend.historyCopyVersion(versionId);
      await navigator.clipboard.writeText(text);
      pushToast({ message: "Copied this version", tone: "success" });
    } catch {
      pushToast({ message: "Could not copy this version", tone: "error" });
    }
  };
  const save = async () => {
    if (versionId === null) return;
    try {
      const path = await backend.historySaveCopy(versionId);
      if (path) pushToast({ message: `Saved a copy to ${path}`, tone: "success" });
    } catch {
      pushToast({ message: "Could not save a copy", tone: "error" });
    }
  };

  return (
    <article className="rise flex flex-col gap-5" aria-label="Change details" data-testid="history-detail">
      {onBack && (
        <div>
          <Button onClick={onBack}>
            <ArrowLeft size={14} aria-hidden="true" />
            Back to the list
          </Button>
        </div>
      )}

      <header className="flex items-start gap-3">
        <KindTile kind={setupKind(event.item.kind)} size={44} />
        <div className="min-w-0 flex-1">
          <h2 className="d d-figure truncate text-ink">{event.item.name}</h2>
          <p className="text-body text-ink-2">
            {whatHappened(event)}, {agoText(event.at)}. {scopeText(event.item)}.
          </p>
          {event.item.path && <p className="selectable mt-0.5 break-all font-mono text-caption text-ink-2">{event.item.path}</p>}
        </div>
      </header>

      {note && <p className="text-body text-ink-2">{note}.</p>}

      {event.kind === "dated" ? (
        <p className="text-body text-ink">
          Last changed on {shortDate(event.at)}. Atlas had not started keeping copies yet, so there is nothing to compare.
        </p>
      ) : (
        <>
          {d && d.summary.length > 0 && (
            <ul className="m-0 list-none space-y-1 p-0 text-body text-ink">
              {d.summary.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
          {!d && !removed && !diff.error && !diff.loading && <p className="text-body text-ink-2">{event.summary}</p>}

          <Scrubber versions={item.data?.versions ?? []} picked={versionId} onPick={(v) => { setPicked(v.id); setNow(false); setFull(false); }} />

          {hasCopy && !removed && (
            <label className="flex w-fit cursor-pointer items-center gap-2 text-body text-ink">
              <input type="checkbox" checked={now} onChange={(e) => setNow(e.target.checked)} className="size-4 accent-[var(--accent-solid)]" />
              Compare with now
            </label>
          )}

          {diff.error && <ErrorBlock message={diff.error} onRetry={() => diff.reload()} />}
          {diff.loading && !d && <Skeleton className="h-24" />}
          {d && diffNote(d, now ? "now" : "before") && <p className="text-body text-ink-2">{diffNote(d, now ? "now" : "before")}</p>}
          {d && <DiffView diff={d} onExpand={() => setFull(true)} />}
          {d?.cut && <p className="text-caption text-ink-2">Only the first lines are shown. Save a copy to see the whole file.</p>}

          {removed && lastCopy.data !== null && (
            <section aria-label="Last copy">
              <p className="mb-2 text-body text-ink-2">This is the last copy Atlas kept before it was removed.</p>
              <TextPreview text={lastCopy.data} />
            </section>
          )}
          {removed && event.fromVersion === null && <p className="text-body text-ink-2">Atlas has no copy of this one.</p>}
        </>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {versionId !== null && hasCopy && (
          <>
            <Button onClick={copy}>
              <Copy size={14} aria-hidden="true" />
              Copy this version
            </Button>
            <Button onClick={save}>
              <FloppyDisk size={14} aria-hidden="true" />
              Save a copy
            </Button>
          </>
        )}
        {event.sessionId && (
          <Button
            onClick={() => {
              openSessionNext(event.sessionId!);
              setView("sessions");
            }}
          >
            <ArrowSquareOut size={14} aria-hidden="true" />
            Open that session
          </Button>
        )}
      </div>
    </article>
  );
}
