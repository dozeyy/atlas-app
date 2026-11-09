import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChatsCircle, FolderSimple, MagnifyingGlass, Robot, Sparkle, TerminalWindow, type IconProps } from "@phosphor-icons/react";
import { NAV } from "./Sidebar";
import { useAtlas } from "../state/AtlasProvider";
import { closePalette, usePaletteOpen } from "../state/paletteStore";
import { guardLeave } from "../state/unsavedStore";
import { startSetup, useSetup } from "../state/setupStore";
import { getBackend } from "../lib/ipc";
import { modName } from "../lib/appMenu";
import { openProjectNext, openSessionNext, openToolkitItemNext } from "../lib/nav";
import { KIND_LABEL, clampIndex, matchRanges, pageItems, projectItem, rankItems, sessionItem, stepIndex, toolkitItems } from "../lib/palette";
import type { PaletteItem, PaletteKind } from "../lib/palette";
import { CHAT_SEARCH_MIN_CHARS, useChatSearch, useDebounced } from "../lib/useChatSearch";
import { usePaletteData } from "../lib/usePaletteData";
import type { SessionRow } from "../lib/types";

const KIND_ICON: Record<Exclude<PaletteKind, "page">, ComponentType<IconProps>> = {
  session: ChatsCircle,
  project: FolderSimple,
  skill: Sparkle,
  agent: Robot,
  command: TerminalWindow,
};

/** The most rows the list draws. More than this is a longer search, not a longer list. */
const SHOWN = 30;
/** Typed titles are asked of the engine this soon after the last key. */
const TITLE_ASK_MS = 80;

/** `text` with the typed words in bold. */
function Marked({ text, query }: { text: string; query: string }): ReactNode {
  const ranges = matchRanges(query, text);
  if (!ranges.length) return text;
  const out: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(
      <b key={i} className="qj-hit">
        {text.slice(a, b)}
      </b>,
    );
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Chats the engine finds for what is typed: by title, and by the words inside them. */
function useTypedChats(query: string, chatIds: string[]): SessionRow[] {
  const typed = query.trim();
  const q = useDebounced(typed, TITLE_ASK_MS);
  const [found, setFound] = useState<{ q: string; rows: SessionRow[] } | null>(null);
  const key = `${q}|${chatIds.join(",")}`;
  const on = [...q].length >= CHAT_SEARCH_MIN_CHARS;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    getBackend()
      .sessionsList({ text: q, alsoIds: chatIds, includeMissing: true, sort: "started", dir: "desc", limit: 20 })
      .then((p) => alive && setFound({ q, rows: p.rows }))
      .catch(() => alive && setFound({ q, rows: [] }));
    return () => {
      alive = false;
    };
    // `key` carries every input; chatIds is a new array on each answer.
  }, [key, on]);
  // An answer for an older word is not shown for the new one.
  return on && found?.q === q ? found.rows : NO_ROWS;
}
const NO_ROWS: SessionRow[] = [];

/**
 * The quick jump: Ctrl+K from anywhere. One field, one list; arrows move, Enter goes, Escape
 * closes. It opens with what is already in hand (pages, the chats it kept ready, the Toolkit the
 * app has already read) and fills in anything newer behind the field, so it never waits.
 */
export function CommandPalette() {
  const open = usePaletteOpen();
  // Gone with the app: a palette left open does not greet the next one.
  useEffect(() => closePalette, []);
  return open ? <Palette /> : null;
}

function Palette() {
  const { info, view, setView } = useAtlas();
  const mod = modName(info.platform);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();

  const data = usePaletteData();
  const setup = useSetup();
  const chat = useChatSearch(query);
  const typedRows = useTypedChats(query, chat.ids);

  // The Toolkit is read once at start; this only asks if that has not happened.
  useEffect(() => startSetup(), []);

  // Focus goes back to where it was when the palette closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    input.current?.focus({ preventScroll: true });
    return () => before?.focus?.({ preventScroll: true });
  }, []);

  const base = useMemo(() => {
    const now = new Date();
    return [
      ...pageItems(NAV, mod),
      ...data.sessions.map((r) => sessionItem(r, now)),
      ...data.projects.map(projectItem),
      ...toolkitItems(setup.snapshot?.items ?? []),
    ];
  }, [mod, data, setup.snapshot]);

  const items = useMemo(() => {
    if (!typedRows.length) return base;
    const now = new Date();
    const byId = new Map(base.map((i) => [i.id, i]));
    for (const r of typedRows) {
      const snippet = chat.snippets.get(r.sessionId);
      const made = sessionItem(r, now);
      const prior = byId.get(made.id);
      const found = snippet ? snippet.map((p) => p.text).join("").trim() : "";
      // A chat found by its words shows where they are; it is listed even if its title says nothing.
      // A snippet that only repeats the title adds nothing, so the project stays.
      byId.set(made.id, {
        ...(prior ?? made),
        sub: found && found.toLowerCase() !== (prior ?? made).title.toLowerCase() ? found : (prior ?? made).sub,
        forced: chat.ids.includes(r.sessionId) ? 9 : undefined,
      });
    }
    return [...byId.values()];
  }, [base, typedRows, chat.snippets, chat.ids]);

  const shown = useMemo(() => rankItems(items, query, SHOWN), [items, query]);
  const at = clampIndex(picked, shown.length);

  // A new query starts from the top.
  const type = (v: string) => {
    setQuery(v);
    setPicked(0);
  };

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" });
  }, [at, shown]);

  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    const t = item.target;
    closePalette();
    const jump = () => {
      if (t.session) openSessionNext(t.session);
      else if (t.project) openProjectNext(t.project);
      else if (t.toolkitItem) openToolkitItemNext(t.toolkitItem);
      setView(t.view);
    };
    // Leaving the current view with unsaved edits asks first, before anything is handed over.
    // (Staying on the Toolkit is asked by the Toolkit page itself, when it takes the item.)
    if (t.view !== view) guardLeave(jump);
    else jump();
  };

  const onKey = (e: KeyboardEvent) => {
    // Nothing typed here reaches a shortcut or a page behind.
    e.stopPropagation();
    const mk = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k";
    if (e.key === "Escape" || mk) {
      e.preventDefault();
      closePalette();
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setPicked(stepIndex(at, 1, shown.length));
        return;
      case "ArrowUp":
        e.preventDefault();
        setPicked(stepIndex(at, -1, shown.length));
        return;
      case "PageDown":
        e.preventDefault();
        setPicked(clampIndex(at + 6, shown.length));
        return;
      case "PageUp":
        e.preventDefault();
        setPicked(clampIndex(at - 6, shown.length));
        return;
      case "Enter":
        e.preventDefault();
        go(shown[at]);
        return;
      case "Tab":
        // One field is all there is to land on.
        e.preventDefault();
        return;
    }
  };

  const optionId = (i: number) => `${listId}-${i}`;

  return createPortal(
    <div className="qj-root" onKeyDown={onKey}>
      <div aria-hidden="true" className="fade-in qj-scrim" onClick={closePalette} />
      <div role="dialog" aria-modal="true" aria-label="Quick jump" className="pop-enter qj-panel">
        <div className="qj-field">
          <MagnifyingGlass size={18} aria-hidden="true" className="qj-lens" />
          <input
            ref={input}
            value={query}
            onChange={(e) => type(e.target.value)}
            type="text"
            role="combobox"
            aria-label="Jump to"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown.length ? optionId(at) : undefined}
            placeholder="Jump to a chat, page, project or skill"
            spellCheck={false}
            autoComplete="off"
            className="qj-input"
          />
          <kbd className="qj-key">Esc</kbd>
        </div>
        {shown.length === 0 ? (
          <p className="qj-none" role="status">
            {chat.pending || typedRows.length ? "Looking" : "Nothing matches"}
          </p>
        ) : (
          <ul ref={list} id={listId} role="listbox" aria-label="Results" className="qj-list">
            {shown.map((item, i) => {
              const Icon = item.kind === "page" ? NAV.find((n) => `page:${n.view}` === item.id)?.icon : KIND_ICON[item.kind];
              return (
                <li
                  key={item.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === at}
                  className="qj-row"
                  onPointerMove={() => i !== at && setPicked(i)}
                  onClick={() => go(item)}
                >
                  <span className="qj-icon" data-kind={item.kind}>
                    {Icon && <Icon size={16} aria-hidden="true" />}
                  </span>
                  <span className="qj-text">
                    <span className="qj-title">
                      <Marked text={item.title} query={query} />
                    </span>
                    {item.sub && (
                      <span className="qj-sub">
                        <Marked text={item.sub} query={query} />
                      </span>
                    )}
                  </span>
                  {item.kind === "page" ? <kbd className="qj-key">{item.meta}</kbd> : <span className="qj-meta">{item.meta || KIND_LABEL[item.kind]}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>,
    document.body,
  );
}
