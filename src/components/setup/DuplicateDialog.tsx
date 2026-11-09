import { useState } from "react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import type { SetupItem } from "../../lib/setup-types";
import { reloadSetup } from "../../state/setupStore";
import { pushToast } from "../../state/toastStore";

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Why a folder name for a skill will not do, or null when it is fine. */
export function nameProblem(name: string, taken: Set<string>): string | null {
  if (!name) return "Give the copy a name.";
  if (!NAME.test(name)) return "Use lowercase letters, numbers and dashes, starting with a letter or number.";
  if (taken.has(name)) return "You already have a skill with that name.";
  return null;
}

/** Copy a skill (all its files) to a new name. Nothing existing is touched. */
export function DuplicateDialog({ item, taken, onClose }: { item: SetupItem; taken: Set<string>; onClose: () => void }) {
  const [name, setName] = useState(`${item.name}-copy`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const problem = nameProblem(name, taken);

  const go = async () => {
    if (problem || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await getBackend().setupDuplicate(item.id, name);
      pushToast({ message: `Made ${out.name} as a copy of ${item.name}.`, tone: "success" });
      reloadSetup();
      onClose();
    } catch (e) {
      setErr(errorText(e, "Atlas could not copy that, so nothing was changed."));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title="Duplicate skill"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void go()} disabled={!!problem || busy}>
            {busy ? "Copying..." : "Duplicate"}
          </Button>
        </>
      }
    >
      <label htmlFor="dup-name" className="mb-1.5 block text-body text-ink-2">
        Name of the copy
      </label>
      <input
        id="dup-name"
        autoFocus
        value={name}
        spellCheck={false}
        onChange={(e) => setName(e.target.value.toLowerCase())}
        onKeyDown={(e) => {
          if (e.key === "Enter") void go();
        }}
        className="mono h-9 w-full rounded-control border border-line-strong bg-surface px-3 text-body text-ink outline-none focus:border-accent"
      />
      <p role="status" className={`mt-2 min-h-5 text-caption ${problem || err ? "text-danger" : "text-ink-2"}`}>
        {err ?? problem ?? ""}
      </p>
    </Dialog>
  );
}
