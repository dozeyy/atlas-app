import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Package, X } from "@phosphor-icons/react";
import { Button, IconButton, Toggle } from "../controls";
import { Chip, KindTile } from "../setup/parts";
import { KIND_BY_ID } from "../../lib/setup-model";
import { ROW_H, installBlock, itemWord, sourceCaption, type LibraryRow } from "../../lib/library";
import type { ItemKind } from "../../lib/libraryTypes";
import { removeItem, setPluginEnabled, uninstallPlugin, type LibraryState } from "../../state/libraryStore";

const OVERSCAN = 6;

export interface RowActions {
  /** Open the detail sheet for this row (focusInstall: put focus on its Install). */
  open: (row: LibraryRow, focusInstall?: boolean) => void;
  /** Install now, from the row (the check is done and clean). */
  quickInstall: (row: Extract<LibraryRow, { type: "plugin" }>) => void;
  /** Open the Toolkit on a Library-copied item. */
  openItem: (row: Extract<LibraryRow, { type: "item" }>) => void;
}

function Confirm({ words, yes, onYes, onNo, busy }: { words: string; yes: string; onYes: () => void; onNo: () => void; busy: boolean }) {
  return (
    <div role="group" aria-label={words} className="flex items-center gap-2">
      <span className="hidden text-body text-ink min-[900px]:inline">{words}</span>
      <Button onClick={onNo}>Keep</Button>
      <Button variant="danger" disabled={busy} onClick={onYes}>
        {yes}
      </Button>
    </div>
  );
}

function Row({
  row,
  index,
  selected,
  cli,
  busy,
  actions,
}: {
  row: LibraryRow;
  index: number;
  selected: boolean;
  cli: boolean;
  busy: LibraryState["busy"];
  actions: RowActions;
}) {
  const [confirm, setConfirm] = useState(false);
  // A row that is uninstalled (or installed again) is a different row: its confirm does not carry over.
  const installedNow = row.type === "plugin" ? row.installed !== null : true;
  useEffect(() => setConfirm(false), [row.key, installedNow]);

  let name = "";
  let second = "";
  let source = "";
  let version = "";
  let tile: ItemKind | "more" = "more";
  let right: React.ReactNode = null;
  let reason: string | null = null;

  if (row.type === "plugin") {
    const { entry, installed } = row;
    name = entry.name;
    second = entry.description;
    source = sourceCaption(entry.marketplace);
    version = entry.version;
    const isBusy = busy[entry.pluginId];
    if (installed) {
      right = confirm ? (
        <Confirm words={`Uninstall ${name}?`} yes={isBusy === "removing" ? "Removing..." : "Uninstall"} busy={!!isBusy} onNo={() => setConfirm(false)} onYes={() => void uninstallPlugin(entry.pluginId, name)} />
      ) : (
        <>
          {installed.changed && <Chip tone="warn">Changed since you checked it</Chip>}
          {installed.changed ? (
            <Button onClick={() => actions.open(row)}>Check again</Button>
          ) : (
            <Chip tone="good">Installed</Chip>
          )}
          <Toggle
            checked={installed.enabled !== false}
            label={`${name} is on`}
            onChange={(on) => void setPluginEnabled(entry.pluginId, on)}
          />
          <IconButton aria-label={`Uninstall ${name}`} title="Uninstall" onClick={() => setConfirm(true)}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </>
      );
    } else {
      reason = installBlock(entry, cli);
      right = (
        <Button
          disabled={!!reason || !!isBusy}
          title={reason ?? undefined}
          aria-label={`Install ${name}`}
          onClick={() => actions.quickInstall(row)}
        >
          {isBusy === "installing" ? "Installing..." : isBusy === "checking" ? "Checking..." : "Install"}
        </Button>
      );
    }
  } else if (row.type === "installedPlugin") {
    const r = row.row;
    name = r.name;
    second = "Installed with Claude Code";
    source = r.repo || "";
    version = r.version ?? "";
    const isBusy = busy[r.id];
    right = confirm ? (
      <Confirm words={`Uninstall ${name}?`} yes={isBusy === "removing" ? "Removing..." : "Uninstall"} busy={!!isBusy} onNo={() => setConfirm(false)} onYes={() => void uninstallPlugin(r.id, name)} />
    ) : (
      <>
        <Chip tone="good">Installed</Chip>
        <Toggle checked={r.enabled !== false} label={`${name} is on`} onChange={(on) => void setPluginEnabled(r.id, on)} />
        <IconButton aria-label={`Uninstall ${name}`} title="Uninstall" onClick={() => setConfirm(true)}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </>
    );
  } else {
    const r = row.row;
    name = r.name;
    second = `${itemWord(r.itemKind)} copied from ${r.repo || "GitHub"}`;
    source = r.repo;
    tile = (r.itemKind in KIND_BY_ID ? r.itemKind : "more") as ItemKind | "more";
    const isBusy = busy[row.key];
    right = confirm ? (
      <Confirm words={`Remove ${name}?`} yes={isBusy ? "Removing..." : "Remove"} busy={!!isBusy} onNo={() => setConfirm(false)} onYes={() => void removeItem(r)} />
    ) : (
      <>
        <Button onClick={() => actions.openItem(row)}>Open in Toolkit</Button>
        <IconButton aria-label={`Remove ${name}`} title="Remove" onClick={() => setConfirm(true)}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </>
    );
  }

  // Room the buttons on the right need, so the text never runs under them.
  const reserve = row.type === "item" ? 230 : row.type === "plugin" && !row.installed ? 108 : row.type === "plugin" && row.installed?.changed ? 400 : 190;

  return (
    <div
      role="listitem"
      style={{ top: index * ROW_H, height: ROW_H }}
      className={`hover-host absolute inset-x-0 border-b border-line ${selected ? "lib-sel" : ""}`}
    >
      <button
        type="button"
        data-row={row.key}
        aria-label={`${name}. ${reason ?? second}`}
        onClick={() => actions.open(row)}
        className="row-btn h-full items-center gap-3 pl-3"
        style={{ paddingRight: confirm ? 300 : reserve }}
      >
        <KindTile kind={tile} icon={tile === "more" ? Package : undefined} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-semibold text-ink">{name}</span>
          <span className={`block truncate text-caption ${reason ? "text-warning" : "text-ink-2"}`}>{reason ?? second}</span>
        </span>
        <span className={`hidden w-[132px] shrink-0 text-right ${confirm ? "" : "min-[760px]:block"}`}>
          <span className="block truncate text-caption text-ink-2">{source}</span>
          {version && <span className="mono block truncate text-caption text-ink-2">{version}</span>}
        </span>
      </button>
      <div className="absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2">{right}</div>
    </div>
  );
}

/**
 * The windowed list: only the rows in view (and a few either side) are in the document, so
 * 3,600 plugins scroll and filter as fast as 30.
 */
export function LibraryList({
  rows,
  selectedKey,
  cli,
  busy,
  actions,
  scrollTo,
  onFirstRows,
}: {
  rows: LibraryRow[];
  selectedKey: string | null;
  cli: boolean;
  busy: LibraryState["busy"];
  actions: RowActions;
  /** A row index to bring into view (keyboard moves). */
  scrollTo: { index: number; n: number } | null;
  onFirstRows: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(520);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || 520);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (rows.length) onFirstRows();
  }, [rows.length, onFirstRows]);

  // A new filter starts at the top.
  const first = rows[0]?.key;
  useEffect(() => {
    if (box.current) box.current.scrollTop = 0;
    setTop(0);
  }, [first]);

  useEffect(() => {
    const el = box.current;
    if (!el || !scrollTo) return;
    const y = scrollTo.index * ROW_H;
    if (y < el.scrollTop) el.scrollTop = y;
    else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
  }, [scrollTo]);

  const from = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
  const to = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);

  return (
    <div
      ref={box}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-card border border-line bg-surface"
    >
      <div role="list" aria-label="Plugins and skills" style={{ height: rows.length * ROW_H }} className="relative">
        {rows.slice(from, to).map((row, i) => (
          <Row
            key={row.key}
            row={row}
            index={from + i}
            selected={row.key === selectedKey}
            cli={cli}
            busy={busy}
            actions={actions}
          />
        ))}
      </div>
    </div>
  );
}
