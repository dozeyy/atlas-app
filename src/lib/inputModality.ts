/**
 * How the user last moved: `data-input="keyboard"` on <html> after a Tab or an arrow-style key,
 * `"pointer"` after any press. The focus ring in index.css only draws under "keyboard", so a click,
 * a window coming back to the front, or code that hands focus back to a button never shows a box.
 * One listener pair on the document; nothing runs per frame.
 */

const WALK_KEYS = new Set(["Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

export type InputMode = "keyboard" | "pointer";

/** True for a key press that walks focus around (not a shortcut, not typing). */
export function isWalkKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return WALK_KEYS.has(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export function installInputModality(doc: Document = document): () => void {
  const root = doc.documentElement;
  const set = (mode: InputMode) => {
    if (root.dataset.input !== mode) root.dataset.input = mode;
  };
  set("pointer");
  const onKey = (e: KeyboardEvent) => {
    if (isWalkKey(e)) set("keyboard");
  };
  const onPointer = () => set("pointer");
  doc.addEventListener("keydown", onKey, true);
  doc.addEventListener("pointerdown", onPointer, true);
  doc.addEventListener("mousedown", onPointer, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    doc.removeEventListener("pointerdown", onPointer, true);
    doc.removeEventListener("mousedown", onPointer, true);
  };
}
