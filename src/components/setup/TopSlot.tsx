import { useEffect, useRef, useState } from "react";
import { Checklist } from "./Checklist";
import { UsagePanel, useUsageRows } from "./UsagePanel";
import { progress } from "../../lib/setup-steps";
import type { CreateKind, SetupItem } from "../../lib/setup-types";

/** Set once the checklist has reached 100%; after that it never celebrates again. */
export const CHECKLIST_DONE_KEY = "atlas.setup.checklistDone";
/** How long the finished checklist stays up before it folds away. */
export const CELEBRATE_MS = 3500;

function stored(): boolean {
  try {
    return localStorage.getItem(CHECKLIST_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

function remember() {
  try {
    localStorage.setItem(CHECKLIST_DONE_KEY, "1");
  } catch {
    // Remembering is a convenience: without it the card is simply hidden whenever it is complete.
  }
}

type Phase = "open" | "celebrate" | "hidden";

/**
 * Whether the checklist card is on the page. Complete: not rendered at all. Open steps: shown.
 * When the last step gets done in front of you it stays up for a calm few seconds (once, ever),
 * then goes. A step that later becomes undone brings it back with just that step.
 */
export function useChecklistPhase(complete: boolean): Phase {
  const [phase, setPhase] = useState<Phase>(complete ? "hidden" : "open");
  const wasComplete = useRef(complete);

  useEffect(() => {
    if (!complete) {
      wasComplete.current = false;
      setPhase("open");
      return;
    }
    const justFinished = !wasComplete.current;
    wasComplete.current = true;
    const celebrated = stored();
    remember();
    if (!justFinished || celebrated) {
      setPhase("hidden");
      return;
    }
    setPhase("celebrate");
    const t = window.setTimeout(() => setPhase("hidden"), CELEBRATE_MS);
    return () => window.clearTimeout(t);
  }, [complete]);

  return phase;
}

/**
 * The area above the tiles: the setup checklist while there is something left to do (and for
 * a short moment when it is finished), then the used / never used panel, which draws nothing
 * until the usage engine has an answer. When both are empty the slot takes no room at all.
 * Swap or add panels here and nowhere else.
 */
export function TopSlot({
  items,
  loads,
  onCreate,
  onOpen,
}: {
  items: SetupItem[];
  loads: number;
  onCreate: (kind: CreateKind) => void;
  onOpen: (id: string) => void;
}) {
  const rows = useUsageRows(items, loads);
  const phase = useChecklistPhase(progress(items).complete);
  return (
    <div className="mb-6 flex flex-col gap-4 empty:hidden">
      {phase !== "hidden" && <Checklist items={items} onCreate={onCreate} />}
      <UsagePanel rows={rows} items={items} onOpen={onOpen} />
    </div>
  );
}
