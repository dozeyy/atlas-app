import { useCallback, useEffect, useId, useRef, useState } from "react";
import { WarningCircle } from "@phosphor-icons/react";
import { Button } from "../controls";
import { ErrorBlock, Skeleton } from "../usage/StateBlocks";
import { SideSheet } from "./SideSheet";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import { reloadSetup } from "../../state/setupStore";
import { pushToast } from "../../state/toastStore";
import type { ReviewTheme, RuleSheetData, RuleTarget } from "../../lib/teamTypes";

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
  const area = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(() => {
    setLoadError(null);
    backend
      .ruleSheet(theme.label, theme.projects)
      .then((s) => {
        setSheet(s);
        setDrafts(Object.fromEntries(s.targets.map((t) => [t.id, t.text])));
        setTargetId((cur) => (s.targets.some((t) => t.id === cur && !t.blocked) ? cur : (s.targets.find((t) => !t.blocked)?.id ?? "")));
        setProblem(null);
      })
      .catch((e) => setLoadError(errorText(e, "Atlas could not prepare this rule.")));
  }, [backend, theme.label, theme.projects]);

  useEffect(() => {
    load();
  }, [load]);

  const target: RuleTarget | undefined = sheet?.targets.find((t) => t.id === targetId);
  const text = target ? (drafts[target.id] ?? "") : "";
  const canSave = !!target && !target.blocked && text.trim().length > 0 && !saving;

  const save = async () => {
    if (!target || !canSave) return;
    setSaving(true);
    setProblem(null);
    try {
      const out = await backend.ruleSave({
        themeId: theme.id,
        label: theme.label,
        projects: theme.projects,
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
      pushToast({
        message: `Made a rule in ${target.kind === "file" ? "a new rule file" : "CLAUDE.md"}.`,
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
      subtitle={<span className="selectable">{theme.label}</span>}
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
                    <span className="min-w-0">
                      <span className="block text-body font-medium text-ink">{t.title}</span>
                      <span className="selectable block break-all text-caption text-ink-2">{t.path}</span>
                      {t.blocked && <span className="block text-caption text-warning">{t.blocked}</span>}
                      {!t.exists && !t.blocked && <span className="block text-caption text-ink-2">{t.kind === "file" ? "A new file" : "This file is created"}</span>}
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
                <textarea
                  id={`${radioName}-text`}
                  ref={area}
                  value={text}
                  disabled={!!target.blocked}
                  rows={target.kind === "file" ? 6 : 3}
                  spellCheck={false}
                  onChange={(e) => setDrafts((d) => ({ ...d, [target.id]: e.target.value }))}
                  className="selectable team-draft w-full resize-y rounded-control border border-line-strong bg-surface px-3 py-2 font-mono text-body text-ink"
                />
              </div>
            )}

            {problem && (
              <p role="alert" className="mt-3 flex items-start gap-2 rounded-card bg-warning-tint px-4 py-3 text-body text-warning">
                <WarningCircle size={16} weight="fill" aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0 flex-1">{problem.text}</span>
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
