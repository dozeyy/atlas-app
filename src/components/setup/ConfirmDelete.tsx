import { useState } from "react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { deleteItem, errorText, whatGetsRemoved } from "../../lib/setup-actions";
import type { SetupItem } from "../../lib/setup-types";

/** "Delete <name>?" with what goes away and the promise of a backup. */
export function ConfirmDelete({ item, onCancel, onDone }: { item: SetupItem; onCancel: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      title={`Delete ${item.name}?`}
      onClose={busy ? () => {} : onCancel}
      footer={
        <>
          <Button autoFocus onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void run()} disabled={busy}>
            {busy ? "Deleting..." : "Delete"}
          </Button>
        </>
      }
    >
      <p className="text-body text-ink">{whatGetsRemoved(item)}</p>
      {item.path && <p className="mono selectable mt-2 break-all text-ink-2">{item.path}</p>}
      <p className="mt-3">Atlas keeps a backup first, so you can undo this straight away.</p>
      {error && (
        <p role="alert" className="mt-3 rounded-control bg-danger-tint px-3 py-2 text-body text-danger">
          {error}
        </p>
      )}
    </Dialog>
  );
}
