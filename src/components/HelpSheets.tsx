import { useState } from "react";
import type { ReactNode } from "react";
import { Dialog } from "./Dialog";
import { Button } from "./controls";
import { shortcutGroups } from "../lib/appMenu";
import type { SheetId } from "../lib/appMenu";
import { useAtlas } from "../state/AtlasProvider";
import type { Platform } from "../lib/types";

const PLATFORM_NAME: Record<Platform, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

function Para({ children }: { children: ReactNode }) {
  return <p className="selectable mb-3 last:mb-0">{children}</p>;
}

function List({ items }: { items: ReactNode[] }) {
  return (
    <ul className="selectable mb-3 flex list-disc flex-col gap-1.5 pl-5 last:mb-0">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function Close({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="primary" onClick={onClose}>
      Close
    </Button>
  );
}

/** The one place the sheets from Help > ... are chosen, so the menu only names an id. */
export function HelpSheet({ id, onClose }: { id: SheetId; onClose: () => void }) {
  switch (id) {
    case "about":
      return <About onClose={onClose} />;
    case "guide":
      return <Guide onClose={onClose} />;
    case "shortcuts":
      return <Shortcuts onClose={onClose} />;
    case "privacy":
      return <Privacy onClose={onClose} />;
    case "terms":
      return <Terms onClose={onClose} />;
    case "report":
      return <Report onClose={onClose} />;
  }
}

function About({ onClose }: { onClose: () => void }) {
  const { info } = useAtlas();
  const rows: [string, string][] = [
    ["Version", info.version],
    ["Build", info.build],
    ["System", PLATFORM_NAME[info.platform]],
    ["Licence", "Proprietary. Not licensed for redistribution."],
  ];
  return (
    <Dialog title="About Atlas" onClose={onClose} width={420} footer={<Close onClose={onClose} />}>
      <Para>Atlas shows how you use Claude Code: your sessions, your spending, and the skills and agents you have set up. It works from the files already on this computer.</Para>
      <dl className="selectable mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-2">{k}</dt>
            <dd className="text-ink">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="How to use Atlas" onClose={onClose} width={520} footer={<Close onClose={onClose} />}>
      <List
        items={[
          <>
            <b className="font-semibold text-ink">Dashboard</b> is the week at a glance: tokens, the estimated cost, your streak, and which models and projects took the most. Hover or arrow through any chart for the exact numbers.
          </>,
          <>
            <b className="font-semibold text-ink">Sessions</b> lists every conversation. Search by title or project, narrow it with Filters, and open one to read it with the helpers it started.
          </>,
          <>
            <b className="font-semibold text-ink">Toolkit</b> holds what you have set up for Claude: skills, agents, commands and the rest. Open a type to read, edit or remove an item. Removing asks first and keeps a backup, so Undo works.
          </>,
          <>
            <b className="font-semibold text-ink">Settings</b> picks the theme and which Claude folder Atlas reads. Sandbox mode works on a copy, so nothing real changes while you try things.
          </>,
        ]}
      />
      <Para>The sidebar folds to icons with the button next to the menu. Keyboard shortcuts are under Help.</Para>
    </Dialog>
  );
}

function Shortcuts({ onClose }: { onClose: () => void }) {
  const { info } = useAtlas();
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} width={560} footer={<Close onClose={onClose} />}>
      <div className="flex flex-col gap-5">
        {shortcutGroups(info.platform).map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h3 className="mb-2 text-caption font-semibold uppercase tracking-wide text-ink-2">{g.title}</h3>
            <dl className="grid grid-cols-[minmax(0,auto)_1fr] gap-x-6 gap-y-2">
              {g.rows.map((r) => (
                <div key={r.keys} className="contents">
                  <dt>
                    <kbd className="whitespace-nowrap rounded-[4px] border border-line bg-raised px-1.5 py-0.5 text-caption text-ink-2">{r.keys}</kbd>
                  </dt>
                  <dd className="text-ink">{r.does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function Privacy({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Privacy" onClose={onClose} width={520} footer={<Close onClose={onClose} />}>
      <Para>Atlas works only on this computer. It makes no network connections and has no account, no analytics and no crash reporting.</Para>
      <List
        items={[
          <>
            <b className="font-semibold text-ink">What it reads:</b> the Claude folder you point it at (your session files, settings, skills, agents and commands). Nothing outside that folder is read.
          </>,
          <>
            <b className="font-semibold text-ink">What it writes:</b> its own settings and a cache in its data folder, and, only when you ask in the Toolkit, the item you edited or removed. A backup copy is made first.
          </>,
          <>
            <b className="font-semibold text-ink">What it sends:</b> nothing. The window is not allowed to load anything from the internet.
          </>,
        ]}
      />
      <Para>Sandbox mode (Settings) reads a copy of your folder instead, so your real files are never touched.</Para>
    </Dialog>
  );
}

function Terms({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Terms of service" onClose={onClose} width={520} footer={<Close onClose={onClose} />}>
      <Para>Atlas is provided as it is, with no warranty. Use it at your own risk. Cost figures are estimates from the usage in your files, not a bill.</Para>
      <Para>Atlas changes your files only when you ask it to, and keeps a backup first. Keep your own backups of anything you cannot lose.</Para>
      <Para>Atlas is not licensed for redistribution. It is not made by or affiliated with Anthropic; Claude is a trademark of Anthropic.</Para>
      <Para>These terms are a placeholder until Atlas has a published licence.</Para>
    </Dialog>
  );
}

function Report({ onClose }: { onClose: () => void }) {
  const { info, openDataDir } = useAtlas();
  const [copied, setCopied] = useState(false);
  const details = [
    `Atlas ${info.version} (${info.build})`,
    PLATFORM_NAME[info.platform],
    `Window ${window.innerWidth}x${window.innerHeight} at ${window.devicePixelRatio}x`,
  ].join("\n");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* the details are on screen and selectable */
    }
  };

  return (
    <Dialog
      title="Report a problem"
      onClose={onClose}
      width={480}
      footer={
        <>
          <Button onClick={() => void openDataDir()}>Open data folder</Button>
          <Button onClick={() => void copy()}>{copied ? "Copied" : "Copy details"}</Button>
          <Close onClose={onClose} />
        </>
      }
    >
      <Para>Atlas keeps no log files, so there is nothing to attach. Write down what you were doing and what happened, and include these details.</Para>
      <pre className="selectable rounded-control border border-line bg-raised px-3 py-2 font-mono text-caption text-ink">{details}</pre>
    </Dialog>
  );
}
