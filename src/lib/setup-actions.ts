// What happens when Will deletes or restores something on the Setup page. The
// backup and the file work are all in Rust; this is the wording and the Undo.

import { getBackend } from "./ipc";
import type { DeleteOutcome, SetupItem } from "./setup-types";
import { reloadSetup } from "../state/setupStore";
import { pushToast } from "../state/toastStore";

export function errorText(e: unknown, fallback: string): string {
  return (e instanceof Error ? e.message : typeof e === "string" ? e : "") || fallback;
}

function fileName(p: string | null): string {
  if (!p) return "";
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/** One plain sentence: what disappears if this is deleted. */
export function whatGetsRemoved(item: SetupItem): string {
  switch (item.kind) {
    case "skill":
      return "This removes the skill's whole folder, including any files that come with it.";
    case "hook":
      return "This removes the hook from your settings file. The script it runs is not touched.";
    case "mcpServer":
      return "This removes the server from your Claude settings. Nothing on the server itself changes.";
    default: {
      const f = fileName(item.path);
      return f ? `This removes the file ${f}.` : "This removes the file.";
    }
  }
}

/** Back up, delete, then offer Undo. Throws a readable message when it cannot. */
export async function deleteItem(item: SetupItem): Promise<DeleteOutcome> {
  const backend = getBackend();
  const out = await backend.setupDelete(item.id);
  reloadSetup();
  pushToast({
    message: `Deleted ${out.name}.`,
    action: {
      label: "Undo",
      onClick: async () => {
        try {
          const back = await backend.setupUndo(out.backupId);
          pushToast({ message: `Put ${back.name} back exactly as it was.`, tone: "success" });
        } catch (e) {
          pushToast({ message: errorText(e, "Atlas could not put that back."), tone: "error" });
        } finally {
          reloadSetup();
        }
      },
    },
  });
  return out;
}
