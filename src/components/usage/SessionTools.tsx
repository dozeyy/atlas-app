import { Card } from "../controls";
import { getBackend } from "../../lib/ipc";
import { useFetched } from "../../lib/useUsage";
import { shareOfMax } from "../../lib/sessionBrowse";
import { exact } from "../../lib/usage";
import type { ItemKind, ItemUse } from "../../lib/types";

export interface ItemGroup {
  kind: ItemKind;
  label: string;
  items: ItemUse[];
}

const SHOWN = 8;

/**
 * What one chat called, in three plain lists: tools, skills and the kinds of helper it started.
 * Read only when the Details tab is open. A list with nothing in it is left out.
 */
export function useSessionItems(sessionId: string): ItemGroup[] {
  const backend = getBackend();
  const tools = useFetched(() => backend.usageByItem({ kind: "tool", sessionId, limit: SHOWN }), [sessionId]);
  const skills = useFetched(() => backend.usageByItem({ kind: "skill", sessionId, limit: SHOWN }), [sessionId]);
  const agents = useFetched(() => backend.usageByItem({ kind: "agent", sessionId, limit: SHOWN }), [sessionId]);
  return [
    { kind: "tool", label: "Tools", items: (tools.data ?? []).filter((i) => i.uses > 0) },
    { kind: "skill", label: "Skills", items: (skills.data ?? []).filter((i) => i.uses > 0) },
    { kind: "agent", label: "Helper types", items: (agents.data ?? []).filter((i) => i.uses > 0) },
  ];
}

export function SessionTools({ groups }: { groups: ItemGroup[] }) {
  const live = groups.filter((g) => g.items.length > 0);
  if (live.length === 0) return null;
  return (
    <Card className="grid grid-cols-1 gap-x-6 gap-y-4 px-4 py-3 @lg:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
      {live.map((g) => {
        const max = Math.max(...g.items.map((i) => i.uses));
        return (
          <div key={g.kind} className="min-w-0">
            <h4 className="rcpt-head">{g.label}</h4>
            <ul className="flex flex-col gap-1.5">
              {g.items.slice(0, SHOWN).map((i) => (
                <li key={i.id} className="min-w-0">
                  <div className="flex items-baseline gap-2 text-caption">
                    <span className="min-w-0 flex-1 truncate text-ink" title={i.id}>
                      {i.id}
                    </span>
                    <span className="shrink-0 tabular-nums text-ink-2">{exact(i.uses)}</span>
                  </div>
                  <div aria-hidden="true" className="tok-bar tok-bar-wide">
                    <i style={{ width: `${Math.round(shareOfMax(i.uses, max) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </Card>
  );
}
