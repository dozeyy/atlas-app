import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, CaretDown, CaretRight, Check, Copy, CopySimple, Eye, EyeSlash, FolderOpen, Lock, PencilSimple, Trash, WarningCircle, X } from "@phosphor-icons/react";
import { Button } from "../controls";
import { EmptyState } from "../EmptyState";
import { Dialog } from "../Dialog";
import { DuplicateDialog } from "./DuplicateDialog";
import { ItemEditor } from "./ItemEditor";
import { errorText } from "../../lib/setup-actions";
import { pushToast } from "../../state/toastStore";
import { Preview } from "./Preview";
import { getBackend } from "../../lib/ipc";
import { splitFrontmatter } from "../../lib/markdown";
import { sourceCaption } from "../../lib/library";
import { chipWords, connectionWords, displayChips, displayDescription, displayName, KIND_BY_ID, relativeTime, splitSummary, toolsWords } from "../../lib/setup-model";
import { isPerCall, rowFor, usdHover } from "../../lib/setup-cost";
import { compact, exact } from "../../lib/usage";
import type { CostReport, CostRow, MaskedRange, SetupItem, SourceView } from "../../lib/setup-types";
import { Chip, ConflictChip, copyText, formatDate, formatSize, ItemIcon, PathText, ScopeChip, StateChip, TagChip } from "./parts";
import { badge, kindWords } from "../../lib/tagWords";
import { useClosing } from "../../lib/useClosing";

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
      <h3 className="h-sub mb-2">{title}</h3>
      {children}
    </section>
  );
}

type FactRow = { label: string; value: ReactNode; copy?: string };

function Facts({ rows }: { rows: FactRow[] }) {
  return (
    <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2">
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
      row.uses === null ? "" : row.uses === 0 ? ", not run lately" : `, ran ${exact(row.uses)} ${row.uses === 1 ? "time" : "times"}`;
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
      label: "Per message",
      value: <Tokens n={row.tokens} hover={perCall ? "" : usd} />,
    });
    rows.push({ label: "Loads in", value: row.turns > 0 ? `${row.loadsIn}, ${exact(row.turns)} messages` : row.loadsIn });
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
      <p className="mb-3 text-body text-ink-2">Show one to read it for ten seconds. Atlas never saves or logs it.</p>
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
                      className="press inline-flex h-7 cursor-pointer items-center gap-2 rounded-control border border-line-strong bg-surface px-2 text-body font-medium text-ink hover:bg-raised"
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
                    className="press inline-flex h-7 cursor-pointer items-center gap-2 rounded-control border border-line-strong bg-surface px-2 text-body font-medium text-ink hover:bg-raised"
                  >
                    <Eye size={14} aria-hidden="true" />
                    Show
                  </button>
                )}
              </div>
              {open && (
                <code role="status" className="selectable mt-2 block break-all rounded-control bg-raised px-2 py-2 text-ink">
                  {shown.value}
                </code>
              )}
              {failed === r.index && <p className="mt-2 text-caption text-danger">That value could not be read. The file may have changed.</p>}
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
  // As tall as its text (19 px a line, as the viewer sets them, plus its padding and room for a
  // sideways scrollbar), up to the cap: a seven-line file is not shown in a box made for a hundred.
  const lines = src.text.replace(/\n$/, "").split("\n").length;
  return (
    <div
      ref={host}
      style={{ height: `min(420px, calc(var(--app-h) * 0.5), ${lines * 19 + 38}px)` }}
      className="overflow-hidden rounded-card border border-line bg-surface"
    />
  );
}

/** A frontmatter key as the scan reports it (lowercase); every other detail label starts with a capital. */
const RAW_KEY = /^[a-z][a-z0-9_-]*$/;

const FIELD_LABEL: Record<string, string> = {
  name: "Name",
  description: "Description",
  model: "Model",
  tools: "Tools",
  "allowed-tools": "Allowed tools",
  color: "Color",
};

/** Remembers whether "File details" is open, so someone who always wants the path keeps it. */
export const FILE_DETAILS_KEY = "atlas.setup.fileDetailsOpen";

function storedFileDetails(): boolean {
  try {
    return localStorage.getItem(FILE_DETAILS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Where the file is, the settings in its header and its raw text: the long, exact things, kept
 * behind one row so the sheet opens on what the item is and what it says. Closed until asked for.
 * No motion: the sheet is a calm zone.
 */
function FileDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(storedFileDetails);
  const id = useId();
  const Caret = open ? CaretDown : CaretRight;
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(FILE_DETAILS_KEY, next ? "1" : "0");
    } catch {
      // Private mode or a full disk: the row still opens, it just is not remembered.
    }
  };
  return (
    <section className="border-t border-line">
      <h3>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={toggle}
          className="flex w-full cursor-pointer items-center gap-2 px-6 py-4 text-left text-body font-semibold text-ink hover:bg-raised"
        >
          <Caret size={14} aria-hidden="true" className="shrink-0 text-ink-2" />
          File details
        </button>
      </h3>
      {open && (
        <div id={id} className="space-y-5 px-6 pb-4">
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * The lead line: what the item is and does. Two lines at most, so a long description (some run
 * to a hundred words) never pushes the rest of the sheet away; "Show all" opens it in place.
 */
function Lead({ text }: { text: string }) {
  const p = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = p.current;
    if (!el || open) return;
    const check = () => setCut(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, open]);
  return (
    <div className="px-6 py-4">
      <p ref={p} className={`selectable text-lead text-ink ${open ? "" : "line-clamp-2"}`}>
        {text}
      </p>
      {(cut || open) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="mt-1 cursor-pointer text-body font-medium text-accent-text hover:underline"
        >
          {open ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** The tags worth a place beside the title: the ones nothing else on the sheet already says. */
function sheetChips(item: SetupItem): string[] {
  const said = new Set(
    [item.mcp?.transport, ...item.detail.filter((d) => !RAW_KEY.test(d.label)).map((d) => d.value)]
      .filter((v): v is string => Boolean(v))
      .map((v) => v.toLowerCase()),
  );
  // displayChips drops the tags the title and the lead line already say in words. A backup's own
  // chip ("Backup copy") is drawn beside these, so the scan's tag for it is not said twice.
  return displayChips(item).filter((c) => !said.has(c.toLowerCase()) && !(item.backup && c.toLowerCase() === "backup copy"));
}

/** "name@marketplace" as a person reads it: the plugin's name, then where it came from. */
function pluginWords(id: string): string {
  const at = id.lastIndexOf("@");
  return at > 0 ? `${id.slice(0, at)}, from ${sourceCaption(id.slice(at + 1))}` : id;
}

function SourceSection({ item, loads, fileRows }: { item: SetupItem; loads: number; fileRows: FactRow[] }) {
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

  // Known from the file's name before the text arrives, so the heading never changes under the eye.
  const markdown = src ? src.language === "markdown" : /\.md$/i.test(item.path ?? "");
  const parsed = useMemo(() => (src && src.language === "markdown" ? splitFrontmatter(src.text) : null), [src]);
  // The name is the sheet's title and the description its lead line: never a third time here.
  const fields = useMemo(() => parsed?.fields.filter((f) => f.key !== "name" && f.key !== "description") ?? [], [parsed]);

  const waiting = noFile ? (
    <p className="text-body text-ink-2">This lives in your claude.ai account, so there is no file on this computer to show.</p>
  ) : err ? (
    <EmptyState compact variant="error" title="Atlas could not read this file" reason={err} />
  ) : !src ? (
    <div role="status" aria-label="Loading contents" className="skeleton h-40 rounded-card" />
  ) : null;
  const raw = src && (
    <>
      <CodeView src={src} />
      {/* Only what changes how the text reads; the file's size and line endings wait under "File details". */}
      {(src.truncated || src.maskedRanges.length > 0) && (
        <p className="mt-2 text-caption text-ink-2">
          {[src.truncated ? "Only the start is shown." : "", src.maskedRanges.length ? `${src.maskedRanges.length} hidden ${src.maskedRanges.length === 1 ? "value" : "values"}.` : ""].filter(Boolean).join(" ")}
        </p>
      )}
    </>
  );

  return (
    <>
      {src && src.maskedRanges.length > 0 && <HiddenValues itemId={item.id} ranges={src.maskedRanges} />}
      {/* The viewer: the text as it reads for a Markdown file, the file itself for everything else. */}
      <Section title={markdown ? "Preview" : "Contents"}>{waiting ?? (parsed ? <Preview body={parsed.body} /> : raw)}</Section>
      {(fileRows.length > 0 || parsed) && (
        <FileDetails>
          {fileRows.length > 0 && <Facts rows={src ? [...fileRows, { label: "Line endings", value: src.lineEnding === "CRLF" ? "Windows (CRLF)" : "Unix (LF)" }] : fileRows} />}
          {fields.length > 0 && (
            <div>
              <h4 className="h-sub mb-2">Settings in the file's header</h4>
              <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2">
                {fields.map((f) => (
                  <div key={f.key} className="contents">
                    <dt className="text-body text-ink-2">{FIELD_LABEL[f.key] ?? f.key}</dt>
                    <dd className="selectable min-w-0 break-words text-body text-ink">{f.value || "-"}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
          {parsed && (
            <div>
              <h4 className="h-sub mb-2">Raw text</h4>
              {raw}
            </div>
          )}
        </FileDetails>
      )}
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
  const { closing, requestClose } = useClosing(onClose);

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
  const tryClose = () => (editing && dirty ? setDiscard("close") : requestClose());
  const tryStop = () => (dirty ? setDiscard("stop") : leaveEdit());

  // Focus moves in, and back to the card that opened it when the sheet closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  // Toasts centre inside the sheet while it is open (the panel is min(680px, var(--app-w)) wide).
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--toast-inset", "calc(var(--app-w) - min(680px, var(--app-w)))");
    return () => {
      root.style.removeProperty("--toast-inset");
    };
  }, []);

  // Escape must not depend on where focus is: a question that closes can leave it on the page.
  // Keys from inside the panel (or a dialog over it) are handled there and never reach the window.
  const closeRef = useRef(tryClose);
  closeRef.current = tryClose;
  useEffect(() => {
    const onWindowKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (panel.current?.contains(document.activeElement)) return;
      if (document.querySelectorAll('[aria-modal="true"]').length > 1) return; // another question is open
      closeRef.current();
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
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
  // "stdio: npx -y pkg" is the scan's one line; the sheet shows the command or address on its own.
  const link = splitSummary(mcp?.summary ?? "");
  const lead = displayDescription(item);
  const costRow = useMemo(() => rowFor(cost, item.id), [cost, item.id]);
  // Where the file is and when it changed: exact and long, so they wait under "File details".
  // (Where it lives is the chip beside the title.)
  const fileRows: FactRow[] = [
    ...(item.path ? [{ label: "File", value: <PathText path={item.path} />, copy: item.path }] : []),
    ...(item.linkTarget ? [{ label: "Linked to", value: <PathText path={item.linkTarget} />, copy: item.linkTarget }] : []),
    ...(item.size !== null ? [{ label: "Size", value: formatSize(item.size) }] : []),
    ...(item.modifiedMs ? [{ label: "Changed", value: `${formatDate(item.modifiedMs)} (${relativeTime(item.modifiedMs)})` }] : []),
  ];
  // What the item is, in the few short facts that are its own.
  const rows: FactRow[] = [
    // A plugin is stored as "name@marketplace": it reads as its name and where it came from; the id as stored is in the hover.
    ...(item.plugin ? [{ label: "Plugin", value: <span title={item.plugin}>{pluginWords(item.plugin)}</span> }] : []),
    ...(item.usedBy !== null ? [{ label: "Used by", value: item.usedBy === 0 ? "No hook uses this script" : `${item.usedBy} ${item.usedBy === 1 ? "hook" : "hooks"}` }] : []),
    // Raw header keys (lowercase: name, model, ...) are shown once, under "Settings in the file's header".
    // A permission's list and tool are the settings file's own words; its heading and title say both.
    ...item.detail
      .filter((d) => !RAW_KEY.test(d.label) && item.kind !== "permission")
      // A rule such as "Bash(git:*)" reads in words and a plugin goes by its name, not "name@marketplace";
      // the value as written is in the hover.
      .map((d) => {
        const words = d.label === "Allowed tools" ? toolsWords(d.value) : d.label === "Plugin" ? d.value.replace(/^(.+)@[^@]+$/, "$1") : d.value;
        return { label: d.label, value: words !== d.value ? <span title={d.value}>{words}</span> : d.value };
      }),
    // A hook's title is in plain words; the name the settings file uses stays findable here
    // (the scan's own Event and Matcher rows say it when they are present).
    ...(displayName(item) !== item.name && !item.detail.some((d) => d.label === "Event")
      ? [{ label: "In settings", value: <span className="mono text-ink-2 [overflow-wrap:anywhere]">{item.name}</span>, copy: item.name }]
      : []),
  ];

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div aria-hidden="true" onClick={tryClose} data-closing={closing || undefined} className="fade-in absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        data-allow-jump=""
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKey}
        data-closing={closing || undefined}
        className="sheet-enter relative flex h-full w-[min(680px,var(--app-w))] flex-col overflow-y-auto border-l border-line bg-bg shadow-float outline-none"
      >
        <header className="sticky top-0 z-10 flex items-start gap-3 border-b border-line bg-bg px-6 py-4">
          <ItemIcon item={item} size={40} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="h-page selectable break-words">
              {displayName(item)}
            </h2>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {/* The sheet's chips take keyboard focus (there are a few): the tooltip then reads on Tab as well as hover. */}
              <Chip tone="muted" title={kindWords(meta.singular, meta.blurb).tip} focusable>
                {kindWords(meta.singular, meta.blurb).label}
              </Chip>
              <ScopeChip scope={item.scope} label={item.scopeLabel} focusable />
              <StateChip enabled={item.enabled} focusable />
              {item.backup && (
                <Chip tone="muted" title={badge("backupCopy").tip} focusable>
                  {badge("backupCopy").label}
                </Chip>
              )}
              {item.worktree && (
                <Chip tone="muted" title={badge("worktree").tip} focusable>
                  {badge("worktree").label}
                </Chip>
              )}
              {sheetChips(item).map((c) => {
                const { label, title } = chipWords(item, c);
                return (
                  <TagChip key={c} title={title} focusable>
                    {label}
                  </TagChip>
                );
              })}
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
        {lead ? <Lead key={item.id} text={lead} /> : <div className="h-4 shrink-0" />}

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

        {/* What it costs stays first, so it is on screen without scrolling the sheet. */}
        {costRow && cost && <CostSection row={costRow} report={cost} />}

        {rows.length > 0 && (
          <Section title="About">
            <Facts rows={rows} />
          </Section>
        )}

        {conflict && (
          <Section title="Also defined elsewhere">
            <p className="mb-2 flex items-center gap-2 text-body text-ink-2">
              <ConflictChip conflict={conflict} focusable />
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
                      {d.winner && (
                        <Chip tone="good" title={badge("used").tip}>
                          {badge("used").label}
                        </Chip>
                      )}
                      {d.isSelf && (
                        <Chip tone="muted" title={badge("thisOne").tip}>
                          {badge("thisOne").label}
                        </Chip>
                      )}
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
                // How it connects is the lead line, in words; the settings' own word shows only when Atlas has none.
                ...(connectionWords(mcp.transport, link.target) ? [] : [{ label: "Type", value: mcp.transport }]),
                ...(link.target ? [{ label: mcp.transport === "stdio" ? "Command" : "Address", value: <span className="mono break-all text-ink-2">{link.target}</span>, copy: link.target }] : []),
                ...(mcp.envKeys.length ? [{ label: "Environment", value: <span className="mono text-ink-2">{mcp.envKeys.join(", ")}</span> }] : []),
                ...(mcp.headerKeys.length ? [{ label: "Headers", value: <span className="mono text-ink-2">{mcp.headerKeys.join(", ")}</span> }] : []),
              ]}
            />
            {mcp.perProject.length > 0 && (
              <>
                <h4 className="h-sub mb-2 mt-4">
                  Projects{" "}
                  <span className="font-normal">
                    {mcp.onCount} of {mcp.totalProjects || mcp.perProject.length} on
                  </span>
                </h4>
                <ul className="grid max-h-56 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                  {mcp.perProject.map((p) => (
                    <li key={p.projectId} className="flex items-center justify-between gap-2 rounded-control bg-raised px-2 py-2 text-body">
                      <span title={p.projectName} className="truncate text-ink">{p.projectName}</span>
                      <Chip tone={p.on ? "good" : "muted"} title={badge(p.on ? "onHere" : "offHere").tip}>
                        {badge(p.on ? "onHere" : "offHere").label}
                      </Chip>
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
                <li key={a} className="flex items-center gap-2 text-body text-ink">
                  <PathText path={a} className="selectable min-w-0 flex-1" />
                  {item.kind === "skill" && item.editable && (
                    <button
                      type="button"
                      aria-label={`Edit ${a}`}
                      onClick={() => startEdit(a)}
                      className="press inline-flex h-7 shrink-0 cursor-pointer items-center gap-2 rounded-control px-2 text-body text-ink-2 hover:bg-raised hover:text-ink"
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

        <SourceSection item={item} loads={loads} fileRows={fileRows} />
          </>
        )}
        {/* Never takes a click: in a short window a long editor runs under this gap, and Save sits there. */}
        <div className="pointer-events-none h-6 shrink-0" />
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
                  const leaving = discard === "close";
                  setDiscard(null);
                  leaveEdit();
                  if (leaving) requestClose();
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          <p className="text-body text-ink">You have edits to {displayName(item)} that are not saved. If you leave now they are lost.</p>
        </Dialog>
      )}
    </div>,
    document.body,
  );
}
