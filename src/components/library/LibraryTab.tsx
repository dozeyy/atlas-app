import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowsClockwise, GithubLogo, MagnifyingGlass, Package, X } from "@phosphor-icons/react";
import { Button, IconButton } from "../controls";
import { EmptyState } from "../EmptyState";
import { SelectField } from "../usage/fields";
import { AddFromGitHub } from "./AddFromGitHub";
import { LibraryList, type RowActions } from "./LibraryList";
import { LibrarySheet, type SheetTarget } from "./LibrarySheet";
import { SourceRail } from "./SourceRail";
import { NO_CLI, OFFLINE, buildRows, sourceOptions, toolkitIdFor, updatedWords, type LibraryRow } from "../../lib/library";
import { openToolkitItemNext, openToolkitTabNext } from "../../lib/nav";
import { installPlugin, openLibrary, refreshLibrary, reportFirstRows, setQuery, setSource, storedCheck, useLibrary } from "../../state/libraryStore";
import { useSetup } from "../../state/setupStore";
import { pushToast } from "../../state/toastStore";

/** True from this width up (the source rail needs room). Plain browsers without matchMedia count as wide. */
function useWide(px: number): boolean {
  const q = `(min-width: ${px}px)`;
  const get = () => (typeof window.matchMedia === "function" ? window.matchMedia(q).matches : true);
  const [wide, setWide] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const m = window.matchMedia(q);
    const on = () => setWide(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [q]);
  return wide;
}

/** Toolkit > Library: find a plugin or skill, read what it is, install it. */
export function LibraryTab() {
  const lib = useLibrary();
  const wide = useWide(1100);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [sheet, setSheet] = useState<SheetTarget | null>(null);
  const [adding, setAdding] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{ index: number; n: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => openLibrary(), []);
  // "Updated 3 min ago" stays true without anyone clicking.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const query = useDeferredValue(lib.query);
  const rows = useMemo(() => buildRows({ idx: lib.idx, installed: lib.installed, source: lib.source, query }), [lib.idx, lib.installed, lib.source, query]);
  const options = useMemo(() => sourceOptions(lib.view?.entries ?? [], lib.view?.marketplaces ?? [], lib.installed.length), [lib.view, lib.installed.length]);
  const cli = lib.view?.cli ?? true;

  const index = selectedKey ? rows.findIndex((r) => r.key === selectedKey) : -1;
  // The highlighted row follows the filter: when it is gone, nothing is highlighted.
  useEffect(() => {
    if (selectedKey && index < 0) setSelectedKey(null);
  }, [selectedKey, index]);

  const move = (to: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, to));
    const r = rows[i];
    if (!r) return;
    setSelectedKey(r.key);
    setScrollTo({ index: i, n: Date.now() });
  };

  const setup = useSetup();
  const setupRef = useRef(setup);
  setupRef.current = setup;

  // A copied item has its own page in "Your setup": switch tab and open it there.
  const openItem = useCallback((row: Extract<LibraryRow, { type: "item" }>) => {
    const id = toolkitIdFor(setupRef.current.snapshot?.items ?? [], row.row.path);
    if (!id) {
      pushToast({ message: `Atlas has not found ${row.row.name} in your setup yet. Try again in a moment.` });
      return;
    }
    openToolkitItemNext(id);
    openToolkitTabNext("setup");
  }, []);

  const openRow = useCallback(
    (row: LibraryRow, focusInstall = false) => {
      setSelectedKey(row.key);
      if (row.type === "plugin") setSheet({ pluginId: row.entry.pluginId, name: row.entry.name, entry: row.entry, focusInstall });
      else if (row.type === "installedPlugin") setSheet({ pluginId: row.row.id, name: row.row.name, entry: null });
      else openItem(row);
    },
    [openItem],
  );

  const actions: RowActions = useMemo(
    () => ({
      open: openRow,
      quickInstall: (row) => {
        const d = storedCheck(row.entry.pluginId);
        if (d) void installPlugin(row.entry.pluginId, row.entry.name, d.token).then((out) => out === null && openRow(row, true));
        else openRow(row, true);
      },
      openItem,
    }),
    [openRow, openItem],
  );

  // Ctrl/Cmd+F or "/" searches here. Plain keys in a text field are left alone.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return;
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") || (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onKeyDown = (e: KeyboardEvent) => {
    if (!root.current?.contains(e.target as Node)) return; // a sheet or dialog above is not this list
    if (e.key === "ArrowDown" && (e.target === search.current || index >= 0)) {
      e.preventDefault();
      move(index < 0 ? 0 : index + 1);
    } else if (e.key === "ArrowUp" && (e.target === search.current || index >= 0)) {
      e.preventDefault();
      move(index <= 0 ? 0 : index - 1);
    } else if (e.key === "Enter" && e.target === search.current && index >= 0) {
      e.preventDefault();
      openRow(rows[index]!);
    } else if (e.key === "Escape" && e.target === search.current && lib.query) {
      e.preventDefault();
      setQuery("");
    }
  };

  const loading = lib.status !== "ready";
  const noCatalog = !loading && (lib.view?.entries.length ?? 0) === 0;
  const updated = lib.refreshing ? "Updating..." : updatedWords(lib.view?.fetchedMs ?? null, now);

  let body;
  if (loading) {
    body = <div role="status" aria-label="Loading the Library" className="skeleton min-h-0 flex-1 rounded-card" />;
  } else if (noCatalog && lib.source !== "installed") {
    body = lib.refreshing ? (
      <div role="status" aria-label="Loading the plugin catalog" className="skeleton min-h-0 flex-1 rounded-card" />
    ) : (
      <EmptyState
        fill
        icon={Package}
        title="The plugin catalog is not here yet"
        body={lib.error ?? OFFLINE}
        seed={4}
      >
        <Button variant="primary" onClick={() => void refreshLibrary()}>
          Refresh
        </Button>
      </EmptyState>
    );
  } else if (rows.length === 0) {
    body = (
      <EmptyState
        fill
        icon={lib.source === "installed" && !lib.query ? Package : MagnifyingGlass}
        title={lib.source === "installed" && !lib.query ? "Nothing installed yet" : lib.query ? `Nothing matches ${lib.query}` : "Nothing here yet"}
        body={lib.source === "installed" && !lib.query ? "Plugins and skills you add from the Library show up here." : "Try fewer words, or pick All on the left."}
        seed={7}
      />
    );
  } else {
    body = (
      <LibraryList rows={rows} selectedKey={selectedKey} cli={cli} busy={lib.busy} actions={actions} scrollTo={scrollTo} onFirstRows={reportFirstRows} />
    );
  }

  return (
    <div ref={root} onKeyDown={onKeyDown} className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex h-9 shrink-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <MagnifyingGlass size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2" />
          <input
            ref={search}
            type="text"
            role="searchbox"
            aria-label="Search plugins and skills"
            placeholder="Search plugins and skills"
            value={lib.query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
            className="selectable h-9 w-full rounded-control border border-line-strong bg-surface pl-9 pr-9 text-body text-ink outline-none placeholder:text-ink-2 focus-visible:border-accent"
          />
          {lib.query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                search.current?.focus();
              }}
              className="press absolute right-1.5 top-1/2 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
        {!wide && <SelectField label="Source" value={lib.source} onChange={setSource} options={options.map((o) => ({ value: o.id, label: `${o.label} (${o.count.toLocaleString()})` }))} />}
        <Button onClick={() => setAdding(true)}>
          <GithubLogo size={16} aria-hidden="true" className="ico" />
          Add from GitHub
        </Button>
        <IconButton aria-label="Refresh the plugin catalog" title={`Refresh the plugin catalog. ${updated}`} disabled={lib.refreshing} onClick={() => void refreshLibrary()}>
          <ArrowsClockwise size={16} aria-hidden="true" />
        </IconButton>
        <span role="status" className="hidden w-[132px] shrink-0 truncate text-caption text-ink-2 min-[1100px]:block">
          {updated}
        </span>
      </div>

      {(!cli || lib.view?.sandbox) && !loading && (
        <p role="note" className="shrink-0 text-caption text-ink-2">
          {!cli && `${NO_CLI} Adding skills and agents from a GitHub link still works.`}
          {!cli && lib.view?.sandbox ? " " : ""}
          {lib.view?.sandbox && "Sandbox Mode is on: installs go to the copy, not your real folder."}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {wide && <SourceRail options={options} value={lib.source} onChange={setSource} onAdd={() => setAdding(true)} />}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">{body}</div>
      </div>

      {sheet && <LibrarySheet key={sheet.pluginId} target={sheet} onClose={() => setSheet(null)} />}
      {adding && <AddFromGitHub onClose={() => setAdding(false)} />}
    </div>
  );
}
