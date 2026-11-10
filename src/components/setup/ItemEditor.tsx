import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Lock } from "@phosphor-icons/react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { TextEditor } from "./TextEditor";
import { getBackend } from "../../lib/ipc";
import { readField, setField } from "../../lib/frontmatter";
import { errorText } from "../../lib/setup-actions";
import { displayName, KIND_BY_ID } from "../../lib/setup-model";
import type { RawEdit, SetupItem, SkillFile } from "../../lib/setup-types";
import { reloadSetup } from "../../state/setupStore";
import { pushToast } from "../../state/toastStore";

const FIELD_INPUT =
  "h-8 w-full min-w-0 rounded-control border border-line-strong bg-surface px-2.5 text-body text-ink outline-none focus:border-ink-2 disabled:cursor-default disabled:text-ink-2";

/** The header's name and description as fields; they read and change the same text the editor holds. */
function HeaderFields({ item, text, setText }: { item: SetupItem; text: string; setText: (next: string) => void }) {
  const desc = readField(text, "description");
  const name = item.kind === "skill" ? readField(text, "name") : null;
  if (!desc?.single && !name) return null;
  return (
    <div className="grid grid-cols-[96px_1fr] items-center gap-x-3 gap-y-2" data-header-fields>
      {name && (
        <>
          <label htmlFor="hf-name" className="text-body text-ink-2">
            Name
          </label>
          <input id="hf-name" className={`${FIELD_INPUT} mono`} value={name.value} disabled readOnly title="A skill's name is its folder name" />
        </>
      )}
      {desc?.single && (
        <>
          <label htmlFor="hf-desc" className="text-body text-ink-2">
            Description
          </label>
          <input
            id="hf-desc"
            className={FIELD_INPUT}
            value={desc.value}
            spellCheck
            onChange={(e) => {
              const next = setField(text, "description", e.target.value);
              if (next !== null) setText(next);
            }}
          />
        </>
      )}
    </div>
  );
}

/** One tab per file of a skill: SKILL.md first, then whatever comes with it. */
function FileTabs({ files, current, onPick }: { files: SkillFile[]; current: string | undefined; onPick: (rel: string | undefined) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.max(
    0,
    files.findIndex((f) => (current === undefined ? f.main : f.rel === current)),
  );
  const move = (to: number) => {
    const next = (to + files.length) % files.length;
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label="Files in this skill" className="flex min-w-0 flex-wrap gap-1 border-b border-line pb-2">
      {files.map((f, i) => {
        const on = i === at;
        return (
          <button
            key={f.rel}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            aria-selected={on}
            tabIndex={on ? 0 : -1}
            disabled={!f.editable}
            title={f.editable ? f.rel : `${f.rel} cannot be edited here`}
            onClick={() => onPick(f.main ? undefined : f.rel)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") (e.preventDefault(), move(i + 1));
              else if (e.key === "ArrowLeft") (e.preventDefault(), move(i - 1));
            }}
            className={`press mono inline-flex h-7 max-w-[220px] cursor-pointer items-center rounded-control px-2.5 text-body disabled:cursor-default disabled:opacity-50 ${
              on ? "bg-raised font-medium text-ink" : "text-ink-2 hover:bg-raised hover:text-ink"
            }`}
          >
            <span className="truncate">{f.rel}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Edit one item's text. Save = backup, atomic write, read back. If the file
 * changed on disk since it was opened, Will chooses instead of losing either side.
 * Saving keeps the editor open on the same file; a skill's other files are one tab away.
 */
export function ItemEditor({
  item,
  initialFile,
  onCancel,
  onDirtyChange,
}: {
  item: SetupItem;
  /** Start on a supporting file instead of the item's main one. */
  initialFile?: string;
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [file, setFile] = useState<string | undefined>(initialFile);
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [raw, setRaw] = useState<RawEdit | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [conflict, setConflict] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [switchTo, setSwitchTo] = useState<{ rel: string | undefined } | null>(null);

  const load = useCallback(
    async (reveal: boolean) => {
      try {
        const r = await getBackend().setupItemRaw(item.id, reveal, file);
        setRaw(r);
        setError(null);
        setVersion((v) => v + 1);
      } catch (e) {
        setError(errorText(e, "Atlas could not open that file."));
      }
    },
    [item.id, file],
  );

  useEffect(() => {
    setRaw(null);
    void load(false);
  }, [load]);

  // A skill's own files, for the tabs (the main file is always first).
  useEffect(() => {
    if (item.kind !== "skill") return;
    let alive = true;
    getBackend()
      .setupSkillFiles(item.id)
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]));
    return () => {
      alive = false;
    };
  }, [item.id]);

  const changeDirty = (d: boolean) => {
    setDirty(d);
    onDirtyChange(d);
  };

  const pick = (rel: string | undefined) => {
    if (rel === file) return;
    if (dirty) setSwitchTo({ rel });
    else {
      setRevealed(false);
      setFile(rel);
    }
  };

  const label = file ? `${item.name}/${file}` : displayName(item);

  const save = async (text: string, force: boolean) => {
    if (!raw) return;
    const reply = await getBackend().setupSave(item.id, text, raw.stamp, force, file);
    if (reply.status === "conflict") {
      setConflict(text);
      return;
    }
    // Stay here: what was saved is now the starting point, so the editor reads clean again.
    setRaw({ ...raw, text, stamp: reply.stamp ?? raw.stamp });
    pushToast({ message: `Saved ${label}.`, tone: "success" });
    reloadSetup();
  };

  if (error && !raw) {
    return (
      <div className="px-6 py-4">
        <p role="alert" className="rounded-control bg-danger-tint px-3 py-2 text-body text-danger">
          {error}
        </p>
        <div className="mt-3 flex justify-end">
          <Button onClick={onCancel}>Close</Button>
        </div>
      </div>
    );
  }

  const tabs = files.length > 1 ? <FileTabs files={files} current={file} onPick={pick} /> : null;

  if (!raw)
    return (
      <div className="flex flex-col gap-3 px-6 py-4">
        {tabs}
        <div role="status" aria-label="Opening the editor" className="skeleton h-64 rounded-card" />
      </div>
    );

  if (raw.needsReveal) {
    return (
      <div className="px-6 py-4">
        <div className="rounded-card border border-line bg-surface p-5">
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
              <Lock size={18} aria-hidden="true" />
            </span>
            <div>
              <h3 className="text-lead font-semibold text-ink">This {KIND_BY_ID[item.kind].singular} holds secret values</h3>
              <p className="mt-1 text-body text-ink-2">
                Keys and tokens are kept out of sight everywhere in Atlas. To edit the file you need the real text, so Atlas has to show it. It is not saved
                or logged anywhere else.
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={onCancel}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setRevealed(true);
                void load(true);
              }}
            >
              <Eye size={14} aria-hidden="true" />
              Show secrets and edit
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
      {tabs}
      {revealed && (
        <p role="note" className="flex items-center gap-2 rounded-control bg-warning-tint px-3 py-2 text-body text-warning">
          <Eye size={14} aria-hidden="true" />
          Secret values are showing while you edit.
        </p>
      )}
      <TextEditor
        key={version}
        initial={raw.text}
        language={raw.language}
        label={file ? `Editing ${item.name} ${file}` : `Editing ${displayName(item)}`}
        validate={(t) => getBackend().setupValidate(item.id, t, file)}
        onSubmit={(t) => save(t, false)}
        onCancel={onCancel}
        onDirtyChange={changeDirty}
        above={file === undefined && raw.language === "markdown" ? (api) => <HeaderFields item={item} {...api} /> : undefined}
      />
      {switchTo && (
        <Dialog
          alert
          title="Discard your changes?"
          onClose={() => setSwitchTo(null)}
          footer={
            <>
              <Button autoFocus onClick={() => setSwitchTo(null)}>
                Keep editing
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const to = switchTo.rel;
                  setSwitchTo(null);
                  setRevealed(false);
                  setFile(to);
                }}
              >
                Discard
              </Button>
            </>
          }
        >
          <p className="text-body text-ink">You have edits to {label} that are not saved. If you switch files now they are lost.</p>
        </Dialog>
      )}
      {conflict !== null && (
        <Dialog
          alert
          title="This file changed on your computer"
          onClose={() => setConflict(null)}
          footer={
            <>
              <Button autoFocus disabled={busy} onClick={() => setConflict(null)}>
                Keep editing
              </Button>
              <Button
                disabled={busy}
                onClick={async () => {
                  setConflict(null);
                  await load(revealed);
                }}
              >
                Load the new version
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const text = conflict;
                    setConflict(null);
                    await save(text, true);
                  } catch (e) {
                    pushToast({ message: errorText(e, "Atlas could not save that."), tone: "error" });
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Replace with mine
              </Button>
            </>
          }
        >
          <p className="text-body text-ink">
            Something else changed {label} after you opened it. Your edits and the newer version are different.
          </p>
          <p className="mt-2">
            Load the new version to see it (your edits here are dropped), or replace it with yours. Atlas keeps a backup of the file either way.
          </p>
        </Dialog>
      )}
    </div>
  );
}
