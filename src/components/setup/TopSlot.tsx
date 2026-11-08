import { Checklist } from "./Checklist";
import { UsagePanel, useUsageRows } from "./UsagePanel";
import type { CreateKind, SetupItem } from "../../lib/setup-types";

/**
 * The area above the tiles. Today: the setup checklist, then the used / never
 * used panel (which draws nothing until a usage source exists). Swap or add
 * panels here and nowhere else.
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
  const rows = useUsageRows(loads);
  return (
    <div className="mb-6 flex flex-col gap-4">
      <Checklist items={items} onCreate={onCreate} />
      <UsagePanel rows={rows} items={items} onOpen={onOpen} />
    </div>
  );
}
