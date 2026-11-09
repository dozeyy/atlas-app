import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, Check, Copy, CopySimple, Eye, EyeSlash, FolderOpen, Lock, PencilSimple, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { DuplicateDialog } from "./DuplicateDialog";
import { ItemEditor } from "./ItemEditor";
import { errorText } from "../../lib/setup-actions";
import { pushToast } from "../../state/toastStore";
import { Preview } from "./Preview";
import { getBackend } from "../../lib/ipc";
import { splitFrontmatter } from "../../lib/markdown";
import { KIND_BY_ID, relativeTime } from "../../lib/setup-model";
import { isPerCall, rowFor, usdHover } from "../../lib/setup-cost";
import { compact, exact } from "../../lib/usage";
import type { CostReport, CostRow, MaskedRange, SetupItem, SourceView } from "../../lib/setup-types";
import { Chip, ConflictChip, copyText, formatDate, formatSize, KindTile, ScopeChip, StateChip, TagChip } from "./parts";

const REVEAL_MS = 10_000;

function message(e: unknown): string {
  return (e instanceof Error ? e.message : typeof e === "string" ? e : "") || "That could not be read.";
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1400);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={async () => setDone(await copyText(text))}
      className="press flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
    >
      {done ? <Check size={14} weight="bold" aria-hidden="true" className="text-success" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-6 py-4">
      <h3 className="mb-2.5 text-body font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

function Facts({ rows }: { rows: { label: string; value: ReactNode; copy?: string }[] }) {
  return (
    <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2.5">
      {rows.map((r) => (
        <div key={r.label} className="contents">
          <dt className="text-body text-ink-2">{r.label}</dt>
          <dd className="flex min-w-0 items-start gap-1 text-body text-ink">
            <span className="selectable min-w-0 flex-1 break-words">{r.value}</span>
            {r.copy ? <CopyButton text={r.copy} label={`Copy ${r.label.toLowerCase()}`} /> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** `7.3k tokens`, with the exact count (and the API-price estimate, when there is one) on hover. */
function Tokens({ n, hover }: { n: number; hover?: string }) {
  return (
    <span title={[`${exact(n)} tokens.`, hover].filter(Boolean).join(" ")}>
      <span className="font-medium">{compact(n)}</span> tokens
    </span>
  );
}

/**
 * What this one thing costs, in tokens and the honest unit for what it is: skills, agents and
 * commands load their text each time they are called (plus a short listing with every message);
 * instructions, rules, memory, styles and tools load with every message.
 */
function CostSection({ row, report }: { row: CostRow; report: CostReport }) {
  const rows: { label: string; value: ReactNode }[] = [];
  const usd = usdHover(row, report);
  const perCall = isPerCall(row.kind);
  if (perCall && row.bodyTokens > 0) {
    const ran =
      row.uses === null ? "" : row.uses === 0 ? ", not run lately" : `, ran ${row.uses.toLocaleString()} ${row.uses === 1 ? "time" : "times"}`;
    rows.push({
      label: "Per call",
      value: (
        <>
          <Tokens n={row.bodyTokens} hover={usd} />
          {ran}
        </>
      ),
    });
  }
  if (row.tokens > 0) {
    rows.push({
      label: perCall ? "Listed" : "Per message",
      value: (
        <>
          <Tokens n={row.tokens} hover={perCall ? "" : usd} />
          {perCall ? " with every message, so Claude knows it exists" : ""}
        </>
      ),
    });
    rows.push({ label: "Loads in", value: row.turns > 0 ? `${row.loadsIn} (${row.turns.toLocaleString()} messages)` : row.loadsIn });
  }
  if (!perCall && row.tokens === 0 && row.bodyTokens > 0) {
    rows.push({
      label: "When used",
      value: (
        <>
          <Tokens n={row.bodyTokens} hover={usd} />
          {row.kind === "rule" ? ", when a file it covers is touched" : ""}
        </>
      ),
    });
  }
  if (rows.length === 0) return null;
  return (
    <Section title="What it costs">
      <div title={usd || undefined}>
        <Facts rows={rows} />
      </div>
    </Section>
  );
}

/** One value at a time, on request, gone after ten seconds. Never stored anywhere else. */
function HiddenValues({ itemId, ranges }: { itemId: string; ranges: MaskedRange[] }) {
  const [shown, setShown] = useState<{ index: number; value: string } | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A different item (or reloaded text) must not keep an old value on screen.
  useEffect(() => setShown(null), [itemId]);

  const hide = () => {
    window.clearTimeout(timer.current);
    setShown(null);
  };

  const show = async (index: number) => {
    setFailed(null);
    try {
      const value = await getBackend().setupReveal(itemId, index);
      window.clearTimeout(timer.current);
      setShown({ index, value });
      timer.current = window.setTimeout(() => setShown(null), REVEAL_MS);
    } catch {
      setFailed(index);
    }
  };

  return (
    <Section title="Hidden values">
      <p className="mb-3 text-body text-ink-2">
        These are kept out of sight. Show one to read it for ten seconds; Atlas never saves or logs it.
      </p>
      <ul className="overflow-hidden rounded-card border border-line">
        {ranges.map((r) => {
          const open = shown?.index === r.index;
          return (
            <li key={`${r.index}-${r.key}`} className="border-b border-line px-3 py-2 last:border-b-0">
              <div className="flex items-center gap-3">
                <Lock size={14} aria-hidden="true" className="shrink-0 text-ink-2" />
                <span className="mono min-w-0 flex-1 truncate text-ink">{r.key || "value"}</span>
                {open ? (
                  <>
                    <CopyButton text={shown.value} label={`Copy value of ${r.key}`} />
                    <button
                      type="button"
                      onClick={hide}
                      className="press inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border border-line-strong bg-surface px-2.5 text-body font-medium text-ink hover:bg-raised"
                    >
                      <EyeSlash size={14} aria-hidden="true" />
                      Hide
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    aria-label={`Show value of ${r.key}`}
                    onClick={() => void show(r.index)}
                    className="press inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border border-line-strong bg-surface px-2.5 text-body font-medium text-ink hover:bg-raised"
                  >
                    <Eye size={14} aria-hidden="true" />
                    Show
                  </button>
                )}
              </div>
              {open && (
                <code role="status" className="selectable mt-2 block break-all rounded-control bg-raised px-2.5 py-2 text-ink">
                  {shown.value}
                </code>
              )}
              {failed === r.index && <p className="mt-1.5 text-caption text-danger">That value could not be read. The file may have changed.</p>}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function CodeView({ src }: { src: SourceView }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    let destroy = () => {};
    void import("../../lib/codemirror").then(async (m) => {
      const v = await m.mountViewer(el, src.text, src.language, src.maskedRanges);
      if (dead) v.destroy();
      else destroy = () => v.destroy();
    });
    return () => {
      dead = true;
      destroy();
    };
  }, [src]);
  return <div ref={host} className="h-[min(420px,50vh)] overflow-hidden rounded-card border border-line bg-surface" />;
}

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  description: "Description",
  model: "Model",
  tools: "Tools",
  "allowed-tools": "Allowed tools",
  color: "Color",
};

/** The header fields (model and tools for agents) and the text as it reads. */
function MarkdownSections({ text }: { text: string }) {
  const { fields, body } = useMemo(() => splitFrontmatter(text), [text]);
  return (
    <>
      {fields.length > 0 && (
        <Section title="Settings in the file's header">
          <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2">
            {fields.map((f) => (
              <div key={f.key} className="contents">
                <dt className="text-body text-ink-2">{FIELD_LABEL[f.key] ?? f.key}</dt>
                <dd className="selectable min-w-0 break-words text-body text-ink">{f.value || "-"}</dd>
              </div>
            ))}
          </dl>
        </Section>
      )}
      <Section title="Preview">
        <Preview body={body} />
      </Section>
    </>
  );
}

function SourceSection({ item, loads }: { item: SetupItem; loads: number }) {
  const [src, setSrc] = useState<SourceView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const noFile = item.path === null && item.scope === "connector";

  // A different item starts from a blank; a reload after a change on disk swaps quietly.
  useEffect(() => {
    setSrc(null);
    setErr(null);
  }, [item.id]);

  useEffect(() => {
    if (noFile) return;
    let alive = true;
    getBackend()
      .setupReadSource(item.id)
      .then((s) => {
        if (!alive) return;
        setSrc(s);
        setErr(null);
      })
      .catch((e) => alive && setErr(message(e)));
    return () => {
      alive = false;
    };
  }, [item.id, loads, noFile]);

  return (
    <>
      {src && src.maskedRanges.length > 0 && <HiddenValues itemId={item.id} ranges={src.maskedRanges} />}
      {src && src.language === "markdown" && <MarkdownSections text={src.text} />}
      <Section title={src?.language === "markdown" ? "Raw text" : "Contents"}>
        {noFile ? (
          <p className="text-body text-ink-2">This lives in your claude.ai account, so there is no file on this computer to show.</p>
        ) : err ? (
          <p role="alert" className="text-body text-ink-2">
            {err}
          </p>
        ) : !src ? (
          <div role="status" aria-label="Loading contents" className="skeleton h-40 rounded-card" />
        ) : (
          <>
            <CodeView src={src} />
            <p className="mt-2 text-caption text-ink-2">
              {formatSize(src.size)} - {src.lineEnding}
              {src.truncated ? " - only the start is shown" : ""}
              {src.maskedRanges.length ? ` - ${src.maskedRanges.length} hidden ${src.maskedRanges.length === 1 ? "value" : "values"}` : ""}
            </p>
          </>
        )}
      </Section>
    </>
  );
}

export function DetailSheet({
  item,
  all,
  loads,
  cost = null,
  onClose,
  onOpen,
  onDelete,
}: {
  item: SetupItem;
  all: Map<string, SetupItem>;
  loads: number;
  /** What the setup costs; the item's own figures show when it has a row. */
  cost?: CostReport | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  onDelete: (item: SetupItem) => void;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const meta = KIND_BY_ID[item.kind];
  const [editing, setEditing] = useState(false);
  const [editFile, setEditFile] = useState<string | undefined>(undefined);
  const [dirty, setDirty] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [discard, setDiscard] = useState<"close" | "stop" | null>(null);

  // A different item always opens on its details, never inside the last one's editor.
  useEffect(() => {
    setEditing(false);
    setEditFile(undefined);
    setDirty(false);
    setDuplicating(false);
  }, [item.id]);

  const leaveEdit = () => {
    setEditing(false);
    setEditFile(undefined);
    setDirty(false);
  };
  const startEdit = (file?: string) => {
    setEditFile(file);
    setEditing(true);
  };
  const reachFile = async (open: boolean) => {
    try {
      await getBackend().setupOpenFile(item.id, undefined, open);
    } catch (e) {
      pushToast({ message: errorText(e, open ? "Atlas could not open that file." : "Atlas could not show that file."), tone: "error" });
    }
  };
  const canDuplicate = item.kind === "skill" && item.scope === "user" && item.path !== null;
  const taken = useMemo(
    () => new Set(Array.from(all.values()).filter((i) => i.kind === "skill" && i.scope === "user").map((i) => i.name)),
    [all],
  );
  const hasFile = item.path !== null && item.scope !== "connector";
  const tryClose = () => (editing && dirty ? setDiscard("close") : onClose());
  const tryStop = () => (dirty ? setDiscard("stop") : leaveEdit());

  // Focus moves in, and back to the card that opened it when the sheet closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      tryClose();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const f = Array.from(panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])')).filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const { mcp, conflict } = item;
  const costRow = useMemo(() => rowFor(cost, item.id), [cost, item.id]);
  const rows: { label: string; value: ReactNode; copy?: string }[] = [
    { label: "Where", value: item.scopeLabel },
    ...(item.plugin ? [{ label: "Plugin", value: item.plugin }] : []),
    ...(item.path ? [{ label: "File", value: <span className="mono break-all">{item.path}</span>, copy: item.path }] : []),
    ...(item.linkTarget ? [{ label: "Linked to", value: <span className="mono break-all">{item.linkTarget}</span>, copy: item.linkTarget }] : []),
    ...(item.size !== null ? [{ label: "Size", value: formatSize(item.size) }] : []),
    ...(item.modifiedMs ? [{ label: "Changed", value: `${formatDate(item.modifiedMs)} (${relativeTime(item.modifiedMs)})` }] : []),
    ...(item.usedBy !== null ? [{ label: "Used by", value: item.usedBy === 0 ? "No hook uses this script" : `${item.usedBy} ${item.usedBy === 1 ? "hook" : "hooks"}` }] : []),
    ...item.detail.map((d) => ({ label: d.label, value: d.value })),
  ];

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div aria-hidden="true" onClick={tryClose} className="fade-in absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        data-allow-jump=""
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKey}
        className="sheet-enter relative flex h-full w-[min(680px,100vw)] flex-col overflow-y-auto border-l border-line bg-bg shadow-float outline-none"
      >
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-line bg-bg px-6 py-4">
          <KindTile kind={item.kind} size={40} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="selectable break-words text-subtitle font-semibold text-ink">
              {item.name}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Chip tone="muted">{meta.singular}</Chip>
              <ScopeChip scope={item.scope} label={item.scopeLabel} />
              <StateChip enabled={item.enabled} />
              {item.backup && <Chip tone="muted">backup copy</Chip>}
              {item.worktree && <Chip tone="muted">agent worktree</Chip>}
            </div>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={tryClose}
            className="press flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {(item.editable || item.deletable || item.locked || hasFile) && (
          <div className="flex flex-wrap items-center gap-2 px-6 pt-4">
            {item.editable && !editing && (
              <Button variant="primary" onClick={() => startEdit()}>
                <PencilSimple size={14} weight="bold" aria-hidden="true" />
                Edit
              </Button>
            )}
            {hasFile && (
              <Button onClick={() => void reachFile(false)} title="Show this in your file manager">
                <FolderOpen size={14} aria-hidden="true" />
                Show in folder
              </Button>
            )}
            {hasFile && !editing && (
              <Button onClick={() => void reachFile(true)} title="Open this file in the program your computer uses for it">
                <ArrowSquareOut size={14} aria-hidden="true" />
                Open in editor
              </Button>
            )}
            {canDuplicate && !editing && (
              <Button onClick={() => setDuplicating(true)}>
                <CopySimple size={14} aria-hidden="true" />
                Duplicate
              </Button>
            )}
            {item.deletable && !editing && (
              <Button onClick={() => onDelete(item)} className="hover:text-danger">
                <Trash size={14} aria-hidden="true" />
                Delete
              </Button>
            )}
            {item.locked && (
              <p role="note" className="flex items-center gap-2 text-body text-ink-2">
                <Lock size={14} aria-hidden="true" className="shrink-0" />
                {item.locked}
              </p>
            )}
          </div>
        )}

        {editing ? (
          <ItemEditor key={item.id} item={item} initialFile={editFile} onCancel={tryStop} onDirtyChange={setDirty} />
        ) : (
          <>
        {item.description && <p className="selectable px-6 py-4 text-lead text-ink">{item.description}</p>}

        {item.warnings.length > 0 && (
          <div role="note" className="mx-6 mb-4 rounded-card bg-warning-tint px-4 py-3 text-body text-warning">
            {item.warnings.map((w) => (
              <p key={w} className="flex items-start gap-2">
                <WarningCircle size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
                <span>{w}</span>
              </p>
            ))}
          </div>
        )}

        {costRow && cost && <CostSection row={costRow} report={cost} />}

        <Section title="About">
          <Facts rows={rows} />
          {item.chips.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {item.chips.map((c) => (
                <TagChip key={c}>{c}</TagChip>
              ))}
            </div>
          )}
        </Section>

        {conflict && (
          <Section title="Also defined elsewhere">
            <p className="mb-2.5 flex items-center gap-2 text-body text-ink-2">
              <ConflictChip conflict={conflict} />
              The first one listed is the one Claude uses.
            </p>
            <ul className="overflow-hidden rounded-card border border-line">
              {conflict.definedIn.map((d) => {
                const target = all.get(d.id);
                return (
                  <li key={d.id} className="border-b border-line last:border-b-0">
                    <button
                      type="button"
                      disabled={d.isSelf || !target}
                      onClick={() => onOpen(d.id)}
                      className="press flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-body text-ink hover:bg-raised disabled:cursor-default disabled:hover:bg-transparent"
                    >
                      <span className="min-w-0 flex-1 truncate">{d.scopeLabel}</span>
                      {d.winner && <Chip tone="good">Used</Chip>}
                      {d.isSelf && <Chip tone="muted">This one</Chip>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}

        {mcp && (
          <Section title="Connection">
            <Facts
              rows={[
                { label: "Type", value: mcp.transport },
                ...(mcp.summary ? [{ label: "Runs", value: <span className="mono break-all">{mcp.summary}</span> }] : []),
                ...(mcp.envKeys.length ? [{ label: "Environment", value: <span className="mono">{mcp.envKeys.join(", ")}</span> }] : []),
                ...(mcp.headerKeys.length ? [{ label: "Headers", value: <span className="mono">{mcp.headerKeys.join(", ")}</span> }] : []),
              ]}
            />
            {mcp.perProject.length > 0 && (
              <>
                <h4 className="mb-2 mt-4 text-body font-medium text-ink">
                  Projects{" "}
                  <span className="font-normal text-ink-2">
                    ({mcp.onCount} of {mcp.totalProjects || mcp.perProject.length} on)
                  </span>
                </h4>
                <ul className="grid max-h-56 grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
                  {mcp.perProject.map((p) => (
                    <li key={p.projectId} className="flex items-center justify-between gap-2 rounded-control bg-raised px-2.5 py-1.5 text-body">
                      <span className="truncate text-ink">{p.projectName}</span>
                      <Chip tone={p.on ? "good" : "muted"}>{p.on ? "On" : "Off"}</Chip>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>
        )}

        {item.attachments.length > 0 && (
          <Section title="Files that come with it">
            <ul className="space-y-1">
              {item.attachments.map((a) => (
                <li key={a} className="mono flex items-center gap-2 text-ink">
                  <span className="selectable min-w-0 flex-1 break-all">{a}</span>
                  {item.kind === "skill" && item.editable && (
                    <button
                      type="button"
                      aria-label={`Edit ${a}`}
                      onClick={() => startEdit(a)}
                      className="press inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-control px-2 text-body text-ink-2 hover:bg-raised hover:text-ink"
                    >
                      <PencilSimple size={14} aria-hidden="true" />
                      Edit
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Section>
        )}

        <SourceSection item={item} loads={loads} />
          </>
        )}
        <div className="h-6 shrink-0" />
      </div>
      {duplicating && <DuplicateDialog item={item} taken={taken} onClose={() => setDuplicating(false)} />}
      {discard && (
        <Dialog
          alert
          title="Discard your changes?"
          onClose={() => setDiscard(null)}
          footer={
            <>
              <Button autoFocus onClick={() => setDiscard(null)}>
                Keep editing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const closing = discard === "close";
                  setDiscard(null);
                  leaveEdit();
                  if (closing) onClose();
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          <p className="text-body text-ink">You have edits to {item.name} that are not saved. If you leave now they are lost.</p>
        </Dialog>
      )}
    </div>,
    document.body,
  );
}
