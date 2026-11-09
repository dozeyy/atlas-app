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

function textOf(el: Element): string {
  return el.getAttribute("title") || el.getAttribute("data-tip") || "";
}

/** `:focus-visible` is keyboard focus; engines without it (and jsdom) count every focus. */
function keyboardFocused(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

export function TipLayer() {
  const box = useRef<HTMLDivElement>(null);

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
    };

    function show(el: Element) {
      const text = textOf(el).trim();
      if (!text || !el.isConnected) return;
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
      const t = e.target as Element | null;
      const el = t && t.closest ? t.closest(SELECTOR) : null;
      pointer = { x: e.clientX, y: e.clientY };
      if (el === target) return;
      if (target) release();
      if (!el || !textOf(el)) return;
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
      const t = e.target as Element | null;
      const el = t && t.closest ? t.closest(SELECTOR) : null;
      if (!el || !textOf(el) || !keyboardFocused(el)) return;
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
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open) hide();
    };

    // A press, a scroll or a resize means the person is doing something else.
    const onAway = () => {
      if (open || timer) hide();
    };

    document.addEventListener("pointerover", onOver, true);
    document.addEventListener("pointerout", onOut, true);
    document.addEventListener("pointerdown", onAway, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("scroll", onAway, { capture: true, passive: true });
    window.addEventListener("resize", onAway);
    window.addEventListener("blur", release);

    return () => {
      document.removeEventListener("pointerover", onOver, true);
      document.removeEventListener("pointerout", onOut, true);
      document.removeEventListener("pointerdown", onAway, true);
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
