import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ComponentType } from "react";
import {
  Anchor,
  BracketsCurly,
  Browser,
  CheckCircle,
  Cloud,
  Database,
  Eyeglasses,
  FileText,
  GitBranch,
  Hammer,
  type IconProps,
  Lightning,
  LockKey,
  Package,
  Palette,
  Repeat,
  Robot,
  TerminalWindow,
  TextAa,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Button, IconButton, Toggle } from "../controls";
import { IconMotion, type Motion } from "../IconMotion";
import { Chip, KindTile } from "../setup/parts";
import { badge } from "../../lib/tagWords";
import { AgentAvatar } from "../usage/helperKit";
import { KIND_BY_ID } from "../../lib/setup-model";
import {
  DIRECTORY,
  HEAD_H,
  INSTALLED_HEAD,
  NO_CLI,
  ROW_H,
  TOPIC_WORD,
  entryTopic,
  installBlock,
  itemWord,
  sourceCaption,
  tokens,
  type LibraryRow,
  type ListHead,
  type Topic,
} from "../../lib/library";
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

/** The picture for what a plugin is about. What Claude Code calls a thing keeps its Toolkit icon. */
const TOPIC_ICON: Record<Topic, { Icon: ComponentType<IconProps>; motion: Motion }> = {
  style: { Icon: TextAa, motion: "wiggle" },
  language: { Icon: BracketsCurly, motion: "pop" },
  hooks: { Icon: Anchor, motion: "swing" },
  agents: { Icon: Robot, motion: "bob" },
  commands: { Icon: TerminalWindow, motion: "nudge" },
  skills: { Icon: Lightning, motion: "zap" },
  design: { Icon: Palette, motion: "tilt" },
  review: { Icon: Eyeglasses, motion: "bob" },
  documents: { Icon: FileText, motion: "nudge" },
  security: { Icon: LockKey, motion: "pop" },
  cloud: { Icon: Cloud, motion: "bob" },
  data: { Icon: Database, motion: "pop" },
  web: { Icon: Browser, motion: "nudge" },
  git: { Icon: GitBranch, motion: "tilt" },
  loop: { Icon: Repeat, motion: "spin" },
  build: { Icon: Hammer, motion: "swing" },
  plugin: { Icon: Package, motion: "tilt" },
};

const MARK = {
  on: { Icon: CheckCircle, tone: "text-success", weight: "fill" },
  off: { Icon: CheckCircle, tone: "text-ink-2", weight: "bold" },
  changed: { Icon: WarningCircle, tone: "text-warning", weight: "fill" },
} as const;

/**
 * A row's picture says two things, each in its own way. The glyph is what the plugin is about,
 * read from its own words (`entryTopic`). Whether it is yours is the tile and its corner mark: a
 * plugin on the shelf sits on a quiet tile; an installed one wears the Toolkit's clay tile with a
 * check (green: on, grey outline: switched off) or an amber warning (changed since it was
 * checked). Shape and colour together, never colour alone. The highlighted row is a different
 * thing again: the whole row tints and grows a bar.
 */
export function PluginTile({ topic, state, size = 32 }: { topic: Topic; state: TileState; size?: number }) {
  const { Icon, motion } = TOPIC_ICON[topic];
  const mark = state === "none" ? null : MARK[state];
  return (
    <span
      data-tile-topic={topic}
      data-tile-state={state}
      title={TOPIC_WORD[topic]}
      style={{ width: size, height: size }}
      className={`lib-tile relative flex shrink-0 items-center justify-center ${state === "none" || state === "off" ? "" : "lib-tile-own"}`}
    >
      <IconMotion motion={motion} size={Math.round(size * 0.56)}>
        <Icon />
      </IconMotion>
      {mark && (
        <span aria-hidden="true" className={`lib-mark ${mark.tone}`}>
          <mark.Icon size={16} weight={mark.weight} />
        </span>
      )}
    </span>
  );
}
/** Room a row keeps on the right while it asks "Uninstall name?": the two buttons. */
const CONFIRM_ROOM = "pr-[204px]";

const NO_WORDS: string[] = [];

/**
 * The typed words, marked where they sit in a row's text, the way a Sessions row marks its hits
 * (the same `sl-hit`: heavier and underlined, no colour of its own). `words` are `tokens()` of the
 * query, so they are lower case with no punctuation; the earliest match wins at each step.
 */
export function marked(text: string, words: string[]): React.ReactNode {
  if (words.length === 0 || !text) return text;
  const lower = text.toLowerCase();
  // A case fold that changes the length (rare letters) would put the marks in the wrong place.
  if (lower.length !== text.length) return text;
  const out: React.ReactNode[] = [];
  let i = 0;
  for (;;) {
    let at = -1;
    let len = 0;
    for (const w of words) {
      const k = lower.indexOf(w, i);
      if (k >= 0 && (at < 0 || k < at)) {
        at = k;
        len = w.length;
      }
    }
    if (at < 0) break;
    if (at > i) out.push(text.slice(i, at));
    out.push(
      <mark key={at} className="sl-hit">
        {text.slice(at, at + len)}
      </mark>,
    );
    i = at + len;
  }
  if (out.length === 0) return text;
  if (i < text.length) out.push(text.slice(i));
  return out;
}

export interface RowActions {
  /** Open the detail sheet for this row (focusInstall: put focus on its Install). */
  open: (row: LibraryRow, focusInstall?: boolean) => void;
  /** Install now, from the row (the check is done and clean). */
  quickInstall: (row: Extract<LibraryRow, { type: "plugin" }>) => void;
  /** Open the Toolkit on a Library-copied item. */
  openItem: (row: Extract<LibraryRow, { type: "item" }>) => void;
}

/**
 * The two answers to "Uninstall name?". The question itself is the row's own first line (see Row),
 * so it is there at every width. Keep holds the keyboard first; Escape is Keep.
 */
function Confirm({ words, yes, onYes, onNo, busy }: { words: string; yes: string; onYes: () => void; onNo: () => void; busy: boolean }) {
  return (
    <div
      role="group"
      aria-label={words}
      className="flex items-center gap-2"
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onNo();
      }}
    >
      <Button autoFocus onClick={onNo}>
        Keep
      </Button>
      <Button variant="danger-solid" disabled={busy} onClick={onYes}>
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
  words = NO_WORDS,
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
  /** The typed words (lower case), marked where they sit in the name and the line under it. */
  words?: string[];
}) {
  const [confirm, setConfirm] = useState(false);
  // A row that is uninstalled (or installed again) is a different row: its confirm does not carry over.
  const installedNow = row.type === "plugin" ? row.installed !== null : true;
  useEffect(() => setConfirm(false), [row.key, installedNow]);
  // "Keep" hands the keyboard back to the row it came from, not to the top of the page.
  const host = useRef<HTMLDivElement>(null);
  const keep = () => {
    setConfirm(false);
    host.current?.querySelector<HTMLElement>("[data-row]")?.focus();
  };

  let name = "";
  let second = "";
  let source = "";
  let version = "";
  let kind: ItemKind | "more" | null = null;
  let state: TileState = "none";
  let topic: Topic = "plugin";
  let ask = "";
  let right: React.ReactNode = null;
  let reason: string | null = null;
  // The word "Installed" is on the row only where nothing above it says so already.
  // A chip is words, not a control: a click on it goes through to the row underneath.
  const said = underInstalled ? null : (
    <span className="pointer-events-none! flex min-w-0">
      <Chip tone="good" title={badge("installed").tip}>
        {badge("installed").label}
      </Chip>
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
    topic = entryTopic(entry);
    ask = `Uninstall ${name}?`;
    const isBusy = busy[entry.pluginId];
    if (installed) {
      right = confirm ? (
        <Confirm words={`Uninstall ${name}?`} yes={isBusy === "removing" ? "Removing..." : "Uninstall"} busy={!!isBusy} onNo={keep} onYes={() => void uninstallPlugin(entry.pluginId, name)} />
      ) : (
        <>
          {installed.changed && (
            <span className="pointer-events-none! flex min-w-0">
              <Chip tone="warn" title={badge("changedSince").tip}>
                {badge("changedSince").label}
              </Chip>
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
      // Ten outlined buttons in a column say nothing: Install is a quiet word until its row is
      // pointed at, highlighted or holds the keyboard (library.css). While it works it stays drawn.
      right = (
        <Button
          className={isBusy ? "" : "lib-install"}
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
    topic = entryTopic({ name });
    ask = `Uninstall ${name}?`;
    const isBusy = busy[r.id];
    right = confirm ? (
      <Confirm words={`Uninstall ${name}?`} yes={isBusy === "removing" ? "Removing..." : "Uninstall"} busy={!!isBusy} onNo={keep} onYes={() => void uninstallPlugin(r.id, name)} />
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
    ask = `Remove ${name}?`;
    const isBusy = busy[row.key];
    right = confirm ? (
      <Confirm words={`Remove ${name}?`} yes={isBusy ? "Removing..." : "Remove"} busy={!!isBusy} onNo={keep} onYes={() => void removeItem(r)} />
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
      ref={host}
      role="listitem"
      style={{ top: y, height: ROW_H }}
      className={`hover-host absolute inset-x-0 border-b border-line ${confirm ? "lib-ask" : selected ? "lib-sel" : ""}`}
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
          <PluginTile topic={topic} state={state} />
        )}
        {/* Long names: one line, cut with "...", the whole text on hover. While the row asks
            "Uninstall name?", the question is this line: it is there at every width. */}
        <span className="min-w-0 flex-1">
          <span data-row-title title={confirm ? ask : about} className="block truncate text-body font-semibold text-ink">
            {confirm ? ask : marked(name, words)}
          </span>
          <span title={second2} className={`block truncate text-caption ${own ? "text-warning" : "text-ink-2"}`}>
            {own ? second2 : marked(second2, words)}
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
          {/* Install is a quiet word at rest, so its stand-in is a short bar, not a button block. */}
          <span className="skeleton mr-3.5 h-2.5 w-10 shrink-0 rounded-control" />
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
  query = "",
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
  /** What was typed: its words are marked in each row, as Sessions and the palette mark theirs. */
  query?: string;
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
  const words = useMemo(() => tokens(query), [query]);

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
      // The box is as tall as its rows and no taller (flex-initial): a filter that leaves three
      // rows gets a three-row card, not a card with 400 px of nothing under it. A long list still
      // shrinks to the pane and scrolls inside itself.
      className="@container min-h-0 flex-initial overflow-y-auto overflow-x-hidden rounded-card border border-line bg-surface"
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
            words={words}
          />
        ))}
      </div>
    </div>
  );
}
