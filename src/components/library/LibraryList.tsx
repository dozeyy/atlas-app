import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Package, WarningCircle, X } from "@phosphor-icons/react";
import { Button, IconButton, Toggle } from "../controls";
import { Chip, KindTile } from "../setup/parts";
import { AgentAvatar } from "../usage/helperKit";
import { KIND_BY_ID } from "../../lib/setup-model";
import { DIRECTORY, HEAD_H, INSTALLED_HEAD, NO_CLI, ROW_H, installBlock, itemWord, sourceCaption, type LibraryRow, type ListHead } from "../../lib/library";
import type { InstalledRow, ItemKind } from "../../lib/libraryTypes";
import { removeItem, setPluginEnabled, uninstallPlugin, type LibraryState } from "../../state/libraryStore";

const OVERSCAN = 6;
const NO_HEADS: ListHead[] = [];

export type TileState = "none" | "on" | "off" | "changed";

export function tileState(installed: InstalledRow | null | undefined): TileState {
  if (!installed) return "none";
  if (installed.changed) return "changed";
  return installed.enabled === false ? "off" : "on";
}

const TILE = {
  none: { Icon: Package, tone: "bg-raised text-ink-2", weight: "regular" },
  on: { Icon: CheckCircle, tone: "bg-success-tint text-success", weight: "fill" },
  off: { Icon: CheckCircle, tone: "bg-raised text-ink-2", weight: "regular" },
  changed: { Icon: WarningCircle, tone: "bg-warning-tint text-warning", weight: "fill" },
} as const;

/**
 * A plugin's tile says the one thing the list knows about it: not here yet (quiet, so the name
 * leads), installed and on, installed and switched off, or changed since it was checked. Shape and
 * colour together, never colour alone.
 */
export function PluginTile({ state, size = 32 }: { state: TileState; size?: number }) {
  const { Icon, tone, weight } = TILE[state];
  return (
    <span aria-hidden="true" style={{ width: size, height: size }} className={`flex shrink-0 items-center justify-center rounded-control ${tone}`}>
      <Icon size={Math.round(size * 0.56)} weight={weight} />
    </span>
  );
}
/**
 * Room a row keeps on the right while it asks "Uninstall name?": the two buttons, and from a
 * 700 px list up the question too (at most 220 px, see Confirm).
 */
const CONFIRM_ROOM = "pr-[204px] @min-[700px]:pr-[432px]";

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
      {/* One line, never wider than the room the row keeps for it (CONFIRM_ROOM below). */}
      <span title={words} className="hidden max-w-[220px] truncate text-body text-ink @min-[700px]:block">
        {words}
      </span>
      <Button onClick={onNo}>Keep</Button>
      <Button variant="danger" disabled={busy} onClick={onYes}>
        {yes}
      </Button>
    </div>
  );
}

function Row({
  row,
  y,
  selected,
  cli,
  busy,
  actions,
  showSource,
  underInstalled,
}: {
  row: LibraryRow;
  y: number;
  selected: boolean;
  cli: boolean;
  busy: LibraryState["busy"];
  actions: RowActions;
  /** Sources are mixed here and nothing above says which: a row from outside the directory names its own. */
  showSource: boolean;
  /** The heading above (or the filter) already says "Installed". */
  underInstalled: boolean;
}) {
  const [confirm, setConfirm] = useState(false);
  // A row that is uninstalled (or installed again) is a different row: its confirm does not carry over.
  const installedNow = row.type === "plugin" ? row.installed !== null : true;
  useEffect(() => setConfirm(false), [row.key, installedNow]);

  let name = "";
  let second = "";
  let source = "";
  let version = "";
  let kind: ItemKind | "more" | null = null;
  let state: TileState = "none";
  let right: React.ReactNode = null;
  let reason: string | null = null;
  // The word "Installed" is on the row only where nothing above it says so already.
  // A chip is words, not a control: a click on it goes through to the row underneath.
  const said = underInstalled ? null : (
    <span className="pointer-events-none! flex min-w-0">
      <Chip tone="good">Installed</Chip>
    </span>
  );

  if (row.type === "plugin") {
    const { entry, installed } = row;
    name = entry.name;
    second = entry.description;
    // Most plugins come from the directory: saying so on every row says nothing.
    source = entry.marketplace === DIRECTORY ? "" : sourceCaption(entry.marketplace);
    version = entry.version;
    state = tileState(installed);
    const isBusy = busy[entry.pluginId];
    if (installed) {
      right = confirm ? (
        <Confirm words={`Uninstall ${name}?`} yes={isBusy === "removing" ? "Removing..." : "Uninstall"} busy={!!isBusy} onNo={() => setConfirm(false)} onYes={() => void uninstallPlugin(entry.pluginId, name)} />
      ) : (
        <>
          {installed.changed && (
            <span className="pointer-events-none! flex min-w-0">
              <Chip tone="warn">Changed since you checked it</Chip>
            </span>
          )}
          {installed.changed ? <Button onClick={() => actions.open(row)}>Check again</Button> : said}
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
    state = tileState(r);
    const isBusy = busy[r.id];
    right = confirm ? (
      <Confirm words={`Uninstall ${name}?`} yes={isBusy === "removing" ? "Removing..." : "Uninstall"} busy={!!isBusy} onNo={() => setConfirm(false)} onYes={() => void uninstallPlugin(r.id, name)} />
    ) : (
      <>
        {said}
        <Toggle checked={r.enabled !== false} label={`${name} is on`} onChange={(on) => void setPluginEnabled(r.id, on)} />
        <IconButton aria-label={`Uninstall ${name}`} title="Uninstall" onClick={() => setConfirm(true)}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </>
    );
  } else {
    const r = row.row;
    name = r.name;
    // The second line already names the repository: no source column for a copied item.
    second = `${itemWord(r.itemKind)} copied from ${r.repo || "GitHub"}`;
    kind = (r.itemKind in KIND_BY_ID ? r.itemKind : "more") as ItemKind | "more";
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
  const changed = row.type === "plugin" && !!row.installed?.changed;
  const reserve = row.type === "item" ? 230 : row.type === "plugin" && !row.installed ? 108 : changed ? 400 : underInstalled ? 112 : 190;
  // Widths here are the list's own (it is the container), not the window's: an open sidebar or
  // the source rail narrows the list, and the row follows. The source gives way first, sooner on
  // a row that carries the "Changed" chip and its button.
  const sourceFrom = confirm || !source || !showSource ? "" : changed ? "@min-[860px]:block" : "@min-[620px]:block";
  // What the row no longer spells out stays one hover away, with the name.
  const about = [name, version ? `Version ${version}` : "", row.type === "plugin" ? `From ${sourceCaption(row.entry.marketplace)}` : ""].filter(Boolean).join("\n");
  // A reason that is this row's own takes the second line. The one every row shares (no Claude
  // Code command) is said once, above the list; the row keeps its description and the greyed
  // Install button carries the reason as its tooltip.
  const own = reason === NO_CLI ? null : reason;
  const second2 = own ?? second;

  return (
    <div
      role="listitem"
      style={{ top: y, height: ROW_H }}
      className={`hover-host absolute inset-x-0 border-b border-line ${selected ? "lib-sel" : ""}`}
    >
      <button
        type="button"
        data-row={row.key}
        aria-label={`${name}. ${second2}${state === "none" ? "" : state === "changed" ? ". Installed, changed since you checked it" : state === "off" ? ". Installed, switched off" : ". Installed"}`}
        onClick={() => actions.open(row)}
        className={`row-btn h-full items-center gap-3 pl-3 ${confirm ? CONFIRM_ROOM : ""}`}
        style={confirm ? undefined : { paddingRight: reserve }}
      >
        {/* A copied agent wears the avatar it has in the Toolkit and on Team (helperKit). */}
        {kind === "agent" ? (
          <AgentAvatar type={name} size={32} quiet />
        ) : kind ? (
          <KindTile kind={kind} icon={kind === "more" ? Package : undefined} size={32} />
        ) : (
          <PluginTile state={state} />
        )}
        {/* Long names: one line, cut with "...", the whole text on hover. */}
        <span className="min-w-0 flex-1">
          <span title={about} className="block truncate text-body font-semibold text-ink">
            {name}
          </span>
          <span title={second2} className={`block truncate text-caption ${own ? "text-warning" : "text-ink-2"}`}>
            {second2}
          </span>
        </span>
        <span title={source} className={`hidden max-w-[168px] shrink-0 truncate text-right text-caption text-ink-2 ${sourceFrom}`}>
          {source}
        </span>
      </button>
      {/* Only the controls take the pointer: the gaps and the chips between them still open the row. */}
      <div className="pointer-events-none absolute right-3 top-1/2 flex -translate-y-1/2 items-center gap-2 [&>*]:pointer-events-auto">{right}</div>
    </div>
  );
}

/** The list while it loads: the same box and the same rows (tile, two lines, button), so nothing shifts when the plugins land. */
export function ListSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="min-h-0 flex-1 overflow-hidden rounded-card border border-line bg-surface">
      {Array.from({ length: 14 }, (_, i) => (
        <div key={i} aria-hidden="true" style={{ height: ROW_H }} className="flex items-center gap-3 border-b border-line px-3">
          <span className="size-8 shrink-0 rounded-control bg-raised" />
          <span className="min-w-0 flex-1">
            <span className="skeleton block h-3 rounded-control" style={{ width: `${24 + ((i * 17) % 28)}%` }} />
            <span className="skeleton mt-2 block h-2.5 rounded-control" style={{ width: `${44 + ((i * 23) % 36)}%` }} />
          </span>
          <span className="skeleton h-8 w-[66px] shrink-0 rounded-control" />
        </div>
      ))}
    </div>
  );
}

/**
 * The windowed list: only the rows in view (and a few either side) are in the document, so
 * 3,600 plugins scroll and filter as fast as 30.
 */
export function LibraryList({
  rows,
  heads = NO_HEADS,
  showSource = false,
  installedOnly = false,
  selectedKey,
  cli,
  busy,
  actions,
  scrollTo,
  onFirstRows,
}: {
  rows: LibraryRow[];
  /** Headings over runs of rows (All, nothing typed). */
  heads?: ListHead[];
  showSource?: boolean;
  /** The Installed filter: every row is installed, and the rail says so. */
  installedOnly?: boolean;
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

  // Where each row sits: its own slot, pushed down by every heading at or above it. `headOf[i]`
  // is the heading row i sits under (-1: none).
  const { yOf, headOf, total } = useMemo(() => {
    const yOf = new Float64Array(rows.length);
    const headOf = new Int32Array(rows.length);
    let h = -1;
    for (let i = 0; i < rows.length; i++) {
      while (h + 1 < heads.length && heads[h + 1]!.at <= i) h++;
      headOf[i] = h;
      yOf[i] = i * ROW_H + (h + 1) * HEAD_H;
    }
    return { yOf, headOf, total: rows.length * ROW_H + heads.length * HEAD_H };
  }, [rows, heads]);

  useEffect(() => {
    const el = box.current;
    if (!el || !scrollTo || scrollTo.index >= yOf.length) return;
    // The first row under a heading brings its heading into view with it.
    const lead = heads.some((x) => x.at === scrollTo.index) ? HEAD_H : 0;
    const y = yOf[scrollTo.index]!;
    if (y - lead < el.scrollTop) el.scrollTop = y - lead;
    else if (y + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW_H - el.clientHeight;
  }, [scrollTo, yOf, heads]);

  // Headings only push rows down, so these bounds never miss a row in view.
  const from = Math.max(0, Math.floor((top - heads.length * HEAD_H) / ROW_H) - OVERSCAN);
  const to = Math.min(rows.length, Math.ceil((top + height) / ROW_H) + OVERSCAN);

  return (
    <div
      ref={box}
      onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      className="@container min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-card border border-line bg-surface"
    >
      <div role="list" aria-label="Plugins and skills" style={{ height: total }} className="relative">
        {heads.map((head) => (
          <div
            key={head.label}
            role="presentation"
            data-head={head.label}
            style={{ top: (yOf[head.at] ?? 0) - HEAD_H, height: HEAD_H }}
            className="absolute inset-x-0 flex items-end border-b border-line px-3 pb-1.5"
          >
            <span title={head.label} className="min-w-0 truncate text-caption font-semibold text-ink-2">
              {head.label}
            </span>
          </div>
        ))}
        {rows.slice(from, to).map((row, i) => (
          <Row
            key={row.key}
            row={row}
            y={yOf[from + i]!}
            selected={row.key === selectedKey}
            cli={cli}
            busy={busy}
            actions={actions}
            showSource={showSource}
            underInstalled={installedOnly || heads[headOf[from + i]!]?.label === INSTALLED_HEAD}
          />
        ))}
      </div>
    </div>
  );
}
