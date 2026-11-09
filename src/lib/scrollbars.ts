// Auto-hiding scrollbars. Every scroll container keeps its thin scrollbar, but the thumb is drawn
// only while the container is hovered, being scrolled, or holds keyboard focus (CSS in index.css).
// At rest the scrollbar is background colour, so a window edge drag that clips the page for a
// frame (WebView2 presents the new size a frame late) never shows the bar blinking at the edge.
//
// This file marks a container as scrolling: one passive capture listener for the whole document,
// one attribute write when scrolling starts and one when it has been still for HIDE_MS.

export const HIDE_MS = 900;

export function installScrollbars(doc: Document = document): () => void {
  const timers = new Map<Element, number>();
  const onScroll = (e: Event) => {
    const t = e.target;
    const el = t instanceof Element ? t : doc.scrollingElement;
    if (!el) return;
    const prev = timers.get(el);
    if (prev === undefined) el.setAttribute("data-scrolling", "");
    else window.clearTimeout(prev);
    timers.set(
      el,
      window.setTimeout(() => {
        timers.delete(el);
        el.removeAttribute("data-scrolling");
      }, HIDE_MS),
    );
  };
  doc.addEventListener("scroll", onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener("scroll", onScroll, { capture: true });
    for (const [el, id] of timers) {
      window.clearTimeout(id);
      el.removeAttribute("data-scrolling");
    }
    timers.clear();
  };
}
