import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ArrowsIn, ArrowsOut, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import { Button, IconButton } from "../controls";
import { useKeyHints } from "../../lib/keyHints";
import { setUnsaved } from "../../state/unsavedStore";
import { errorText } from "../../lib/setup-actions";
import type { Editor } from "../../lib/codemirror";
import type { Problem } from "../../lib/setup-types";

/**
 * The editing surface: CodeMirror, the problems found in the text (checked by
 * Rust as you type), and Save / Cancel. Save stays off while anything is wrong.
 */
export function TextEditor({
  initial,
  language,
  label,
  validate,
  onSubmit,
  submitLabel = "Save",
  requireChange = true,
  onCancel,
  onDirtyChange,
  hint,
  above,
}: {
  initial: string;
  language: string;
  label: string;
  validate: (text: string) => Promise<Problem[]>;
  /** Throw (with a readable message) when it could not be done. */
  onSubmit: (text: string) => Promise<void>;
  submitLabel?: string;
  /** Save needs a change (editing), or not (a new item starts from a template). */
  requireChange?: boolean;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  hint?: ReactNode;
  /** Fields drawn over the editor that read and change the same text. */
  above?: (api: { text: string; setText: (next: string) => void }) => ReactNode;
}) {
  const { show: showKeys, mod } = useKeyHints();
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Editor | null>(null);
  const [text, setText] = useState(initial);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [checked, setChecked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Full window: the same editor (never remounted, so edits and undo stay) grows over the whole
  // Atlas window; Escape or the button brings it back. The sheet behind never sees that Escape.
  const [wide, setWide] = useState(false);

  const textRef = useRef(initial);
  const seq = useRef(0);
  const validateRef = useRef(validate);
  validateRef.current = validate;
  const submitRef = useRef<() => void>(() => {});

  const dirty = text !== initial;
  const canSave = !saving && problems.length === 0 && (dirty || !requireChange);
  const canSaveRef = useRef(canSave);
  canSaveRef.current = canSave;

  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);

  // Any way out of the app's current view or window asks first while this holds edits.
  const who = useId();
  useEffect(() => {
    setUnsaved(who, dirty);
    return () => setUnsaved(who, false);
  }, [who, dirty]);

  // Mount the editor once; it reports edits through refs so it never remounts.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    void import("../../lib/codemirror").then(async (m) => {
      const ed = await m.mountEditor(el, textRef.current, language, {
        label,
        onChange: (t) => {
          textRef.current = t;
          setText(t);
        },
        onSave: () => submitRef.current(),
      });
      if (dead) ed.destroy();
      else {
        editor.current = ed;
        ed.focus();
      }
    });
    return () => {
      dead = true;
      editor.current?.destroy();
      editor.current = null;
    };
  }, [language, label]);

  // Check the text shortly after typing stops (and once at the start).
  useEffect(() => {
    const mine = ++seq.current;
    const t = window.setTimeout(
      () => {
        validateRef
          .current(text)
          .then((p) => {
            if (mine !== seq.current) return;
            setProblems(p);
            setChecked(true);
          })
          .catch((e) => {
            if (mine !== seq.current) return;
            setProblems([{ message: errorText(e, "Atlas could not check this text."), line: null }]);
            setChecked(true);
          });
      },
      checked ? 180 : 0,
    );
    return () => window.clearTimeout(t);
    // `checked` only decides the first delay.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  useEffect(() => editor.current?.markLine(problems[0]?.line ?? null), [problems]);

  // Growing or shrinking keeps the caret where it was and the keyboard in the text.
  const wasWide = useRef(wide);
  useEffect(() => {
    if (wasWide.current === wide) return;
    wasWide.current = wide;
    editor.current?.focus();
  }, [wide]);

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && wide) {
      e.preventDefault();
      e.stopPropagation();
      setWide(false);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      e.stopPropagation();
      setWide((w) => !w);
    }
  };
  const wideKeys = `${mod} Shift F`;

  const submit = async () => {
    if (!canSaveRef.current) return;
    setSaving(true);
    setError(null);
    try {
      // Last look at exactly what will be written.
      const now = textRef.current;
      const p = await validateRef.current(now);
      if (p.length) {
        setProblems(p);
        return;
      }
      await onSubmit(now);
    } catch (e) {
      setError(errorText(e, "Atlas could not save that, so nothing was changed."));
    } finally {
      setSaving(false);
    }
  };
  submitRef.current = () => void submit();

  return (
    <div
      data-wide={wide || undefined}
      onKeyDown={onKey}
      className={wide ? "editor-wide fixed inset-0 z-20 flex flex-col gap-3 bg-bg p-6" : "flex min-h-0 flex-1 flex-col gap-3"}
    >
      {wide && <p className="truncate text-caption text-ink-2">{label}</p>}
      {above?.({ text, setText: (next) => editor.current?.setText?.(next) })}
      {/* Gives up height (down to about eight lines) before the check message and Save are pushed out of a short window. */}
      <div
        ref={host}
        data-editor
        className={`${wide ? "min-h-0 flex-1" : "h-[min(440px,calc(var(--app-h)*0.52))] min-h-[200px]"} overflow-hidden rounded-card border border-line-strong bg-surface`}
      />

      <div aria-live="polite" className="min-h-6">
        {problems.length > 0 ? (
          <ul role="alert" className="space-y-1">
            {problems.map((p, i) => (
              <li key={`${i}-${p.message}`} className="flex items-start gap-2 text-body text-danger">
                <WarningCircle size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="selectable">
                  {p.line ? `Line ${p.line}: ` : ""}
                  {p.message}
                </span>
              </li>
            ))}
          </ul>
        ) : checked ? (
          <p className="flex items-center gap-2 text-body text-ink-2">
            <CheckCircle size={16} weight="fill" aria-hidden="true" className="text-success" />
            Looks good.
          </p>
        ) : null}
        {error && (
          <p role="alert" className="mt-1 flex items-start gap-2 rounded-control bg-danger-tint px-3 py-2 text-body text-danger">
            {error}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {/* Sits with Save and Cancel, never over the text. */}
        <IconButton
          aria-label={wide ? "Exit full window" : "Full window"}
          title={wide ? "Exit full window (Esc)" : showKeys ? `Full window (${wideKeys})` : "Full window"}
          onClick={() => setWide((w) => !w)}
          className="-ml-2"
        >
          {wide ? <ArrowsIn size={16} aria-hidden="true" /> : <ArrowsOut size={16} aria-hidden="true" />}
        </IconButton>
        {hint && <p className="text-caption text-ink-2">{hint}</p>}
        <span className="flex-1" />
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!canSave} title={showKeys ? `${submitLabel} (${mod} S)` : undefined}>
          {saving ? "Saving..." : submitLabel}
        </Button>
      </div>
    </div>
  );
}
