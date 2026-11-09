// Things you do with a chat from outside the app: pick it up again in a terminal, open its folder.
// Each says what happened in a toast, so a press never feels silent.

import { getBackend } from "./ipc";
import { pushToast } from "../state/toastStore";

/** Puts a "resume this chat" command (from `resumeCommand`) on the clipboard. */
export async function copyResume(command: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(command);
    pushToast({ message: "Resume command copied", tone: "success" });
  } catch {
    pushToast({ message: "Could not reach the clipboard.", tone: "error" });
  }
}

/** Opens the folder the chat ran in; says so when it is gone or was never known. */
export async function openFolder(sessionId: string): Promise<void> {
  try {
    await getBackend().sessionOpenFolder(sessionId);
  } catch (e) {
    pushToast({ message: e instanceof Error ? e.message : String(e), tone: "error" });
  }
}
