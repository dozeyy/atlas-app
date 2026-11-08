import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MapTrifold, Minus, Plus } from "@phosphor-icons/react";
import { Button, Card, IconButton, PageTitle, Row, Toggle } from "../components/controls";
import { Dialog } from "../components/Dialog";
import { ThemePicker } from "../components/ThemePicker";
import { useAtlas } from "../state/AtlasProvider";
import { pushToast } from "../state/toastStore";
import { getBackend } from "../lib/ipc";
import { describeSource, formatBytes } from "../lib/labels";
import { agoText } from "../lib/historyModel";
import { plural } from "../lib/usage";
import { prefersReducedMotion } from "../lib/motion";
import { useFetched, useUsageStatus } from "../lib/useUsage";
import { useWidth } from "../lib/useWidth";

const WIDE_AT = 760;
const KEEP_MIN = 10;
const KEEP_MAX = 200;
const KEEP_STEP = 10;

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "folder", label: "Claude folder" },
  { id: "data", label: "Your data" },
  { id: "history", label: "History" },
  { id: "about", label: "About" },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

function Section({ id, title, children }: { id: SectionId; title: string; children: ReactNode }) {
  return (
    <section id={`st-${id}`} aria-labelledby={`st-${id}-h`} className="st-section">
      <h2 id={`st-${id}-h`} className="d d-figure mb-3 text-ink">
        {title}
      </h2>
      <Card>{children}</Card>
    </section>
  );
}

function Path({ children }: { children: string }) {
  return <code className="selectable break-all text-ink">{children}</code>;
}

/** Fewer / more with the number between. Steps of ten, never outside the range. */
function Stepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  return (
    <div className="st-step" role="group" aria-label="Versions kept">
      <IconButton aria-label="Keep fewer versions" disabled={value <= KEEP_MIN} onClick={() => onChange(Math.max(KEEP_MIN, value - KEEP_STEP))}>
        <Minus size={14} aria-hidden="true" />
      </IconButton>
      <span className="st-step-value text-body font-medium text-ink" aria-live="polite">
        {value}
      </span>
      <IconButton aria-label="Keep more versions" disabled={value >= KEEP_MAX} onClick={() => onChange(Math.min(KEEP_MAX, value + KEEP_STEP))}>
        <Plus size={14} aria-hidden="true" />
      </IconButton>
    </div>
  );
}

/**
 * Settings is the calm page: no charts, no count-ups, no springs. It is also the ONE place the
 * Claude folder is shown (path, Open folder, override); Dashboard and Sessions never show it.
 */
export function Settings() {
  const {
    info,
    setTheme,
    setLaunchAnimation,
    setCloseToTray,
    setHistoryKeep,
    setSandbox,
    chooseConfigDir,
    clearConfigDir,
    openConfigDir,
    openDataDir,
  } = useAtlas();
  const backend = getBackend();
  const cfg = info.config;
  const sb = info.sandbox;
  const usingChosen = info.settings.configDirOverride !== null;
  const { status } = useUsageStatus();

  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const wide = width === 0 || width >= WIDE_AT;

  const keep = info.settings.historyKeepVersions;
  const overview = useFetched(() => backend.settingsOverview(), [backend, cfg?.dir, keep]);
  const price = useFetched(() => backend.pricingGet(), [backend]);
  const reloadOverview = overview.reload;

  // History moved on: re-read the store size without blanking the numbers.
  useEffect(() => {
    let off: (() => void) | undefined;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    backend
      .onHistoryChanged(() => {
        clearTimeout(timer);
        timer = setTimeout(() => reloadOverview(true), 400);
      })
      .then((fn) => (dead ? fn() : (off = fn)))
      .catch(() => {});
    return () => {
      dead = true;
      clearTimeout(timer);
      off?.();
    };
  }, [backend, reloadOverview]);

  const ov = overview.data;
  const [active, setActive] = useState<SectionId>("appearance");
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [busy, setBusy] = useState<"changed" | "full" | null>(null);

  // Which section is in view, so the rail follows the page.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined" || !root.current) return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.boundingClientRect.top : Infinity);
        let best: string | null = null;
        let at = Infinity;
        seen.forEach((top, id) => {
          if (top !== Infinity && Math.abs(top) < at) {
            at = Math.abs(top);
            best = id;
          }
        });
        if (best) setActive((best as string).slice(3) as SectionId);
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    root.current.querySelectorAll(".st-section").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [wide]);

  const go = (id: SectionId) => {
    setActive(id);
    document.getElementById(`st-${id}`)?.scrollIntoView?.({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  };

  const reindex = async (scope: "changed" | "full") => {
    setBusy(scope);
    try {
      await backend.usageReindex(scope);
      pushToast({ message: scope === "full" ? "Rebuilding from scratch. Numbers fill in as the files are read." : "Reading your logs again.", tone: "info" });
    } catch (e) {
      pushToast({ message: e instanceof Error ? e.message : "Could not start reading the logs.", tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const indexing = status?.state === "indexing";
  const hero = useMemo(() => {
    if (!cfg) return "Waiting for the sandbox copy of your Claude folder.";
    const parts: string[] = [];
    if (status && status.filesTracked > 0) parts.push(plural(status.filesTracked, "session log"));
    if (ov && ov.historyItems > 0) parts.push(plural(ov.historyItems, "setup file"));
    const what = parts.length ? `: ${parts.join(" and ")}` : "";
    return `Reading ${sb.enabled ? "a sandbox copy of " : ""}Claude Code's folder${what}. Everything stays on this computer.`;
  }, [cfg, sb.enabled, status, ov]);

  const nav = (
    <nav aria-label="Settings sections" className="st-nav" data-wide={wide ? "" : undefined}>
      {SECTIONS.map((s) => (
        <button key={s.id} type="button" className="st-nav-item text-body" aria-current={active === s.id ? "true" : undefined} onClick={() => go(s.id)}>
          {s.label}
        </button>
      ))}
    </nav>
  );

  const cleanup =
    ov?.cleanupDays != null
      ? `Claude Code keeps conversation logs for ${plural(ov.cleanupDays, "day")}.`
      : "Claude Code keeps conversation logs for its default of 30 days.";

  return (
    <div className="@container" ref={root}>
      <PageTitle title="Settings" />
      <div className={wide ? "grid grid-cols-[160px_minmax(0,1fr)] items-start gap-8" : "flex flex-col gap-4"}>
        {nav}
        <div className="flex min-w-0 flex-col gap-8">
          <div className="rise flex items-center gap-4 rounded-card border border-line bg-surface px-5 py-4" style={{ ["--i" as string]: 1 }}>
            <div className="flex size-12 shrink-0 items-center justify-center rounded-card border border-line bg-bg text-accent-text">
              <MapTrifold size={24} weight="duotone" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <div className="d d-figure text-ink">Atlas on this computer</div>
              <p className="mt-0.5 text-body text-ink-2">{hero}</p>
              <p className="mt-0.5 text-caption text-ink-2">
                Version {info.version}
                {info.firstPaintMs !== null ? `, opened in ${info.firstPaintMs} ms` : ""}
              </p>
            </div>
          </div>

          <Section id="appearance" title="Appearance">
            <ThemePicker theme={info.settings.theme} platform={info.platform} onChange={setTheme} />
            <Row
              label="Launch animation"
              hint="A short animation when Atlas opens. Click or press any key to skip it. A quick fade instead when your computer asks for reduced motion."
            >
              <Toggle label="Launch animation" checked={info.settings.launchAnimation} onChange={setLaunchAnimation} />
            </Row>
            <Row
              label="Keep running when closed"
              hint={`Closing the window hides Atlas ${info.platform === "macos" ? "to the menu bar" : "to the tray"} instead of quitting, so it keeps watching. Off by default.`}
            >
              <Toggle label="Keep running when closed" checked={info.settings.closeToTray} onChange={setCloseToTray} />
            </Row>
          </Section>

          <Section id="folder" title="Claude folder">
            <Row
              label="Folder Atlas reads"
              hint={
                <>
                  {cfg ? <Path>{cfg.dir}</Path> : <span>Waiting for the sandbox copy</span>}
                  {cfg && <div className="mt-1 text-caption">{describeSource(cfg.source)}</div>}
                </>
              }
            >
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={() => void openConfigDir()} disabled={!cfg}>
                  Open folder
                </Button>
                <Button onClick={() => void chooseConfigDir()} disabled={info.configLockedByFlag || sb.enabled}>
                  Choose folder
                </Button>
                {usingChosen && (
                  <Button onClick={() => void clearConfigDir()} disabled={info.configLockedByFlag || sb.enabled}>
                    Use default
                  </Button>
                )}
              </div>
            </Row>
            {(info.configLockedByFlag || sb.enabled) && (
              <p className="border-t border-line px-5 py-3 text-caption text-ink-2">
                {info.configLockedByFlag ? "This folder was set when Atlas was launched, so it cannot be changed here." : "Turn off Sandbox mode to change the folder."}
              </p>
            )}
            {info.settingsNote && (
              <p role="status" className="border-t border-line px-5 py-3 text-caption text-ink-2">
                {info.settingsNote}
              </p>
            )}
            {cfg && <Row label="Claude Code settings" hint={ov?.claudeSettingsFile ? <Path>{ov.claudeSettingsFile}</Path> : "No settings file yet"} />}
            {cfg && <Row label="Account and projects file" hint={<Path>{cfg.claudeJson}</Path>} />}
            <Row label="Conversation logs" hint={cleanup}>
              <span className="text-caption text-ink-2">Atlas keeps what it has read.</span>
            </Row>
            <Row
              label="Work on a copy"
              hint="Atlas copies your Claude folder to a temporary place and only touches the copy. Your real files are never changed. Large conversation logs are linked read-only instead of copied."
            >
              <Toggle label="Sandbox mode" checked={sb.enabled} onChange={(v) => void setSandbox(v)} />
            </Row>
            {sb.enabled && (
              <div role="status" className="border-t border-line px-5 py-3 text-body text-ink-2">
                {sb.state === "preparing" && "Making the copy..."}
                {sb.state === "failed" && (
                  <span className="text-danger">
                    The copy could not be made{sb.error ? `: ${sb.error}` : "."} Atlas is showing nothing rather than your real folder.
                  </span>
                )}
                {sb.state === "ready" && sb.report && (
                  <>
                    Copied {sb.report.filesCopied} files ({formatBytes(sb.report.bytesCopied)})
                    {sb.report.skippedTotal > 0 && `, left ${sb.report.skippedTotal} out`}.
                    {sb.path && (
                      <div className="mt-1">
                        <Path>{sb.path}</Path>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </Section>

          <Section id="data" title="Your data">
            <Row
              label="Usage numbers"
              hint={
                status ? (
                  <>
                    {status.state === "error"
                      ? status.error ?? "The usage cache could not be opened."
                      : `${plural(status.filesTracked, "session log")} read${status.lastIndexedAt ? `, updated ${agoText(status.lastIndexedAt)}` : ""}.`}
                    <div className="mt-1 text-caption">
                      {formatBytes(status.cacheBytes)} on disk. <Path>{status.cachePath}</Path>
                    </div>
                  </>
                ) : (
                  "Starting up"
                )
              }
            >
              <div className="flex flex-wrap justify-end gap-2">
                <Button onClick={() => void reindex("changed")} disabled={indexing || busy !== null}>
                  Read logs again
                </Button>
                <Button onClick={() => setConfirmRebuild(true)} disabled={indexing || busy !== null}>
                  Rebuild from scratch
                </Button>
              </div>
            </Row>
            <Row
              label="Price list"
              hint={
                price.data ? (
                  price.data.error ? (
                    <span className="text-danger">{price.data.error}</span>
                  ) : (
                    <>
                      Updated {price.data.table.updated}. Costs on the Dashboard are worked out from it.
                      <div className="mt-1 text-caption">
                        <Path>{price.data.path}</Path>
                      </div>
                    </>
                  )
                ) : (
                  "Loading"
                )
              }
            >
              <Button onClick={() => void backend.pricingReveal().catch(() => {})}>Show file</Button>
            </Row>
            <Row label="Atlas data" hint={<Path>{info.dataDir}</Path>}>
              <Button onClick={() => void openDataDir()}>Open Atlas data folder</Button>
            </Row>
          </Section>

          <Section id="history" title="History">
            <Row
              label="Saved copies"
              hint={
                ov?.historyPaused
                  ? "Paused while Sandbox mode is on. Atlas keeps copies of your real Claude folder only."
                  : ov && ov.historyVersions > 0
                    ? `${plural(ov.historyVersions, "version")} of ${plural(ov.historyItems, "file")}, ${formatBytes(ov.historyBytes)}.`
                    : "Nothing saved yet. Atlas starts when it first looks at your folder."
              }
            >
              <Button onClick={() => void backend.historyOpenFolder().catch(() => {})}>Open history folder</Button>
            </Row>
            <Row label="Keep up to" hint="Older copies of a file are let go once it passes this many. The newest are always kept.">
              <Stepper value={keep} onChange={setHistoryKeep} />
            </Row>
          </Section>

          <Section id="about" title="About">
            <Row label="Version">
              <span className="text-body text-ink-2">{info.version}</span>
            </Row>
            <Row label="Build">
              <span className="text-body text-ink-2">{info.build === "release" ? "Release" : "Debug"}</span>
            </Row>
            <Row label="Started in" hint="Time from launch to the first screen.">
              <span className="text-body text-ink-2">{info.firstPaintMs === null ? "Not measured" : `${info.firstPaintMs} ms`}</span>
            </Row>
            <Row label="Privacy" hint="Atlas never sends your data anywhere. Everything it shows is read from files on this computer." />
          </Section>
        </div>
      </div>

      {confirmRebuild && (
        <Dialog
          alert
          title="Rebuild from scratch?"
          onClose={() => setConfirmRebuild(false)}
          footer={
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirmRebuild(false)}>Cancel</Button>
              <Button
                variant="primary"
                onClick={() => {
                  setConfirmRebuild(false);
                  void reindex("full");
                }}
              >
                Rebuild
              </Button>
            </div>
          }
        >
          <p className="text-body text-ink">
            Atlas reads every session log again and makes the numbers from scratch. Logs that Claude Code has already cleared cannot be read again, so their numbers are kept.
          </p>
        </Dialog>
      )}
    </div>
  );
}
