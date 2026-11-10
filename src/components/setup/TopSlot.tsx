import { useEffect, useRef, useState } from "react";
import { Checklist } from "./Checklist";
import { CostPanel } from "./CostPanel";
import { UsagePanel, useUsageRows } from "./UsagePanel";
import { progress } from "../../lib/setup-steps";
import type { CostReport, CreateKind, SetupItem } from "../../lib/setup-types";

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
 * a short moment when it is finished). Nothing else goes above the tiles: they are the way in
 * to everything, so they come first. When the checklist is away the slot takes no room at all.
 */
export function TopSlot({ items, onCreate }: { items: SetupItem[]; onCreate: (kind: CreateKind) => void }) {
  const phase = useChecklistPhase(progress(items).complete);
  if (phase === "hidden") return null;
  return (
    <div className="mb-4">
      <Checklist items={items} onCreate={onCreate} />
    </div>
  );
}

/**
 * The two "how is it going" panels, under the tiles: what gets used, and what the setup costs.
 * Each draws nothing until it has an answer; when both are empty the block takes no room.
 * Side by side whenever the page column has room for both (usage wide, cost narrow); alone,
 * each takes the full width. It asks the column, not the window: the sidebar being open or
 * closed changes the answer.
 */
export function Insights({
  items,
  loads,
  cost,
  onOpen,
}: {
  items: SetupItem[];
  loads: number;
  cost: CostReport | null;
  onOpen: (id: string) => void;
}) {
  const rows = useUsageRows(items, loads);
  return (
    <div className="@container mt-4 empty:hidden">
      <div className="grid gap-4 empty:hidden @min-[720px]:[&:has(>:nth-child(2))]:grid-cols-[minmax(0,1fr)_22rem] @min-[960px]:[&:has(>:nth-child(2))]:grid-cols-[minmax(0,1fr)_24rem]">
        <UsagePanel rows={rows} items={items} onOpen={onOpen} />
        <CostPanel report={cost} items={items} onOpen={onOpen} />
      </div>
    </div>
  );
}
