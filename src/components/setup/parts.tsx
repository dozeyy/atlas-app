import { Fragment } from "react";
import type { ComponentType, ReactNode } from "react";
import {
  Buildings,
  Cloud,
  FolderOpen,
  FolderSimple,
  Globe,
  type IconProps,
  Lock,
  PuzzlePiece,
  WarningCircle,
  ArrowsSplit,
} from "@phosphor-icons/react";
import { IconMotion, type Motion } from "../IconMotion";
import { AgentAvatar, agentLook } from "../usage/helperKit";
import { displayName, enabledTone, KIND_BY_ID, type Tone } from "../../lib/setup-model";
import { formatBytes } from "../../lib/labels";
import { clockTime, shortDate } from "../../lib/usage";
import type { Conflict, Enabled, ItemKind, ScopeKind, SetupItem } from "../../lib/setup-types";

type Icon = ComponentType<IconProps>;

const TONE: Record<Tone, string> = {
  accent: "bg-accent-tint text-accent-text",
  good: "bg-success-tint text-success",
  warn: "bg-warning-tint text-warning",
  bad: "bg-danger-tint text-danger",
  muted: "bg-raised text-ink-2",
};

const CHIP = "inline-flex h-5 max-w-full shrink-0 items-center gap-1 rounded-full px-2 text-caption font-medium";

export function Chip({ tone = "muted", icon: Icon, children, title }: { tone?: Tone; icon?: Icon; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`${CHIP} ${TONE[tone]}`}>
      {Icon && <Icon size={12} weight="bold" aria-hidden="true" className="shrink-0" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A plain outlined chip for tags such as "stdio" or "PreToolUse". */
export function TagChip({ children }: { children: ReactNode }) {
  return (
    <span className={`${CHIP} border border-line text-ink-2`}>
      <span className="truncate">{children}</span>
    </span>
  );
}

const SCOPE_ICON: Record<ScopeKind, Icon> = {
  user: Globe,
  project: FolderSimple,
  local: FolderOpen,
  plugin: PuzzlePiece,
  synced: Cloud,
  connector: Cloud,
  managed: Buildings,
};

export function scopeTone(s: ScopeKind): Tone {
  return s === "user" ? "accent" : "muted";
}

export function ScopeChip({ scope, label }: { scope: ScopeKind; label: string }) {
  return (
    <Chip tone={scopeTone(scope)} icon={SCOPE_ICON[scope]} title={label}>
      {label}
    </Chip>
  );
}

export function StateChip({ enabled }: { enabled: Enabled }) {
  if (enabled.state === "none" || !enabled.label) return null;
  return <Chip tone={enabledTone(enabled.state)}>{enabled.label}</Chip>;
}

export function ConflictChip({ conflict }: { conflict: Conflict }) {
  const warn = conflict.status !== "overrides";
  return (
    <Chip tone={warn ? "warn" : "muted"} icon={ArrowsSplit} title={conflict.label}>
      {conflict.label}
    </Chip>
  );
}

export function SecretsChip() {
  return (
    <Chip icon={Lock} title="Secret values in this item are hidden until you ask to see them">
      Values hidden
    </Chip>
  );
}

export function WarningMark({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <span title={warnings.join("\n")} className="inline-flex items-center gap-1 text-caption font-medium text-warning">
      <WarningCircle size={14} weight="fill" aria-hidden="true" />
      <span>
        {warnings.length} {warnings.length === 1 ? "note" : "notes"}
      </span>
    </span>
  );
}

/** Each kind of thing has its own small move when its card or tile is hovered. */
export const KIND_MOTION: Record<string, Motion> = {
  skill: "zap",
  agent: "bob",
  command: "nudge",
  mcpServer: "plug",
  hook: "swing",
  plugin: "tilt",
  outputStyle: "wiggle",
  rule: "pop",
  settings: "spin",
};

/** The rounded square holding a kind's icon. It relaxes into a blob and the icon moves when the card is hovered. */
export function KindTile({
  kind,
  size = 36,
  icon,
  title,
}: {
  kind: ItemKind | "more";
  size?: number;
  icon?: ComponentType<IconProps>;
  /** What the icon stands for, on hover. Left out where a label already sits beside the tile. */
  title?: string;
}) {
  const Icon = icon ?? KIND_BY_ID[kind as ItemKind].icon;
  return (
    <span
      aria-hidden="true"
      title={title}
      style={{ width: size, height: size }}
      className="kind-tile flex shrink-0 items-center justify-center bg-accent-tint text-accent-text"
    >
      <IconMotion motion={KIND_MOTION[kind] ?? "pop"} size={Math.round(size * 0.55)}>
        <Icon />
      </IconMotion>
    </span>
  );
}

/** What an agent's avatar says on hover: that it is an agent, and which sort when the avatar shows one. */
function agentTip(name: string): string {
  const sort = agentLook(name).label;
  return /other/i.test(sort) ? "Agent" : `Agent: ${sort}`;
}

/**
 * The picture beside an item's name. An agent wears the avatar it has on Now, Sessions and Team
 * (one mapping, in helperKit), so the same helper looks the same everywhere; every other kind
 * shows its kind icon. Hovering either says what it is.
 */
export function ItemIcon({ item, size = 36 }: { item: Pick<SetupItem, "kind" | "name">; size?: number }) {
  if (item.kind === "agent") {
    return (
      <span title={agentTip(item.name)} className="flex shrink-0 self-start">
        <AgentAvatar type={item.name} size={size} quiet />
      </span>
    );
  }
  return <KindTile kind={item.kind} size={size} title={sentenceCase(KIND_BY_ID[item.kind].singular)} />;
}

/** The same picture at list size, for the one-line rows in the panels: an agent's avatar, or the kind's icon at 16 px. */
export function MiniKind({ kind, name }: { kind: string; name: string }) {
  if (kind === "agent") {
    return (
      <span title={agentTip(name)} className="flex shrink-0 self-center">
        <AgentAvatar type={name} size={20} quiet />
      </span>
    );
  }
  const meta = KIND_BY_ID[kind as ItemKind];
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <span title={sentenceCase(meta.singular)} className="flex size-5 shrink-0 items-center justify-center self-center text-ink-2">
      <Icon size={16} aria-hidden="true" />
    </span>
  );
}

/**
 * A file path that wraps after a slash where it can, and inside one long name only when it has
 * to, so no folder name is split in two for nothing. Selecting and copying give the plain path.
 */
export function PathText({ path, className = "" }: { path: string; className?: string }) {
  const parts = path.match(/[^\\/]*[\\/]?/g)?.filter(Boolean) ?? [path];
  return (
    <span className={`mono [overflow-wrap:anywhere] ${className}`}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          <wbr />
        </Fragment>
      ))}
    </span>
  );
}

/** First letter upper-case, the rest as written ("skill" to "Skill", "MCP server" stays). */
export function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A file's size, the one way the app writes one (`formatBytes`): "812 B", "3.4 KB", "2.3 MB". */
export function formatSize(n: number | null): string {
  return n === null ? "" : formatBytes(n);
}

/** "Nov 9, 8:58 PM" (the year when it is not this one): the app's one date and one clock. */
export function formatDate(ms: number | null): string {
  if (!ms) return "";
  return `${shortDate(ms)}, ${clockTime(ms)}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** For screen readers and the sheet title. */
export function describeItem(i: SetupItem): string {
  return `${KIND_BY_ID[i.kind].singular} ${displayName(i)}, ${i.scopeLabel}`;
}
