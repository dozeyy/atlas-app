import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { Button } from "../controls";
import { ErrorBlock, Skeleton } from "../usage/StateBlocks";
import { SideSheet } from "./SideSheet";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import { reloadSetup } from "../../state/setupStore";
import { pushToast } from "../../state/toastStore";
import type { PreviewLine, ReviewTheme, RuleSheetData, RuleTarget } from "../../lib/teamTypes";

/** The most a CLAUDE.md line may hold; the server enforces the same number. */
const LINE_MAX = 400;

/** Which file the toast names: "your global CLAUDE.md", "atlas's CLAUDE.md", "the rule file rules/x.md". */
export function whereWords(t: RuleTarget): string {
  if (t.kind === "file") return `the rule file ${t.title.replace(/^A rule file, /, "")}`;
  if (t.id === "global") return "your global CLAUDE.md";
  return `${t.title.replace(/^CLAUDE\.md in /, "")}'s CLAUDE.md`;
}

/**
 * What a place is called in the list. The engine's title for a rule file carries the file name it
 * made from the finding (a long slug); the path under it already shows that, so the title is words.
 */
export function targetTitle(t: RuleTarget): string {
  if (t.kind !== "file") return t.title;
  return t.exists ? "A rule file of its own" : "A new rule file of its own";
}

/**
 * The one-line rule in a box that grows with it: a long line wraps and is read whole instead of
 * running out of a single-line field. It is still one line in the file: a line break typed or
 * pasted in becomes a space, and Enter saves.
 */
function LineField({
  id,
  value,
  disabled,
  describedBy,
  onChange,
  onEnter,
}: {
  id: string;
  value: string;
  disabled: boolean;
  describedBy: string;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    // The border is outside scrollHeight.
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  return (
    <textarea
      ref={box}
      id={id}
      rows={1}
      value={value}
      maxLength={LINE_MAX}
      disabled={disabled}
      spellCheck={false}
      aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
      className="selectable team-draft block w-full resize-none overflow-hidden rounded-control border border-line-strong bg-surface px-3 py-2 font-mono text-body text-ink [overflow-wrap:anywhere]"
    />
  );
}

/** The few lines of the file around where the rule lands, before and after, in a calm code well. */
function Preview({ lines, rule }: { lines: PreviewLine[]; rule: string }) {
  const before = lines.filter((l) => l.kind === "keep");
  const empty = before.length === 0;
  return (
    <div className="mt-4" aria-label="What will change">
      <p className="mb-1.5 text-body font-semibold text-ink">What will change</p>
      <div className="grid gap-2">
        <PreviewBlock label="Now">
          {empty ? <PreviewRow text="This file is empty or new." dim /> : before.map((l, i) => <PreviewRow key={i} text={l.text} />)}
        </PreviewBlock>
        <PreviewBlock label="After saving">
          {lines.map((l, i) => (l.kind === "slot" ? <PreviewRow key={i} text={rule.trim() || " "} added /> : <PreviewRow key={i} text={l.text} added={l.kind === "added"} />))}
        </PreviewBlock>
      </div>
    </div>
  );
}

function PreviewBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <figure className="team-preview" aria-label={label}>
      <figcaption className="team-preview-label text-caption">{label}</figcaption>
      <div className="selectable">{children}</div>
    </figure>
  );
}

function PreviewRow({ text, added, dim }: { text: string; added?: boolean; dim?: boolean }) {
  return (
    <div className="team-preview-row" data-added={added ? "true" : undefined} data-dim={dim ? "true" : undefined}>
      {text === "" ? " " : text}
    </div>
  );
}

/**
 * "Make this a rule": pick where the line goes (your Claude folder's CLAUDE.md, a project's
 * CLAUDE.md, or a new rule file), tweak the sentence, Save. The write goes through the same
 * safe path as every other Toolkit edit: a backup first, an exact-bytes write, a History row
 * and an Undo in the toast. If the file changed since the sheet opened, nothing is written
 * and the sheet says so.
 */
export function RuleSheet({ theme, onClose, onChanged }: { theme: ReviewTheme; onClose: () => void; onChanged: () => void }) {
  const backend = getBackend();
  const [sheet, setSheet] = useState<RuleSheetData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targetId, setTargetId] = useState<string>("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<{ text: string; stale: boolean } | null>(null);
  const radioName = useId();

  const load = useCallback(() => {
    setLoadError(null);
    backend
      .ruleSheet(theme.label, theme.projectPaths)
      .then((s) => {
        setSheet(s);
        setDrafts(Object.fromEntries(s.targets.map((t) => [t.id, t.text])));
        setTargetId((cur) => (s.targets.some((t) => t.id === cur && !t.blocked) ? cur : (s.targets.find((t) => !t.blocked)?.id ?? "")));
        setProblem(null);
      })
      .catch((e) => setLoadError(errorText(e, "Atlas could not prepare this rule.")));
  }, [backend, theme.label, theme.projectPaths]);

  useEffect(() => {
    load();
  }, [load]);

  const target: RuleTarget | undefined = sheet?.targets.find((t) => t.id === targetId);
  const text = target ? (drafts[target.id] ?? "") : "";
  const lineOk = !target || target.kind === "file" || /^- \S/.test(text.trim());
  const canSave = !!target && !target.blocked && text.trim().length > 0 && lineOk && !saving;

  const save = async () => {
    if (!target || !canSave) return;
    setSaving(true);
    setProblem(null);
    try {
      const out = await backend.ruleSave({
        themeId: theme.id,
        label: theme.label,
        projectPaths: theme.projectPaths,
        targetId: target.id,
        text,
        stamp: target.stamp,
      });
      if (out.status === "conflict") {
        setProblem({ text: out.message ?? "This file changed since you opened it.", stale: true });
        return;
      }
      const backupId = out.backupId;
      onChanged();
      onClose();
      const where = whereWords(target);
      const note = out.note ? ` ${out.note}` : "";
      if (out.status === "already") {
        pushToast({ message: `That rule is already in ${where}. Nothing was added.${note}`, tone: "success" });
        reloadSetup();
        return;
      }
      pushToast({
        message: `Added a rule to ${where}.${note}`,
        tone: "success",
        action: backupId
          ? {
              label: "Undo",
              onClick: async () => {
                try {
                  await backend.setupUndo(backupId);
                  await backend.ruleForget(theme.id);
                  pushToast({ message: "Took that rule back. The file is exactly as it was.", tone: "success" });
                } catch (e) {
                  pushToast({ message: errorText(e, "Atlas could not undo that."), tone: "error" });
                } finally {
                  reloadSetup();
                  onChanged();
                }
              },
            }
          : undefined,
      });
      reloadSetup();
    } catch (e) {
      setProblem({ text: errorText(e, "Atlas could not save this rule. Nothing was changed."), stale: false });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SideSheet
      title="Make this a rule"
      subtitle={
        <span title={theme.label} className="selectable line-clamp-2">
          {theme.label}
        </span>
      }
      onClose={onClose}
      width={600}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} onClick={save}>
            {saving ? "Saving" : "Save rule"}
          </Button>
        </div>
      }
    >
      <div className="px-6 py-4">
        {loadError ? (
          <ErrorBlock title="Could not prepare this rule" message={loadError} onRetry={load} />
        ) : !sheet ? (
          <div aria-label="Loading" className="space-y-3">
            <Skeleton className="h-14" />
            <Skeleton className="h-14" />
            <Skeleton className="h-28" />
          </div>
        ) : (
          <>
            <fieldset>
              <legend className="mb-2 text-body font-semibold text-ink">Where should it go</legend>
              <div className="space-y-2">
                {sheet.targets.map((t) => (
                  <label
                    key={t.id}
                    className={`team-target flex items-start gap-3 rounded-control border px-3 py-2.5 ${
                      t.blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:bg-raised"
                    } ${targetId === t.id ? "border-accent bg-accent-tint" : "border-line"}`}
                  >
                    <input
                      type="radio"
                      name={radioName}
                      value={t.id}
                      checked={targetId === t.id}
                      disabled={!!t.blocked}
                      onChange={() => {
                        setTargetId(t.id);
                        setProblem(null);
                      }}
                      className="mt-1 accent-[var(--accent-solid)]"
                    />
                    {/* The name in words, then where it is: a long path wraps, it is never cut mid-word. */}
                    <span className="min-w-0 flex-1">
                      <span title={targetTitle(t)} className="block truncate text-body font-medium text-ink">
                        {targetTitle(t)}
                      </span>
                      <span className="selectable block text-caption text-ink-2 [overflow-wrap:anywhere]">{t.path}</span>
                      {t.blocked && <span className="block text-caption text-warning">{t.blocked}</span>}
                      {!t.exists && !t.blocked && t.kind !== "file" && <span className="block text-caption text-ink-2">This file is created</span>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {target && (
              <div className="mt-4">
                <label htmlFor={`${radioName}-text`} className="mb-1.5 block text-body font-semibold text-ink">
                  {target.kind === "file" ? "The file" : "The line"}
                </label>
                {target.kind === "file" ? (
                  <textarea
                    id={`${radioName}-text`}
                    value={text}
                    disabled={!!target.blocked}
                    rows={6}
                    spellCheck={false}
                    onChange={(e) => setDrafts((d) => ({ ...d, [target.id]: e.target.value }))}
                    className="selectable team-draft w-full resize-y rounded-control border border-line-strong bg-surface px-3 py-2 font-mono text-body text-ink"
                  />
                ) : (
                  <>
                    <LineField
                      id={`${radioName}-text`}
                      value={text}
                      disabled={!!target.blocked}
                      describedBy={`${radioName}-hint`}
                      onChange={(v) => setDrafts((d) => ({ ...d, [target.id]: v }))}
                      onEnter={() => void save()}
                    />
                    <p id={`${radioName}-hint`} className="mt-1 text-caption text-ink-2">
                      One line that starts with a dash. It goes under "Caught in review".
                    </p>
                  </>
                )}
              </div>
            )}

            {target && target.kind === "line" && target.preview && target.preview.length > 0 && <Preview lines={target.preview} rule={text} />}

            {problem && (
              <p role="alert" className="mt-3 flex items-start gap-2 rounded-card bg-warning-tint px-4 py-3 text-body text-warning">
                <WarningCircle size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1 break-words">{problem.text}</span>
                {problem.stale && (
                  <Button className="shrink-0" onClick={load}>
                    Reload
                  </Button>
                )}
              </p>
            )}
          </>
        )}
      </div>
    </SideSheet>
  );
}
