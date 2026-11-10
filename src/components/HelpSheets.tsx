import { useState } from "react";
import type { ComponentType, ReactNode } from "react";
import { Eye, Globe, PencilSimple } from "@phosphor-icons/react";
import type { IconProps } from "@phosphor-icons/react";
import { Dialog } from "./Dialog";
import { Button } from "./controls";
import { NAV } from "./Sidebar";
import { shortcutGroups } from "../lib/appMenu";
import type { SheetId } from "../lib/appMenu";
import { useAtlas } from "../state/AtlasProvider";
import type { Platform, View } from "../lib/types";

const PLATFORM_NAME: Record<Platform, string> = { windows: "Windows", macos: "macOS", linux: "Linux" };

function Para({ children }: { children: ReactNode }) {
  return <p className="selectable mb-3 last:mb-0">{children}</p>;
}

/** A short, scannable list: an icon you can tell at a glance, a name, and one line. Never a paragraph. */
function Points({ items }: { items: { icon: ComponentType<IconProps>; title: string; text: ReactNode }[] }) {
  return (
    <ul className="selectable m-0 flex list-none flex-col gap-3 p-0">
      {items.map(({ icon: Icon, title, text }) => (
        <li key={title} className="flex items-start gap-3">
          <Icon size={18} aria-hidden="true" className="mt-px shrink-0 text-ink" />
          <div className="min-w-0">
            <div className="font-semibold text-ink">{title}</div>
            <div>{text}</div>
          </div>
        </li>
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
    ["Build", info.build === "release" ? "Release" : "Debug"],
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

/** One line each, so the sheet is read at a glance. Keyed by the sidebar's own views: the row shows that page's icon and name. */
const GUIDE: Partial<Record<View, string>> = {
  dashboard: "Your week at a glance: tokens, cost and streak.",
  now: "Chats that are running, waiting for you or just finished.",
  sessions: "Every conversation. Search, filter, and open one to read it.",
  setup: "Your skills, agents and commands. Every edit keeps a backup.",
  history: "Every change to your Claude files, with the lines that changed.",
  settings: "The theme, your Claude folder, and Sandbox mode.",
  wrapped: "Your year with Claude, told as a short story.",
};

function Guide({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="How to use Atlas" onClose={onClose} width={520} footer={<Close onClose={onClose} />}>
      <Points
        items={NAV.filter((n) => GUIDE[n.view]).map((n) => ({ icon: n.icon, title: n.label, text: GUIDE[n.view] }))}
      />
      <p className="selectable mt-4 text-caption">Hover any chart for the exact numbers. Keyboard shortcuts are under Help.</p>
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
            {/* One key column for every group, so the right-hand column starts on one line down the sheet. */}
            <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-6 gap-y-2">
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
      {/* Every word here was checked against the Rust side (update.rs, library.rs, setup/files.rs, connect.rs). Keep it that way. */}
      <Para>Atlas has no account, no analytics and no crash reports.</Para>
      <Points
        items={[
          { icon: Eye, title: "Reads", text: "Your Claude folder, and the Claude files inside your projects." },
          { icon: PencilSimple, title: "Writes", text: "Its own data, what you change in your Claude files (backed up first), and the entry that connects Claude Code to Atlas." },
          { icon: Globe, title: "Goes online", text: "Only to look for a new version, and to load the Library and what you install from it. Atlas sends none of your chats or files." },
        ]}
      />
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
