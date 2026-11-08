import { useEffect, useState } from "react";
import { Button } from "../controls";
import { Dialog } from "../Dialog";
import { TextEditor } from "./TextEditor";
import { getBackend } from "../../lib/ipc";
import { errorText } from "../../lib/setup-actions";
import type { CreateKind, Draft } from "../../lib/setup-types";
import { reloadSetup } from "../../state/setupStore";
import { pushToast } from "../../state/toastStore";

export const HOOK_EVENTS: { value: string; label: string }[] = [
  { value: "PostToolUse", label: "After a tool runs" },
  { value: "PreToolUse", label: "Before a tool runs" },
  { value: "UserPromptSubmit", label: "When you send a message" },
  { value: "Stop", label: "When Claude finishes" },
  { value: "SessionStart", label: "When a session starts" },
  { value: "Notification", label: "When Claude needs you" },
  { value: "SubagentStop", label: "When an agent finishes" },
  { value: "PreCompact", label: "Before the chat is trimmed" },
];

const NAME_HELP: Record<CreateKind, { label: string; placeholder: string; hint: string } | null> = {
  instructions: null,
  skill: { label: "Skill name", placeholder: "release-notes", hint: "Lowercase letters, numbers and dashes. This is also the folder name." },
  agent: { label: "Agent name", placeholder: "code-reviewer", hint: "Lowercase letters, numbers and dashes." },
  command: { label: "Command name", placeholder: "standup", hint: "You will type it as /name." },
  rule: { label: "Rule name", placeholder: "typescript", hint: "Lowercase letters, numbers and dashes." },
  outputStyle: { label: "Style name", placeholder: "calm-notes", hint: "Lowercase letters, numbers and dashes." },
  hook: null,
  mcpServer: { label: "Server name", placeholder: "github", hint: "Letters, numbers and dashes." },
};

const WHAT: Record<CreateKind, string> = {
  instructions: "your global CLAUDE.md",
  skill: "skill",
  agent: "agent",
  command: "command",
  rule: "rule",
  outputStyle: "output style",
  hook: "hook",
  mcpServer: "MCP server",
};

/**
 * A new item in two steps: a name (when it needs one), then the text from a
 * template in the editor. Nothing is written until Create, and Atlas never
 * overwrites something that already exists.
 */
export function CreateFlow({ kind, onClose }: { kind: CreateKind; onClose: () => void }) {
  const help = NAME_HELP[kind];
  const needsAsk = help !== null || kind === "hook";
  const [step, setStep] = useState<"ask" | "edit">(needsAsk ? "ask" : "edit");
  const [name, setName] = useState("");
  const [event, setEvent] = useState("PostToolUse");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);

  const ev = kind === "hook" ? event : undefined;
  const backend = getBackend();

  // The editor step can start straight away when nothing needs naming.
  useEffect(() => {
    if (needsAsk) return;
    let alive = true;
    backend
      .setupCreateDraft(kind, "", undefined)
      .then((d) => alive && setDraft(d))
      .catch((e) => alive && setError(errorText(e, "Atlas could not start that.")));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, needsAsk]);

  const next = async () => {
    setBusy(true);
    setError(null);
    try {
      setDraft(await backend.setupCreateDraft(kind, name.trim(), ev));
      setStep("edit");
    } catch (e) {
      setError(errorText(e, "Atlas could not start that."));
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => (step === "edit" && dirty ? setDiscard(true) : onClose());
  const title = kind === "instructions" ? "Write your global CLAUDE.md" : `New ${WHAT[kind]}`;

  return (
    <Dialog
      title={title}
      width={step === "edit" ? 780 : 480}
      onClose={requestClose}
      closeOnScrim={false}
      footer={
        step === "ask" ? (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={() => void next()} disabled={busy || (help !== null && name.trim() === "")}>
              Continue
            </Button>
          </>
        ) : undefined
      }
    >
      {step === "ask" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy && (help === null || name.trim() !== "")) void next();
          }}
          className="space-y-4"
        >
          {help && (
            <label className="block">
              <span className="text-body font-medium text-ink">{help.label}</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={help.placeholder}
                spellCheck={false}
                autoComplete="off"
                className="selectable mt-1.5 h-9 w-full rounded-control border border-line-strong bg-surface px-3 text-body text-ink placeholder:text-ink-2"
              />
              <span className="mt-1 block text-caption text-ink-2">{help.hint}</span>
            </label>
          )}
          {kind === "hook" && (
            <label className="block">
              <span className="text-body font-medium text-ink">When should it run?</span>
              <select
                value={event}
                onChange={(e) => setEvent(e.target.value)}
                className="mt-1.5 h-9 w-full cursor-pointer rounded-control border border-line-strong bg-surface px-2 text-body text-ink"
              >
                {HOOK_EVENTS.map((h) => (
                  <option key={h.value} value={h.value}>
                    {h.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-body text-ink-2">
            Next you will see a starting text to change. Nothing is written until you press Create, and Atlas never replaces something you already have.
          </p>
          {error && (
            <p role="alert" className="rounded-control bg-danger-tint px-3 py-2 text-body text-danger">
              {error}
            </p>
          )}
          <button type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />
        </form>
      ) : draft ? (
        <div className="flex flex-col gap-2">
          <p className="text-body text-ink-2">
            Goes in <span className="mono selectable break-all text-ink">{draft.whereNote || draft.path}</span>
          </p>
          <TextEditor
            initial={draft.text}
            language={draft.language}
            label={`New ${WHAT[kind]}`}
            requireChange={false}
            submitLabel="Create"
            validate={(t) => backend.setupValidateDraft(kind, draft.name, ev, t)}
            onSubmit={async (t) => {
              const out = await backend.setupCreate(kind, draft.name, ev, t);
              pushToast({ message: `Created ${out.name}.`, tone: "success" });
              reloadSetup();
              onClose();
            }}
            onCancel={requestClose}
            onDirtyChange={setDirty}
            hint="Nothing is written until you press Create."
          />
        </div>
      ) : error ? (
        <p role="alert" className="rounded-control bg-danger-tint px-3 py-2 text-body text-danger">
          {error}
        </p>
      ) : (
        <div role="status" aria-label="Preparing" className="skeleton h-40 rounded-card" />
      )}
      {discard && (
        <Dialog
          alert
          title="Discard what you wrote?"
          onClose={() => setDiscard(false)}
          footer={
            <>
              <Button autoFocus onClick={() => setDiscard(false)}>
                Keep writing
              </Button>
              <Button variant="danger" onClick={onClose}>
                Discard
              </Button>
            </>
          }
        >
          <p className="text-body text-ink">Nothing has been created yet, so leaving now throws this text away.</p>
        </Dialog>
      )}
    </Dialog>
  );
}
