import { useEffect, useRef, useState } from "react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { Chip } from "../setup/parts";
import { ItemChecklist, itemKey } from "./ItemChecklist";
import { SafetyCheck } from "./SafetyCheck";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import { INSTALLED, installSummary, mpId, parseGithub, readingWords } from "../../lib/library";
import type { LibraryDetail, LibraryProgress } from "../../lib/libraryTypes";
import { adoptCatalog, reloadInstalled, setSource } from "../../state/libraryStore";
import { pushToast } from "../../state/toastStore";

type Phase = { t: "idle" } | { t: "checking"; repo: string } | { t: "error"; message: string } | { t: "result"; detail: LibraryDetail } | { t: "working"; detail: LibraryDetail };

/** Paste a GitHub link: Atlas reads it, says what it holds and how it checked out, then adds it. */
export function AddFromGitHub({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ t: "idle" });
  const [progress, setProgress] = useState<LibraryProgress | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const repo = parseGithub(text);

  useEffect(() => {
    let off = () => {};
    let dead = false;
    getBackend()
      .onLibraryProgress(setProgress)
      .then((u) => (dead ? u() : (off = u)))
      .catch(() => {});
    return () => {
      dead = true;
      off();
    };
  }, []);

  const check = async () => {
    if (!repo || phase.t === "checking") return;
    setPhase({ t: "checking", repo });
    setProgress(null);
    try {
      const detail = await getBackend().libraryInspectLink(text.trim());
      const taken = new Set(detail.taken.map((t) => `${t.kind}:${t.name}`));
      setTicked(new Set(detail.inspected.shaped.items.filter((i) => !taken.has(`${i.kind}:${i.name}`)).map(itemKey)));
      setPhase({ t: "result", detail });
    } catch (e) {
      setPhase({ t: "error", message: errorText(e, "Atlas could not read that link.") });
    }
  };

  const cancel = () => {
    if (phase.t === "checking") void getBackend().libraryCancel();
    onClose();
  };

  const detail = phase.t === "result" || phase.t === "working" ? phase.detail : null;
  const shaped = detail?.inspected.shaped;
  const count = shaped ? shaped.items.filter((i) => ticked.has(itemKey(i))).length : 0;

  const addMarketplace = async () => {
    if (!detail) return;
    setPhase({ t: "working", detail });
    try {
      const done = await getBackend().libraryAddMarketplace(detail.token);
      adoptCatalog(done.catalog);
      setSource(mpId(done.name));
      pushToast({ message: `Added ${done.name}.`, tone: "success" });
      onClose();
    } catch (e) {
      setPhase({ t: "error", message: errorText(e, "Atlas could not add that. Nothing changed.") });
    }
  };

  const installItems = async () => {
    if (!detail || !shaped || count === 0) return;
    setPhase({ t: "working", detail });
    try {
      const picks = shaped.items.filter((i) => ticked.has(itemKey(i))).map((i) => ({ kind: i.kind, name: i.name }));
      const results = await getBackend().libraryInstallItems(detail.token, picks);
      await reloadInstalled();
      setSource(INSTALLED);
      pushToast({ message: installSummary(results), tone: results.every((r) => r.ok) ? "success" : "info" });
      onClose();
    } catch (e) {
      setPhase({ t: "error", message: errorText(e, "Atlas could not install that. Nothing changed.") });
    }
  };

  let primary: { label: string; onClick: () => void; disabled: boolean } = { label: "Check", onClick: () => void check(), disabled: !repo || phase.t === "checking" };
  if (shaped?.shape === "marketplace") primary = { label: "Add this marketplace", onClick: () => void addMarketplace(), disabled: false };
  else if (shaped && shaped.shape !== "nothing") primary = { label: `Install ${count} ${count === 1 ? "item" : "items"}`, onClick: () => void installItems(), disabled: count === 0 };
  if (phase.t === "working") primary = { label: "Working...", onClick: () => {}, disabled: true };

  return (
    <Dialog
      title="Add from GitHub"
      width={520}
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>Cancel</Button>
          <Button variant="primary" disabled={primary.disabled} onClick={primary.onClick}>
            {primary.label}
          </Button>
        </>
      }
    >
      <form
        // One column that may shrink: a long name is cut or wrapped, it never widens the dialog.
        className="grid grid-cols-[minmax(0,1fr)] gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!detail) void check();
        }}
      >
        <label className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
          <span className="text-body text-ink-2">A link to a repository with skills, agents, commands or plugins</span>
          <input
            ref={input}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (phase.t !== "idle" && phase.t !== "checking") setPhase({ t: "idle" });
            }}
            placeholder="github.com/owner/repo"
            spellCheck={false}
            autoComplete="off"
            className="selectable mono h-9 min-w-0 rounded-control border border-line-strong bg-surface px-3 text-body text-ink outline-none focus-visible:border-accent"
          />
        </label>

        {phase.t === "checking" && (
          <p role="status" className="text-body text-ink-2">
            {readingWords(phase.repo, progress?.downloaded ?? 0)}
          </p>
        )}
        {phase.t === "error" && (
          <p role="alert" className="break-words text-body text-ink">
            {phase.message}
          </p>
        )}

        {detail && shaped && (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            {shaped.shape === "nothing" && (
              <p role="status" className="break-words text-body text-ink">
                Atlas found nothing it can install in {detail.repo}.
              </p>
            )}
            {shaped.shape === "marketplace" && (
              <>
                <p className="break-words text-body text-ink">
                  <span className="font-semibold">{shaped.name}</span> is a marketplace with {shaped.plugins.length} {shaped.plugins.length === 1 ? "plugin" : "plugins"}.
                </p>
                <ul className="grid max-h-48 grid-cols-[minmax(0,1fr)] gap-1 overflow-y-auto">
                  {shaped.plugins.map((p) => (
                    <li key={p.name} className="min-w-0 rounded-control bg-raised px-3 py-1.5">
                      <div title={p.name} className="truncate text-body font-medium text-ink">
                        {p.name}
                      </div>
                      {p.description && (
                        <div title={p.description} className="truncate text-caption text-ink-2">
                          {p.description}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-caption text-ink-2">Adding it lists these in the Library. Nothing is installed until you pick one.</p>
              </>
            )}
            {(shaped.shape === "plugin" || shaped.shape === "loose") && (
              <>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span title={shaped.name} className="min-w-0 max-w-full truncate text-body font-semibold text-ink">
                    {shaped.name}
                  </span>
                  <span className="flex min-w-0 max-w-full">
                    <Chip tone="muted" title={detail.repo}>
                      {detail.repo}
                    </Chip>
                  </span>
                </div>
                <ItemChecklist
                  items={shaped.items}
                  taken={detail.taken}
                  ticked={ticked}
                  onToggle={(k) =>
                    setTicked((s) => {
                      const n = new Set(s);
                      if (!n.delete(k)) n.add(k);
                      return n;
                    })
                  }
                />
              </>
            )}
            {shaped.shape !== "nothing" && <SafetyCheck report={detail.inspected.check} notInstalled={shaped.notInstalled} />}
          </div>
        )}
      </form>
    </Dialog>
  );
}
