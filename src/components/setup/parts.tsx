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
import { enabledTone, KIND_BY_ID, type Tone } from "../../lib/setup-model";
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
export function KindTile({ kind, size = 36, icon }: { kind: ItemKind | "more"; size?: number; icon?: ComponentType<IconProps> }) {
  const Icon = icon ?? KIND_BY_ID[kind as ItemKind].icon;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className="kind-tile flex shrink-0 items-center justify-center bg-accent-tint text-accent-text"
    >
      <IconMotion motion={KIND_MOTION[kind] ?? "pop"} size={Math.round(size * 0.55)}>
        <Icon />
      </IconMotion>
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

export function formatSize(n: number | null): string {
  if (n === null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatDate(ms: number | null): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return "";
  }
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
  return `${KIND_BY_ID[i.kind].singular} ${i.name}, ${i.scopeLabel}`;
}
