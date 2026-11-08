// The text viewer and editor used by the Setup detail view (CodeMirror 6).
//
// This module is only ever loaded with `import()` when a detail view opens, so
// none of it counts toward startup. Colors come from the --syntax-* tokens, so
// light and dark need no separate theme. Secret values arrive already masked
// (bullets); the ranges only get a quiet "hidden" look, never the real value.

import { Compartment, EditorState, type Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, lineNumbers } from "@codemirror/view";
import { HighlightStyle, StreamLanguage, syntaxHighlighting, type LanguageSupport } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { MaskedRange } from "./setup-types";

export interface Viewer {
  destroy(): void;
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier, t.controlKeyword, t.definitionKeyword], color: "var(--syntax-keyword)" },
  { tag: [t.string, t.regexp, t.special(t.string), t.docString], color: "var(--syntax-string)" },
  { tag: [t.number, t.bool, t.null, t.atom, t.literal], color: "var(--syntax-number)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta, t.processingInstruction], color: "var(--syntax-comment)" },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName), t.function(t.variableName), t.labelName], color: "var(--syntax-name)" },
  { tag: [t.heading, t.heading1, t.heading2, t.heading3, t.heading4], color: "var(--syntax-heading)", fontWeight: "600" },
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: [t.link, t.url], color: "var(--syntax-keyword)", textDecoration: "underline" },
  { tag: [t.punctuation, t.bracket, t.separator], color: "var(--ink-2)" },
]);

const theme = EditorView.theme({
  "&": { color: "var(--ink)", backgroundColor: "transparent", fontSize: "12px", height: "100%" },
  "&.cm-focused": { outline: "2px solid var(--accent-text)", outlineOffset: "-2px" },
  ".cm-scroller": { fontFamily: "var(--font-code)", lineHeight: "19px", overflow: "auto" },
  ".cm-content": { padding: "10px 0", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0 14px 0 6px" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--ink-2)", border: "none", opacity: "0.75" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 14px", minWidth: "36px" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "var(--accent-tint)" },
  ".cm-masked": {
    backgroundColor: "var(--raised)",
    color: "var(--ink-2)",
    borderRadius: "4px",
    boxShadow: "0 0 0 1px var(--line-strong)",
    padding: "0 2px",
  },
});

async function languageFor(language: string): Promise<Extension | null> {
  switch (language) {
    case "markdown": {
      const m = await import("@codemirror/lang-markdown");
      return m.markdown() as LanguageSupport;
    }
    case "json": {
      const m = await import("@codemirror/lang-json");
      return m.json();
    }
    case "javascript":
    case "typescript": {
      const m = await import("@codemirror/lang-javascript");
      return m.javascript({ typescript: language === "typescript" });
    }
    case "python": {
      const m = await import("@codemirror/lang-python");
      return m.python();
    }
    case "yaml": {
      const m = await import("@codemirror/lang-yaml");
      return m.yaml();
    }
    case "shell": {
      const m = await import("@codemirror/legacy-modes/mode/shell");
      return StreamLanguage.define(m.shell);
    }
    case "powershell": {
      const m = await import("@codemirror/legacy-modes/mode/powershell");
      return StreamLanguage.define(m.powerShell);
    }
    case "toml": {
      const m = await import("@codemirror/legacy-modes/mode/toml");
      return StreamLanguage.define(m.toml);
    }
    default:
      return null;
  }
}

const maskMark = Decoration.mark({ class: "cm-masked" });

/** Ranges are UTF-16 offsets (what CodeMirror counts too); clamp and sort defensively. */
function maskExtension(ranges: MaskedRange[], length: number): Extension {
  const b = new RangeSetBuilder<Decoration>();
  const ok = ranges
    .filter((r) => r.start >= 0 && r.end > r.start && r.start < length)
    .map((r) => [r.start, Math.min(r.end, length)] as const)
    .sort((a, c) => a[0] - c[0]);
  let last = 0;
  for (const [from, to] of ok) {
    if (from < last) continue;
    b.add(from, to, maskMark);
    last = to;
  }
  return EditorView.decorations.of(b.finish());
}

/** Show `text` read-only in `parent`. The caller owns `destroy()`. */
export async function mountViewer(parent: HTMLElement, text: string, language: string, masked: MaskedRange[]): Promise<Viewer> {
  const lang = new Compartment();
  const base: Extension[] = [
    EditorState.readOnly.of(true),
    EditorView.contentAttributes.of({ "aria-readonly": "true", "aria-label": "File contents, read only" }),
    EditorView.lineWrapping,
    lineNumbers(),
    theme,
    syntaxHighlighting(highlight),
    maskExtension(masked, text.length),
    lang.of([]),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: text, extensions: base }) });
  // The grammar loads after the first paint, so the text shows immediately.
  languageFor(language)
    .then((ext) => {
      if (ext && view.dom.isConnected) view.dispatch({ effects: lang.reconfigure(ext) });
    })
    .catch(() => {});
  return { destroy: () => view.destroy() };
}

// ---- the editor (same look, but you can type) ----

export interface Editor {
  focus(): void;
  /** Mark one line (1-based) as the place a problem is, or clear it with null. */
  markLine(line: number | null): void;
  destroy(): void;
}

const setErrorLine = StateEffect.define<number | null>();
const errorLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setErrorLine)) continue;
      if (e.value === null || e.value < 1 || e.value > tr.state.doc.lines) return Decoration.none;
      const at = tr.state.doc.line(e.value).from;
      return Decoration.set([Decoration.line({ class: "cm-error-line" }).range(at)]);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const editTheme = EditorView.theme({
  ".cm-error-line": { backgroundColor: "var(--danger-tint)" },
  "&": { minHeight: "320px" },
  ".cm-cursor": { borderLeftColor: "var(--ink)" },
});

/**
 * Edit `text` in `parent`. `onChange` fires on every edit with the whole text;
 * `onSave` on Ctrl/Cmd+S. The caller owns `destroy()`.
 */
export async function mountEditor(
  parent: HTMLElement,
  text: string,
  language: string,
  opts: { label: string; onChange: (text: string) => void; onSave: () => void },
): Promise<Editor> {
  const [{ defaultKeymap, history, historyKeymap, indentWithTab }, { keymap }] = await Promise.all([
    import("@codemirror/commands"),
    import("@codemirror/view"),
  ]);
  const lang = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => (opts.onSave(), true) },
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
        ]),
        EditorView.contentAttributes.of({ "aria-label": opts.label, "aria-multiline": "true" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
        EditorView.lineWrapping,
        lineNumbers(),
        theme,
        editTheme,
        syntaxHighlighting(highlight),
        errorLine,
        lang.of([]),
      ],
    }),
  });
  languageFor(language)
    .then((ext) => {
      if (ext && view.dom.isConnected) view.dispatch({ effects: lang.reconfigure(ext) });
    })
    .catch(() => {});
  return {
    focus: () => view.focus(),
    markLine: (line) => view.dispatch({ effects: setErrorLine.of(line) }),
    destroy: () => view.destroy(),
  };
}
