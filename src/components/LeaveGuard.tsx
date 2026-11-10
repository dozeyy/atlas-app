import { useEffect } from "react";
import { getBackend } from "../lib/ipc";
import { Button } from "./controls";
import { Dialog } from "./Dialog";
import { cancelLeave, confirmLeave, guardLeave, useAnyUnsaved, useLeaveQuestion } from "../state/unsavedStore";

/**
 * The one "Discard your changes?" question for leaving the current view or the app while an
 * editor holds unsaved edits, plus the link to Rust: Rust is told whether anything is unsaved,
 * holds a window close or quit back when it is, and asks the page to put the question.
 */
export function LeaveGuard() {
  const asking = useLeaveQuestion();
  const unsaved = useAnyUnsaved();

  useEffect(() => {
    void getBackend().setUnsaved(unsaved).catch(() => {});
  }, [unsaved]);

  useEffect(() => {
    const backend = getBackend();
    let dead = false;
    let off: (() => void) | undefined;
    backend
      .onQuitAsk(() => guardLeave(() => void backend.leaveApp().catch(() => {})))
      .then((fn) => (dead ? fn() : (off = fn)))
      .catch(() => {});
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  if (!asking) return null;
  return (
    <Dialog
      alert
      title="Discard your changes?"
      onClose={cancelLeave}
      footer={
        <>
          <Button autoFocus onClick={cancelLeave}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={confirmLeave}>
            Discard
          </Button>
        </>
      }
    >
      <p className="text-body text-ink">Edits you have not saved will be lost.</p>
    </Dialog>
  );
}
