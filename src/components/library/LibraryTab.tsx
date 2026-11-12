import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { ArrowsClockwise, ArrowsDownUp, GithubLogo, MagnifyingGlass, WarningCircle, X } from "@phosphor-icons/react";
import { Button, IconButton } from "../controls";
import { ChoiceList, OptionField, OptionsMenu } from "../OptionsMenu";
import { EmptyState } from "../EmptyState";
import { SelectField } from "../usage/fields";
import { AddFromGitHub } from "./AddFromGitHub";
import { LibraryList, ListSkeleton, type RowActions } from "./LibraryList";
import { LibrarySheet, type SheetTarget } from "./LibrarySheet";
import { SourceRail } from "./SourceRail";
import { NO_CLI, OFFICIAL_CATALOG, OFFLINE, buildList, changedCount, sourceOptions, toolkitIdFor, updatedWords, type LibraryOrder, type LibraryRow } from "../../lib/library";
import { openToolkitItemNext, openToolkitTabNext } from "../../lib/nav";
import { exact } from "../../lib/usage";
import { addOfficialCatalog, checkThenInstall, openLibrary, refreshLibrary, reportFirstRows, setOrder, setQuery, setSource, useLibrary } from "../../state/libraryStore";
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

const ORDERS: { value: LibraryOrder; label: string }[] = [
  { value: "popular", label: "Most installed" },
  { value: "catalog", label: "Catalog order" },
];

/**
 * True when the reason reads like the network: the sentence the catalog call gives for it, or the
 * words a failed lookup or connection leaves in Claude Code's own answer. Anything else (no
 * command, an empty answer, a refused write, a timeout of the command itself) is not offline.
 */
export function looksOffline(reason: string | null): boolean {
  if (!reason) return false;
  return reason === OFFLINE || /\b(ENOTFOUND|ECONNREFUSED|ECONNRESET|ENETUNREACH|EAI_AGAIN|getaddrinfo|offline|no internet|network (is )?(unreachable|error|request failed)|could not reach)\b/i.test(reason);
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
  // `lib.idx` is sorted once when the data loads or the choice changes; with no counts anywhere it is catalog order.
  // While only the first rows are here they are in popular order whatever was chosen; the choice
  // applies when the whole list lands (a moment).
  const order: LibraryOrder = lib.counted ? (lib.view?.partial ? "popular" : lib.order) : "catalog";
  const { rows, heads, showSource } = useMemo(() => buildList({ idx: lib.idx, installed: lib.installed, source: lib.source, query, order }), [lib.idx, lib.installed, lib.source, query, order]);
  const options = useMemo(
    () => sourceOptions(lib.view?.total ?? 0, lib.view?.counts ?? {}, lib.view?.marketplaces ?? [], lib.installed.length, changedCount(lib.idx, lib.installed)),
    [lib.view, lib.idx, lib.installed],
  );
  const cli = lib.view?.cli ?? true;

  const index = selectedKey ? rows.findIndex((r) => r.key === selectedKey) : -1;
  // The highlighted row follows the filter: when it is gone, nothing is highlighted.
  useEffect(() => {
    if (selectedKey && index < 0) setSelectedKey(null);
  }, [selectedKey, index]);
  // A row that moves (installing lifts it under "Installed", undoing sends it back) is followed:
  // the highlighted row stays in view instead of slipping out from under the pointer.
  const was = useRef<{ key: string | null; index: number }>({ key: null, index: -1 });
  useEffect(() => {
    const moved = was.current.key === selectedKey && was.current.index >= 0 && index >= 0 && was.current.index !== index;
    was.current = { key: selectedKey, index };
    if (moved) setScrollTo({ index, n: Date.now() });
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
        setSelectedKey(row.key);
        void checkThenInstall(row.entry.pluginId, row.entry.name).then((r) => r === "open" && openRow(row, true));
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
  const noCatalog = !loading && (lib.view?.total ?? 0) === 0;
  const catalogs = lib.view?.marketplaces ?? [];
  const hasOfficial = catalogs.some((m) => m.name === OFFICIAL_CATALOG);
  // Only the first rows are here yet: a filter that finds nothing waits for the rest instead of saying so.
  const partial = !!lib.view?.partial;
  const updated = lib.refreshing ? "Updating..." : updatedWords(lib.view?.fetchedMs ?? null, now);

  let body;
  if (loading) {
    body = <ListSkeleton label="Loading the Library" />;
  } else if (noCatalog && lib.source !== "installed") {
    body = lib.refreshing ? (
      <div role="status" aria-label="Loading the plugin catalog" className="relative min-h-0 flex-1">
        <div aria-hidden className="skeleton absolute inset-0 rounded-card" />
        <p className="absolute inset-0 flex items-center justify-center px-6 text-center text-body text-ink">
          Getting the plugin list from Claude Code. The first time takes a few seconds.
        </p>
      </div>
    ) : !lib.error && lib.view?.fetchedMs != null ? (
      // Claude Code answered, and there is nothing in the answer: a fresh install with no plugin
      // catalogs added yet. Not a failure; the one action adds the official catalog.
      <EmptyState
        fill
        title={catalogs.length === 0 ? "No plugin catalogs yet" : "No plugins listed yet"}
        body={
          catalogs.length === 0
            ? "Claude Code has no plugin catalogs added. Add the official one to browse plugins and skills."
            : hasOfficial
              ? "Claude Code lists no plugins from its catalogs right now. Press Refresh to ask again."
              : "Claude Code lists no plugins in its catalogs. Add the official one to browse plugins and skills."
        }
        seed={17}
      >
        {hasOfficial ? (
          // Already added: adding it again is not the way out, asking for the list again is.
          <Button variant="primary" onClick={() => void refreshLibrary()}>
            Refresh
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void addOfficialCatalog()} disabled={!cli}>
            Add the official catalog
          </Button>
        )}
      </EmptyState>
    ) : looksOffline(lib.error) ? (
      // The connection line is only said when the failure is one: the list comes from Claude
      // Code's own command, and most of the ways that can fail have nothing to do with the network.
      <EmptyState
        fill
        variant="error"
        title="Atlas could not reach the plugin catalog"
        body="Check your connection and press Refresh."
        reason={lib.error !== OFFLINE ? lib.error : null}
        action={{ label: "Refresh", onClick: () => void refreshLibrary() }}
      />
    ) : (
      // A calm error: what happened, the next step, the engine's own words behind Details. The
      // list comes from Claude Code's own command, so a failure that is not the network is its
      // answer (or no answer); the sentence says where that answer is, and never blames the connection.
      <EmptyState
        fill
        variant="error"
        title="The Library could not load"
        body="Claude Code did not give Atlas the plugin list. Refresh tries again; what it said is under Details."
        reason={lib.error}
        action={{ label: "Refresh", onClick: () => void refreshLibrary() }}
      />
    );
  } else if (rows.length === 0 && partial && lib.source !== "installed") {
    body = <ListSkeleton label="Searching the catalog" />;
  } else if (rows.length === 0) {
    const nothingInstalled = lib.source === "installed" && !lib.query;
    // What to do next, in words that fit what is on screen: the rail is only "on the left" when it is drawn.
    const wider = lib.source === "all" ? "" : wide ? ", or pick All on the left" : ", or pick All in the list of sources";
    body = lib.query ? (
      // The way out is offered right here, not back up in the search box.
      <EmptyState
        fill
        variant="no-match"
        query={lib.query}
        body={`Try fewer words${wider}.`}
        action={{
          onClick: () => {
            setQuery("");
            search.current?.focus();
          },
        }}
      />
    ) : (
      <EmptyState
        fill
        title={nothingInstalled ? "Nothing installed yet" : "Nothing here yet"}
        body={nothingInstalled ? "Plugins and skills you add from the Library show up here." : "This marketplace lists no plugins. Pick All to see the rest."}
        seed={31}
      />
    );
  } else {
    body = (
      <LibraryList
        rows={rows}
        heads={heads}
        showSource={showSource}
        installedOnly={lib.source === "installed"}
        query={query}
        selectedKey={selectedKey}
        cli={cli}
        busy={lib.busy}
        actions={actions}
        scrollTo={scrollTo}
        onFirstRows={reportFirstRows}
      />
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
        {lib.counted && (
          <OptionsMenu label="Sort" status={ORDERS.find((o) => o.value === lib.order)?.label} icon={<ArrowsDownUp size={18} aria-hidden="true" />} width={200}>
            {(close) => (
              <OptionField label="Order">
                <ChoiceList label="Sort order" value={lib.order} choices={ORDERS} onChange={setOrder} onPick={close} />
              </OptionField>
            )}
          </OptionsMenu>
        )}
        {!wide && <SelectField label="Source" value={lib.source} onChange={setSource} options={options.map((o) => ({ value: o.id, label: loading ? o.label : `${o.label} ${exact(o.count)}${o.flag ? `, ${o.flag.short}` : ""}` }))} />}
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

      {/* Said once, here, in the warning colour with its icon; the rows below keep their descriptions. */}
      {!cli && !loading && (
        <p role="note" className="flex shrink-0 items-start gap-2 rounded-control bg-warning-tint px-3 py-2 text-body text-warning">
          <WarningCircle size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-medium">{NO_CLI}</span> Adding skills and agents from a GitHub link still works.
          </span>
        </p>
      )}
      {lib.view?.sandbox && !loading && (
        <p role="note" className="shrink-0 text-caption text-ink-2">
          Sandbox Mode is on: installs go to the copy, not your real folder.
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-4">
        {wide && <SourceRail options={options} value={lib.source} counts={!loading} onChange={setSource} onAdd={() => setAdding(true)} />}
        {/* data-sheet-open: the highlighted row is drawn while its sheet is up (library.css). */}
        <div data-sheet-open={sheet ? "" : undefined} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {body}
        </div>
      </div>

      {sheet && <LibrarySheet key={sheet.pluginId} target={sheet} onClose={() => setSheet(null)} />}
      {adding && <AddFromGitHub onClose={() => setAdding(false)} />}
    </div>
  );
}
