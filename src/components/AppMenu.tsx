import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { CaretRight, List } from "@phosphor-icons/react";
import { IconButton } from "./controls";
import { HelpSheet } from "./HelpSheets";
import { APP_MENU } from "../lib/appMenu";
import { onNativeMenu } from "../lib/ipc";
import type { MenuEntry, SheetId } from "../lib/appMenu";
import { useAtlas } from "../state/AtlasProvider";

const ITEMS = '[role="menuitem"]';

/** The items that belong to `menu` itself (not to a submenu inside it), in order. */
function itemsOf(menu: Element | null | undefined): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEMS)).filter((el) => el.closest('[role="menu"]') === menu);
}

/** The items of the menu that holds `el`. */
const siblings = (el: Element | null) => itemsOf(el?.closest('[role="menu"]'));

/**
 * The three-line menu at the top left, like the Claude app's. A button opens a small menu; Help
 * opens a submenu of sheets. Alt or F10 opens it from the keyboard; arrows move, Right and Left
 * go into and out of a submenu, Enter picks, Escape closes and gives focus back to the button.
 * What is in it is data (APP_MENU), so another menu is one more entry there.
 */
export function AppMenu() {
  const { info, setView } = useAtlas();
  const [open, setOpen] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  const [sheet, setSheet] = useState<SheetId | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusFirst = useRef(false);
  const focusSub = useRef(false);

  // Keyboard-opened submenu: focus its first item as soon as it has rendered, so the very
  // next arrow key already acts inside it (a rAF here lost fast key presses).
  useEffect(() => {
    if (!sub || !focusSub.current) return;
    focusSub.current = false;
    itemsOf(root.current?.querySelector(`[data-menu="${sub}"]`))[0]?.focus({ preventScroll: true });
  }, [sub]);
  const menuId = useId();

  // macOS menu bar (macmenu.rs): Settings goes to its page, About and Help open the same sheets.
  useEffect(() => {
    const sheets = new Set<string>(APP_MENU.flatMap((m) => m.items ?? []).map((m) => m.sheet ?? ""));
    let off: (() => void) | undefined;
    let alive = true;
    onNativeMenu((id) => {
      if (id === "settings") setView("settings");
      else if (sheets.has(id)) setSheet(id as SheetId);
    })
      .then((fn) => {
        if (alive) off = fn;
        else fn();
      })
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [setView]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setSub(null);
    if (refocus) trigger.current?.focus({ preventScroll: true });
  }, []);

  // A menu that just opened puts focus on its first item, so the arrows work at once.
  useEffect(() => {
    if (!open || !focusFirst.current) return;
    focusFirst.current = false;
    itemsOf(root.current?.querySelector('[role="menu"]'))[0]?.focus({ preventScroll: true });
  }, [open]);

  // Alt (pressed and released alone) or F10 opens the menu, like a desktop app's menu bar.
  useEffect(() => {
    let altAlone = false;
    const modal = () => !!document.querySelector('[role="dialog"], [role="alertdialog"]');
    const show = () => {
      focusFirst.current = true;
      setOpen(true);
    };
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.key === "F10" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (modal()) return;
        e.preventDefault();
        show();
        return;
      }
      altAlone = e.key === "Alt" && !e.repeat && info.platform !== "macos";
    };
    const up = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Alt" || !altAlone) return;
      altAlone = false;
      if (modal()) return;
      e.preventDefault();
      show();
    };
    const lost = () => {
      altAlone = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", lost);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", lost);
    };
  }, [info.platform]);

  // A press anywhere outside closes it.
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, close]);

  const pick = (s: SheetId) => {
    // Focus goes back to the button first, so the sheet hands it back there when it closes.
    close(true);
    setSheet(s);
  };

  const onKey = (e: KeyboardEvent) => {
    const at = document.activeElement;
    const list = siblings(at);
    const i = list.indexOf(at as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      list[(n + list.length) % list.length]?.focus({ preventScroll: true });
    };
    switch (e.key) {
      case "ArrowDown":
        return go(i + 1);
      case "ArrowUp":
        return go(i < 0 ? list.length - 1 : i - 1);
      case "Home":
        return go(0);
      case "End":
        return go(list.length - 1);
      case "ArrowRight": {
        const id = (at as HTMLElement | null)?.dataset.sub;
        if (!id) return;
        e.preventDefault();
        if (sub === id) {
          itemsOf(root.current?.querySelector(`[data-menu="${id}"]`))[0]?.focus({ preventScroll: true });
          return;
        }
        focusSub.current = true;
        setSub(id);
        return;
      }
      case "ArrowLeft":
      case "Escape": {
        e.stopPropagation();
        const inSub = (at as HTMLElement | null)?.closest<HTMLElement>("[data-menu]");
        if (inSub) {
          e.preventDefault();
          const id = inSub.dataset.menu;
          setSub(null);
          root.current?.querySelector<HTMLElement>(`[data-sub="${id}"]`)?.focus({ preventScroll: true });
        } else if (e.key === "Escape") {
          e.preventDefault();
          close(true);
        }
        return;
      }
      case "Tab":
        close(false);
        return;
    }
  };

  const entry = (m: MenuEntry) => {
    const parent = !!m.items;
    return (
      <button
        key={m.id}
        type="button"
        role="menuitem"
        tabIndex={-1}
        data-sub={parent ? m.id : undefined}
        aria-haspopup={parent ? "menu" : undefined}
        aria-expanded={parent ? sub === m.id : undefined}
        className="app-menu-item"
        onPointerEnter={() => setSub(parent ? m.id : null)}
        onClick={() => (m.sheet ? pick(m.sheet) : setSub(m.id))}
      >
        <span>{m.label}</span>
        {parent && <CaretRight size={14} aria-hidden="true" />}
      </button>
    );
  };

  return (
    <div ref={root} className="relative">
      <IconButton
        ref={trigger}
        aria-label="Menu"
        title={info.platform === "macos" ? "Menu" : "Menu (Alt)"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          focusFirst.current = !open;
          if (open) close(false);
          else setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            focusFirst.current = true;
            setOpen(true);
          }
        }}
      >
        <List size={18} aria-hidden="true" />
      </IconButton>
      {open && (
        <div id={menuId} role="menu" aria-label="Menu" className="app-menu" onKeyDown={onKey}>
          {APP_MENU.map((m) => (
            <div key={m.id} className="relative">
              {entry(m)}
              {m.items && sub === m.id && (
                <div role="menu" aria-label={m.label} data-menu={m.id} className="app-menu app-submenu">
                  {m.items.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitem"
                      tabIndex={-1}
                      className="app-menu-item"
                      onClick={() => s.sheet && pick(s.sheet)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {sheet && <HelpSheet id={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
