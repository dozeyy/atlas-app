// Things you do with a chat from outside the app: pick it up again in a terminal, open its folder.
// Each says what happened in a toast, so a press never feels silent.

import { getBackend } from "./ipc";
import { resumeCommand } from "./sessionBrowse";
import { pushToast } from "../state/toastStore";

/** Puts the "resume this chat" command on the clipboard. */
export async function copyResume(sessionId: string, projectPath: string | null | undefined): Promise<void> {
  try {
    await navigator.clipboard.writeText(resumeCommand(sessionId, projectPath));
    pushToast({ message: "Copied the resume command. Paste it in a terminal.", tone: "success" });
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
