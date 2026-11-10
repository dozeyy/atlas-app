import { useState } from "react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { PathText } from "./parts";
import { deleteItem, errorText, whatGetsRemoved } from "../../lib/setup-actions";
import { displayName } from "../../lib/setup-model";
import type { SetupItem } from "../../lib/setup-types";

/**
 * What the path under the sentence points at: the thing that goes away. A skill is its folder,
 * so the folder is shown, not the SKILL.md inside it.
 */
export function removedPath(item: SetupItem): string | null {
  if (!item.path) return null;
  return item.kind === "skill" ? item.path.replace(/[\\/]SKILL\.md$/i, "") : item.path;
}

/**
 * "Delete <name>?" with what goes away and the promise of a backup. A destructive yes: Cancel
 * has the keyboard, and Delete is the danger fill.
 */
export function ConfirmDelete({ item, onCancel, onDone }: { item: SetupItem; onCancel: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gone = removedPath(item);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteItem(item);
      onDone();
    } catch (e) {
      setError(errorText(e, "Atlas could not delete that, so nothing was changed."));
      setBusy(false);
    }
  };

  return (
    <Dialog
      alert
      title={`Delete ${displayName(item)}?`}
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Button autoFocus onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger-solid" onClick={() => void run()} disabled={busy}>
            {busy ? "Deleting..." : "Delete"}
          </Button>
        </>
      }
    >
      <p className="text-body text-ink">{whatGetsRemoved(item)}</p>
      {gone && (
        <p className="selectable mt-2 text-ink-2">
          <PathText path={gone} />
        </p>
      )}
      <p className="mt-3">Atlas keeps a backup first, so you can undo this straight away.</p>
      {error && (
        <p role="alert" className="mt-3 rounded-control bg-danger-tint px-3 py-2 text-body text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
