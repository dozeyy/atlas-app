import { useEffect, useRef } from "react";
import { place } from "../lib/tipPlace";

/**
 * The one hover/focus tooltip for the whole app.
 *
 * Anything with a `title` attribute gets this layer instead of the browser's plain box, including
 * titles added later or on other screens: the layer listens once on the document, so no element
 * opts in. While a tip is wanted the native `title` is moved to `data-tip` (so the browser stays
 * quiet) and put back when the pointer or focus leaves. `data-tip="text"` on its own also works.
 * A line break in the text starts the quieter second paragraph.
 *
 * Cost: a handful of document listeners and one fixed element. Nothing runs on pointer-move;
 * position is computed once per show, from the target's box.
 */
const SHOW_MS = 380; // hover: a short, deliberate pause
const WARM_MS = 400; // moving from one tip straight to the next skips the pause
const POLL_MS = 400; // while open, notice a target that was removed from the page

const SELECTOR = "[title], [data-tip]";
/** Anything that closes on Escape itself: a tip inside one never takes the key from it. */
const ESC_OWNER = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

function textOf(el: Element): string {
  return el.getAttribute("title") || el.getAttribute("data-tip") || "";
}

const flat = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** Is any text in `el` cut short on screen: an ellipsis (`truncate`) or a clamp? */
function isCut(el: Element): boolean {
  const cut = (e: Element) => {
    if (e.scrollWidth <= e.clientWidth + 1 && e.scrollHeight <= e.clientHeight + 1) return false;
    const s = getComputedStyle(e);
    return s.overflowX === "hidden" || s.overflowY === "hidden" || s.overflowX === "clip" || s.overflowY === "clip";
  };
  if (cut(el)) return true;
  for (const d of el.querySelectorAll("*")) if (cut(d)) return true;
  return false;
}

/**
 * The text of `el` a person can see: text inside anything faded out (opacity 0), hidden or not
 * displayed does not count. A folded sidebar keeps each name in the DOM at opacity 0 so it can
 * fade back in; to the eye the button is icon-only, and its name is new again.
 */
function visibleText(el: Element): string {
  const hidden = (e: Element) => {
    const s = getComputedStyle(e);
    return s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0;
  };
  if (hidden(el)) return "";
  let out = "";
  const walk = (node: Node) => {
    for (const c of node.childNodes) {
      if (c.nodeType === Node.TEXT_NODE) out += c.textContent ?? "";
      else if (c.nodeType === Node.ELEMENT_NODE && !hidden(c as Element)) walk(c);
    }
  };
  walk(el);
  return out;
}

/**
 * The one rule for a tip that says what is already under the pointer (Will, 2026-11-10): a tip
 * that only repeats a name shown in full adds nothing and stays away; the same tip on a name cut
 * short with an ellipsis, or on a control whose name is faded out to an icon, is the only way to
 * read it, so it shows. A name that needs no tip hands the hover on to the next thing above it
 * that has one (the row's own tip).
 */
function worthShowing(el: Element): boolean {
  const text = flat(textOf(el));
  if (!text) return false;
  return text !== flat(visibleText(el)) || isCut(el);
}

/** The element whose tip a pointer or focus on `from` should show, if any. */
function pick(from: Element | null): Element | null {
  let el = from && from.closest ? from.closest(SELECTOR) : null;
  while (el && !worthShowing(el)) el = el.parentElement?.closest(SELECTOR) ?? null;
  return el;
}

/** `:focus-visible` is keyboard focus; engines without it (and jsdom) count every focus. */
function keyboardFocused(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** `resetKey` changes when the screen does (the route): an open tip is put away with it. */
export function TipLayer({ resetKey }: { resetKey?: unknown }) {
  const box = useRef<HTMLDivElement>(null);
  const closeRef = useRef<() => void>(() => {});

  useEffect(() => {
    closeRef.current();
  }, [resetKey]);

  useEffect(() => {
    const found = box.current;
    if (!found) return;
    const tip: HTMLDivElement = found;
    const head = tip.firstElementChild as HTMLElement;
    const rest = tip.lastElementChild as HTMLElement;

    let target: Element | null = null;
    let stashed = false; // the target's title is parked in data-tip
    let named = false; // we gave an icon-only target an aria-label so it keeps its name
    let open = false;
    let timer = 0;
    let poll = 0;
    let lastClosed = -Infinity;
    let pointer = { x: 0, y: 0 };
    // The target a press, a shortcut or a screen change put away: it stays quiet until the pointer
    // leaves it, however the page re-renders or moves focus meanwhile.
    let muted: Element | null = null;
    // Where the pointer was when that happened. A screen change can replace the element under it, and
    // the browser then reports the pointer "entering" the new one without moving: that is not a hover.
    let stillAt: { x: number; y: number } | null = null;

    /** Move the native title out of the browser's reach. */
    const stash = (el: Element) => {
      const t = el.getAttribute("title");
      if (t === null) return;
      el.setAttribute("data-tip", t);
      el.removeAttribute("title");
      stashed = true;
      const iconOnly = !el.hasAttribute("aria-label") && !el.hasAttribute("aria-labelledby") && !(el.textContent ?? "").trim();
      if (iconOnly && t && !named) {
        el.setAttribute("aria-label", t.split("\n")[0]);
        named = true;
      }
    };

    /** Give the title back (the page may have set a newer one meanwhile, which wins). */
    const restore = (el: Element) => {
      if (stashed) {
        const t = el.getAttribute("data-tip");
        if (t !== null && !el.hasAttribute("title")) el.setAttribute("title", t);
        el.removeAttribute("data-tip");
      }
      if (named) el.removeAttribute("aria-label");
      if (el.getAttribute("aria-describedby") === tip.id) el.removeAttribute("aria-describedby");
      stashed = false;
      named = false;
    };

    const hide = () => {
      window.clearTimeout(timer);
      window.clearInterval(poll);
      timer = 0;
      if (open) lastClosed = performance.now();
      open = false;
      tip.removeAttribute("data-open");
    };

    // The page re-renders a title while it is hovered (live numbers): take it back and refresh the tip.
    const watch = new MutationObserver(() => {
      if (!target || !target.hasAttribute("title")) return;
      stash(target);
      if (open) show(target);
    });

    const release = () => {
      hide();
      watch.disconnect();
      if (target) restore(target);
      target = null;
      muted = null;
    };

    /** Put the tip away for good while the pointer stays on its target. */
    const quiet = (at: { x: number; y: number } = pointer) => {
      muted = target;
      stillAt = { ...at };
      hide();
    };
    closeRef.current = () => quiet();

    function show(el: Element) {
      if (el === muted) return;
      if (!el.isConnected) {
        if (el === target) release(); // removed during the show delay: let it go now
        return;
      }
      const text = textOf(el).trim();
      if (!text) {
        hide(); // the page emptied the title while its tip was up
        return;
      }
      const [first, ...others] = text.split("\n");
      head.textContent = first;
      rest.textContent = others.join("\n");
      rest.hidden = others.length === 0;

      // Measure while it is invisible, then place it; the fade starts from the attribute below.
      const r = el.getBoundingClientRect();
      const t = tip.getBoundingClientRect();
      const p = place(
        { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
        { w: t.width, h: t.height },
        { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
        pointer,
      );
      tip.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      tip.style.setProperty("--caret", `${Math.round(p.caret)}px`);
      tip.dataset.side = p.side;

      if (el.getAttribute("aria-label") !== first && (el.textContent ?? "").trim() !== first) el.setAttribute("aria-describedby", tip.id);

      if (!open) {
        open = true;
        poll = window.setInterval(() => {
          if (target && !target.isConnected) release();
        }, POLL_MS);
      }
      tip.setAttribute("data-open", "");
    }

    const take = (el: Element) => {
      target = el;
      stash(el);
      watch.observe(el, { attributes: true, attributeFilter: ["title"] });
    };

    const arm = (el: Element, delay: number) => {
      window.clearTimeout(timer);
      if (delay <= 0) show(el);
      else timer = window.setTimeout(() => show(el), delay);
    };

    const onOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const el = pick(e.target as Element | null);
      pointer = { x: e.clientX, y: e.clientY };
      if (stillAt) {
        if (Math.hypot(pointer.x - stillAt.x, pointer.y - stillAt.y) < 4) return;
        stillAt = null;
      }
      if (el === target) return;
      if (target) release();
      if (!el) return;
      take(el);
      arm(el, performance.now() - lastClosed < WARM_MS ? 0 : SHOW_MS);
    };

    const onOut = (e: PointerEvent) => {
      if (!target) return;
      const to = e.relatedTarget as Node | null;
      if (to && target.contains(to)) return;
      // A tip that keyboard focus asked for stays while the mouse passes over and away.
      if (target === document.activeElement && keyboardFocused(target)) return;
      release();
    };

    const onFocusIn = (e: FocusEvent) => {
      const el = pick(e.target as Element | null);
      if (!el || !keyboardFocused(el)) return;
      if (el !== target) {
        if (target) release();
        take(el);
      }
      arm(el, 0);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (!target) return;
      const to = e.relatedTarget as Node | null;
      if (to && target.contains(to)) return;
      release();
    };

    // Esc puts the tip away; the title stays parked until the pointer or focus leaves.
    // A shortcut (Ctrl+7 and the like) is the person doing something else: the tip goes with it.
    // A tip that keyboard focus asked for takes that Esc for itself, so one press does one thing: it
    // does not also step back a page. A tip inside a dialog, sheet or menu leaves the key to its
    // owner (closing that takes the tip with it), and a hover tip never holds a key back.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) {
        const byKeyboard = !!target && target === document.activeElement && keyboardFocused(target);
        if (byKeyboard && !target!.closest(ESC_OWNER)) e.preventDefault();
        hide();
      } else if ((e.ctrlKey || e.metaKey || e.altKey) && !["Control", "Meta", "Alt"].includes(e.key) && (open || timer)) quiet();
    };

    // A press is a choice made: the tip does not come back for this target, even when focus lands on it.
    const onPress = (e: Event) => {
      if (!target) return;
      const p = e as PointerEvent;
      quiet(typeof p.clientX === "number" ? { x: p.clientX, y: p.clientY } : pointer);
    };

    // A press, a scroll or a resize means the person is doing something else.
    const onAway = () => {
      if (open || timer) hide();
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("click", onPress, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onAway, { capture: true, passive: true });
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", release);

    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("click", onPress, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onAway, true);
      window.removeEventListener("resize", onAway);
      window.removeEventListener("blur", release);
      release();
    };
  }, []);

  return (
    <div ref={box} id="atlas-tip" role="tooltip" className="tt">
      <span className="tt-head" />
      <span className="tt-rest" hidden />
    </div>
  );
}
