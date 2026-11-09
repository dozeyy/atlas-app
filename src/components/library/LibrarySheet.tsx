import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowSquareOut, Package, X } from "@phosphor-icons/react";
import { Button } from "../controls";
import { Chip, KindTile } from "../setup/parts";
import { SafetyCheck } from "./SafetyCheck";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import { insideWords, installBlock, isClean, itemFile, itemWord, languageOf, readingWords, sourceCaption } from "../../lib/library";
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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line px-6 py-4">
      <h3 className="mb-2.5 text-body font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
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
        <span className="mono min-w-0 flex-1 truncate text-caption text-ink-2">{rel}</span>
      </div>
      {state === null && <div role="status" aria-label="Reading the file" className="skeleton h-40 rounded-card" />}
      {state && "error" in state && (
        <p role="alert" className="text-body text-ink-2">
          {state.error}
        </p>
      )}
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
    if (detail && target.focusInstall) installBtn.current?.focus();
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
  const facts = [
    repo || (entry ? sourceCaption(entry.marketplace) : ""),
    entry?.version ? `v${entry.version}` : installed?.version ? `v${installed.version}` : "",
    detail?.sha ? detail.sha.slice(0, 7) : "",
  ].filter(Boolean);

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
          <KindTile kind="more" icon={Package} size={40} />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="selectable break-words text-subtitle font-semibold text-ink">
              {target.name}
            </h2>
            <p className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-caption text-ink-2">
              {facts.map((f, i) =>
                i === 0 && repo ? (
                  <button
                    key={f}
                    type="button"
                    onClick={() => void getBackend().libraryOpenRepo(repo)}
                    title="Open on GitHub"
                    className="press mono inline-flex max-w-full cursor-pointer items-center gap-1 truncate text-accent-text hover:underline"
                  >
                    <span className="truncate">{f}</span>
                    <ArrowSquareOut size={12} aria-hidden="true" className="shrink-0" />
                  </button>
                ) : (
                  <span key={f} className={i === 0 ? "" : "mono"}>
                    {f}
                  </span>
                ),
              )}
              {installed && <Chip tone="good">Installed</Chip>}
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {description && <p className="selectable px-6 py-4 text-body text-ink">{description}</p>}

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
              <p role="alert" className="text-body text-ink">
                {error}
              </p>
              <div className="mt-3">
                <Button
                  onClick={() => {
                    dropCheck(target.pluginId);
                    load(true);
                  }}
                >
                  Try again
                </Button>
              </div>
            </div>
          )}

          {detail && shaped && (
            <>
              <Section title="What's inside">
                {shaped.items.length === 0 ? (
                  <p className="text-body text-ink-2">Atlas found no skills, agents or commands to list.</p>
                ) : (
                  <>
                    <p className="mb-2 text-body text-ink-2">{insideWords(shaped.items)}</p>
                    {!file && (
                      <ul className="grid gap-0.5">
                        {shaped.items.map((i) => (
                          <li key={i.rel}>
                            <button
                              type="button"
                              onClick={() => setFile(i)}
                              className="row-btn items-center gap-2 rounded-control px-2 py-1.5 text-body text-ink"
                            >
                              <span className="min-w-0 flex-1 truncate">{i.name}</span>
                              <span className="shrink-0 text-caption text-ink-2">{itemWord(i.kind)}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                    {file && <FileView token={detail.token} item={file} onBack={() => setFile(null)} />}
                  </>
                )}
              </Section>

              <Section title="Before you install">
                <SafetyCheck report={detail.inspected.check} notInstalled={shaped.notInstalled} />
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
                <Button onClick={() => setConfirming(false)}>Keep it</Button>
                <Button
                  variant="danger"
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
