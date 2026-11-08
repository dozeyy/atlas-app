import { useCallback, useEffect, useState } from "react";
import { Eye, Lock } from "@phosphor-icons/react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { TextEditor } from "./TextEditor";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import { KIND_BY_ID } from "../../lib/setup-model";
import type { RawEdit, SetupItem } from "../../lib/setup-types";
import { reloadSetup } from "../../state/setupStore";
import { pushToast } from "../../state/toastStore";

/**
 * Edit one item's text. Save = backup, atomic write, read back. If the file
 * changed on disk since it was opened, Will chooses instead of losing either side.
 */
export function ItemEditor({
  item,
  onCancel,
  onSaved,
  onDirtyChange,
}: {
  item: SetupItem;
  onCancel: () => void;
  onSaved: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [raw, setRaw] = useState<RawEdit | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (reveal: boolean) => {
      try {
        const r = await getBackend().setupItemRaw(item.id, reveal);
        setRaw(r);
        setError(null);
        setVersion((v) => v + 1);
      } catch (e) {
        setError(errorText(e, "Atlas could not open that file."));
      }
    },
    [item.id],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  const finish = (backupNote: boolean) => {
    pushToast({ message: `Saved ${item.name}.${backupNote ? " The old version is backed up." : ""}`, tone: "success" });
    reloadSetup();
    onSaved();
  };

  const save = async (text: string, force: boolean) => {
    if (!raw) return;
    const reply = await getBackend().setupSave(item.id, text, raw.stamp, force);
    if (reply.status === "conflict") {
      setConflict(text);
      return;
    }
    finish(reply.backupId !== null);
  };

  if (error && !raw) {
    return (
      <div className="px-6 py-4">
        <p role="alert" className="rounded-control bg-danger-tint px-3 py-2 text-body text-danger">
          {error}
        </p>
        <div className="mt-3 flex justify-end">
          <Button onClick={onCancel}>Close</Button>
        </div>
      </div>
    );
  }
  if (!raw) return <div role="status" aria-label="Opening the editor" className="skeleton mx-6 my-4 h-64 rounded-card" />;

  if (raw.needsReveal) {
    return (
      <div className="px-6 py-4">
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
              <Lock size={18} aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-lead font-semibold text-ink">This {KIND_BY_ID[item.kind].singular} holds secret values</h3>
              <p className="mt-1 text-body text-ink-2">
                Keys and tokens are kept out of sight everywhere in Atlas. To edit the file you need the real text, so Atlas has to show it. It is not saved
                or logged anywhere else.
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setRevealed(true);
                void load(true);
              }}
            >
              <Eye size={14} aria-hidden="true" />
              Show secrets and edit
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
      {revealed && (
        <p role="note" className="mb-3 flex items-center gap-2 rounded-control bg-warning-tint px-3 py-2 text-body text-warning">
          <Eye size={14} aria-hidden="true" />
          Secret values are showing while you edit.
        </p>
      )}
      <TextEditor
        key={version}
        initial={raw.text}
        language={raw.language}
        label={`Editing ${item.name}`}
        validate={(t) => getBackend().setupValidate(item.id, t)}
        onSubmit={(t) => save(t, false)}
        onCancel={onCancel}
        onDirtyChange={onDirtyChange}
        hint="Atlas backs up the current file before saving."
      />
      {conflict !== null && (
        <Dialog
          alert
          title="This file changed on your computer"
          onClose={() => setConflict(null)}
          footer={
            <>
              <Button autoFocus disabled={busy} onClick={() => setConflict(null)}>
                Keep editing
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setConflict(null);
                  await load(revealed);
                }}
              >
                Load the new version
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const text = conflict;
                    setConflict(null);
                    await save(text, true);
                  } catch (e) {
                    pushToast({ message: errorText(e, "Atlas could not save that."), tone: "error" });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Replace with mine
              </Button>
            </>
          }
        >
          <p className="text-body text-ink">
            Something else changed {item.name} after you opened it. Your edits and the newer version are different.
          </p>
          <p className="mt-2">
            Load the new version to see it (your edits here are dropped), or replace it with yours. Atlas keeps a backup of the file either way.
          </p>
        </Dialog>
      )}
    </div>
  );
}
