import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, CaretRight, Package, X } from "@phosphor-icons/react";
import { Button } from "../controls";
import { EmptyState } from "../EmptyState";
import { Chip } from "../setup/parts";
import { badge } from "../../lib/tagWords";
import { AgentAvatar } from "../usage/helperKit";
import { KIND_BY_ID } from "../../lib/setup-model";
import { PluginTile, tileState } from "./LibraryList";
import { SafetyCheck } from "./SafetyCheck";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import { entryTopic, insideWords, installBlock, isClean, itemFile, itemWord, languageOf, readingWords, sourceCaption } from "../../lib/library";
import type { CatalogEntry, InnerItem, InstalledRow, LibraryDetail, LibraryProgress } from "../../lib/libraryTypes";
import { dropCheck, installPlugin, storeCheck, storedCheck, uninstallPlugin, useLibrary } from "../../state/libraryStore";

/** What the sheet is about: a catalog entry and/or an installed plugin. */
export interface SheetTarget {
  pluginId: string;
  name: string;
  entry: CatalogEntry | null;
  /** Put focus on Install when the check is done (a row's Install that could not go at once). */
  focusInstall?: boolean;
}

const EASY = "Atlas could not read that. Check your connection and try again.";

function Section({ title, aside, className = "", children }: { title: string; aside?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`border-t border-line px-6 py-4 ${className}`}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h3 className="h-sub shrink-0">{title}</h3>
        {aside && <span className="min-w-0 truncate text-caption text-ink-2">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

/** The kind of thing an item is, as the Toolkit draws it: an agent wears its avatar, the rest their kind's icon. */
function KindIcon({ kind, name }: { kind: string; name: string }) {
  if (kind === "agent") return <AgentAvatar type={name} size={20} quiet />;
  const Icon = kind in KIND_BY_ID ? KIND_BY_ID[kind as keyof typeof KIND_BY_ID].icon : Package;
  return <Icon size={16} aria-hidden="true" className="shrink-0 text-ink-2" />;
}

/** One file of the plugin, read-only, so the person can see what it says before installing. */
function FileView({ token, item, onBack }: { token: string; item: InnerItem; onBack: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ text: string; truncated: boolean } | { error: string } | null>(null);
  const rel = itemFile(item);

  useEffect(() => {
    let dead = false;
    setState(null);
    getBackend()
      .libraryReadFile(token, rel)
      .then((f) => !dead && setState(f))
      .catch((e) => !dead && setState({ error: errorText(e, "Atlas could not read that file.") }));
    return () => {
      dead = true;
    };
  }, [token, rel]);

  const text = state && "text" in state ? state : null;
  useEffect(() => {
    const el = host.current;
    if (!el || !text) return;
    let dead = false;
    let destroy = () => {};
    void import("../../lib/codemirror").then(async (m) => {
      const v = await m.mountViewer(el, text.text, languageOf(rel), []);
      if (dead) v.destroy();
      else destroy = () => v.destroy();
    });
    return () => {
      dead = true;
      destroy();
    };
  }, [text, rel]);

  return (
    <div className="mt-3">
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={onBack} className="press cursor-pointer rounded-control px-2 py-1 text-body text-accent-text hover:bg-accent-tint">
          Back to the list
        </button>
        <span title={rel} className="mono min-w-0 flex-1 truncate text-caption text-ink-2">
          {rel}
        </span>
      </div>
      {state === null && <div role="status" aria-label="Reading the file" className="skeleton h-40 rounded-card" />}
      {state && "error" in state && <EmptyState compact variant="error" title="Atlas could not read that file" reason={state.error} />}
      {text && (
        <>
          <div ref={host} className="h-[min(360px,45vh)] overflow-hidden rounded-card border border-line bg-surface" />
          {text.truncated && <p className="mt-1.5 text-caption text-ink-2">Only the first part of this file is shown.</p>}
        </>
      )}
    </div>
  );
}

export function LibrarySheet({ target, onClose }: { target: SheetTarget; onClose: () => void }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const installBtn = useRef<HTMLButtonElement>(null);
  const checkBox = useRef<HTMLDivElement>(null);
  const lib = useLibrary();
  const cli = lib.view?.cli ?? false;
  const installed: InstalledRow | undefined = lib.installed.find((r) => r.kind === "plugin" && r.id === target.pluginId);
  const busy = lib.busy[target.pluginId];

  const [detail, setDetail] = useState<LibraryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [file, setFile] = useState<InnerItem | null>(null);
  const installedNow = useRef(!!installed);
  installedNow.current = !!installed;

  const load = useCallback(
    (fresh: boolean) => {
      let dead = false;
      setDetail(null);
      setError(null);
      setProgress(null);
      setFile(null);
      const b = getBackend();
      const stored = fresh ? undefined : storedCheck(target.pluginId);
      const run = stored
        ? Promise.resolve(stored)
        : installedNow.current
          ? b.libraryInspectInstalled(target.pluginId)
          : b.libraryInspectPlugin(target.pluginId);
      run
        .then((d) => {
          if (dead) return;
          if (!installedNow.current) storeCheck(target.pluginId, d);
          setDetail(d);
        })
        .catch((e) => !dead && setError(errorText(e, EASY)));
      return () => {
        dead = true;
      };
    },
    [target.pluginId],
  );

  useEffect(() => load(false), [load]);

  // "Reading owner/repo... 2.1 MB" while the files come down.
  useEffect(() => {
    let off = () => {};
    let dead = false;
    getBackend()
      .onLibraryProgress((p) => setProgress(p))
      .then((u) => (dead ? u() : (off = u)))
      .catch(() => {});
    return () => {
      dead = true;
      off();
    };
  }, []);

  // Focus moves in, and back to the row that opened it.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (!detail || !target.focusInstall) return;
    // The deliberate second click is never one Enter away: when the check flagged something, could
    // not read something, or the plugin follows a branch, focus goes to what must be read first.
    if (!isClean(detail.inspected) || detail.confirmNote) checkBox.current?.focus();
    else installBtn.current?.focus();
  }, [detail, target.focusInstall]);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--toast-inset", "calc(100vw - min(480px, 100vw))");
    return () => {
      root.style.removeProperty("--toast-inset");
    };
  }, []);

  const loading = !detail && !error;
  const close = useCallback(() => {
    if (loading) void getBackend().libraryCancel();
    onClose();
  }, [loading, onClose]);
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    const onWindowKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (panel.current?.contains(document.activeElement)) return;
      if (document.querySelectorAll('[aria-modal="true"]').length > 1) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onWindowKey);
    return () => window.removeEventListener("keydown", onWindowKey);
  }, []);

  const block = target.entry ? installBlock(target.entry, cli) : null;
  const canInstall = !!detail && !installed && !block && !busy;

  const doInstall = async () => {
    if (!detail || !canInstall) return;
    const out = await installPlugin(target.pluginId, target.name, detail.token);
    if (out) onClose();
    else load(true);
  };
  const doInstallRef = useRef(doInstall);
  doInstallRef.current = doInstall;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void doInstallRef.current();
      return;
    }
    if (e.key !== "Tab" || !panel.current) return;
    const f = Array.from(panel.current.querySelectorAll<HTMLElement>('button, [href], input, select, [tabindex]:not([tabindex="-1"])')).filter(
      (el) => !el.hasAttribute("disabled"),
    );
    if (!f.length) return;
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === panel.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const shaped = detail?.inspected.shaped;
  const entry = target.entry;
  const repo = detail?.repo || "";
  const description = entry?.description || shaped?.description || "";
  const from = entry ? sourceCaption(entry.marketplace) : "";
  const version = entry?.version || installed?.version || "";
  // The exact thing that was read: said quietly under the check, the whole id one hover away.
  // The surface says the version in plain words; the commit id is for the hover.
  const checked = version ? `Version ${version}` : detail?.sha ? "The copy Atlas read" : "";
  const checkedTip = detail?.sha ? `Commit ${detail.sha}` : undefined;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      <div aria-hidden="true" onClick={close} className="fade-in absolute inset-0 bg-[var(--scrim)]" />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        data-allow-jump=""
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKey}
        className="sheet-enter relative flex h-full w-[min(480px,100vw)] flex-col border-l border-line bg-bg shadow-float outline-none"
      >
        <header className="flex items-start gap-3 border-b border-line px-6 py-4">
          <PluginTile topic={entryTopic({ name: target.name, description: entry?.description })} state={tileState(installed)} size={40} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="h-page selectable break-words">
              {target.name}
            </h2>
            {/* Where it comes from, in words. The version and the commit are under the check, not up here. */}
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-ink-2">
              {from && <span className="min-w-0 truncate">{from}</span>}
              {repo && (
                <button
                  type="button"
                  onClick={() => void getBackend().libraryOpenRepo(repo)}
                  title={`Open ${repo} on GitHub`}
                  className="press inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 text-accent-text hover:underline"
                >
                  <span className="truncate">{repo}</span>
                  <ArrowSquareOut size={12} aria-hidden="true" className="shrink-0" />
                </button>
              )}
              {installed && (
                <Chip tone={installed.changed ? "warn" : "good"} title={badge(installed.changed ? "installedChanged" : installed.enabled === false ? "installedOff" : "installed").tip} focusable>
                  {badge(installed.changed ? "installedChanged" : installed.enabled === false ? "installedOff" : "installed").label}
                </Chip>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className="press flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        {/* Top: what it is and what is inside. Bottom, next to the button: what Atlas found. Spare room sits between the two. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {description && <p className="selectable break-words px-6 py-4 text-body text-ink">{description}</p>}

          {loading && (
            <div className="border-t border-line px-6 py-4">
              <p role="status" className="text-body text-ink-2">
                {readingWords(repo || target.name, progress?.downloaded ?? 0)}
              </p>
              <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                <div
                  className="h-full rounded-full bg-accent"
                  style={{ width: progress?.total ? `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` : "35%" }}
                />
              </div>
              <div className="mt-3">
                <Button onClick={close}>Cancel</Button>
              </div>
            </div>
          )}

          {error && (
            <div className="border-t border-line px-6 py-4">
              {/* The Library writes its own reasons in plain words, so the sentence stays on the surface. */}
              <EmptyState
                compact
                variant="error"
                title="Atlas could not check this"
                body={error}
                action={{
                  onClick: () => {
                    dropCheck(target.pluginId);
                    load(true);
                  },
                }}
              />
            </div>
          )}

          {detail && shaped && (
            <>
              <Section title="What's inside" aside={shaped.items.length > 0 ? insideWords(shaped.items) : undefined}>
                {shaped.items.length === 0 ? (
                  <p className="text-body text-ink-2">Atlas found no skills, agents or commands to list.</p>
                ) : (
                  <>
                    {!file && (
                      <ul className="-mx-2 grid grid-cols-[minmax(0,1fr)] gap-0.5">
                        {shaped.items.map((i) => (
                          <li key={i.rel}>
                            <button
                              type="button"
                              title={`Read ${i.name}`}
                              onClick={() => setFile(i)}
                              className="row-btn items-center gap-2.5 rounded-control px-2 py-1.5 text-body text-ink"
                            >
                              <KindIcon kind={i.kind} name={i.name} />
                              <span className="min-w-0 flex-1 truncate">{i.name}</span>
                              <span className="shrink-0 text-caption text-ink-2">{itemWord(i.kind)}</span>
                              <CaretRight size={12} weight="bold" aria-hidden="true" className="shrink-0 text-ink-2" />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {file && <FileView token={detail.token} item={file} onBack={() => setFile(null)} />}
                  </>
                )}
              </Section>

              <Section title={installed ? "What Atlas found" : "Before you install"} aside={checked ? <span title={checkedTip}>{checked}</span> : undefined} className="mt-auto">
                <div ref={checkBox} tabIndex={-1} aria-label="What Atlas found" className="rounded-card outline-none">
                  <SafetyCheck report={detail.inspected.check} notInstalled={shaped.notInstalled} />
                </div>
                {installed?.changed && (
                  <div role="note" className="mt-3 flex items-center gap-3 rounded-card bg-warning-tint px-4 py-3 text-body text-warning">
                    <span className="min-w-0 flex-1">Changed since you checked it.</span>
                    <Button
                      onClick={() => {
                        dropCheck(target.pluginId);
                        load(true);
                      }}
                    >
                      Check again
                    </Button>
                  </div>
                )}
              </Section>
            </>
          )}
        </div>

        <footer className="border-t border-line px-6 py-4">
          {block && !installed && (
            <p role="note" className="mb-3 text-body text-ink-2">
              {block}
            </p>
          )}
          {installed ? (
            confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto text-body text-ink">Uninstall {target.name}?</span>
                <Button autoFocus onClick={() => setConfirming(false)}>
                  Keep it
                </Button>
                <Button
                  variant="danger-solid"
                  disabled={!!busy}
                  onClick={async () => {
                    if (await uninstallPlugin(target.pluginId, target.name)) onClose();
                  }}
                >
                  {busy === "removing" ? "Removing..." : "Uninstall"}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-end">
                <Button onClick={() => setConfirming(true)}>Uninstall</Button>
              </div>
            )
          ) : (
            <div className="flex items-center justify-end gap-2">
              {detail && !isClean(detail.inspected) && <span className="mr-auto text-caption text-ink-2">Look over the list above first.</span>}
              {detail && isClean(detail.inspected) && detail.confirmNote && <span className="mr-auto text-caption text-ink-2">{detail.confirmNote}</span>}
              <Button variant="primary" ref={installBtn} disabled={!canInstall} onClick={() => void doInstall()}>
                {busy === "installing" ? "Installing..." : "Install"}
              </Button>
            </div>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
