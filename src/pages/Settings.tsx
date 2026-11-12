import { Fragment, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ClockCounterClockwise, Database, FolderSimple, Minus, Mountains, Palette, PlugsConnected, Plus, SlidersHorizontal } from "@phosphor-icons/react";
import { Button, Card, IconButton, PageTitle, Row, SegmentedControl, Toggle } from "../components/controls";
import { Dialog } from "../components/Dialog";
import { ThemePicker } from "../components/ThemePicker";
import { useAtlas } from "../state/AtlasProvider";
import { DEFAULT_ZOOM, ZOOM_LEVELS, stepZoom } from "../lib/zoom";
import { modName } from "../lib/appMenu";
import { pushToast } from "../state/toastStore";
import { getBackend } from "../lib/ipc";
import type { McpStatus } from "../lib/ipc";
import { describeSource, formatBytes } from "../lib/labels";
import { longDate } from "../lib/dashboardModel";
import { agoText } from "../lib/historyModel";
import { plural } from "../lib/usage";
import { keepChoice, keepToast } from "../lib/retention";
import { rememberSettingsSection, savedSettingsSection } from "../lib/settingsSection";
import { useFetched, useUsageStatus } from "../lib/useUsage";
import { useWidth } from "../lib/useWidth";
import { checkForUpdate, startInstall, useUpdate } from "../lib/updateStore";

const WIDE_AT = 760;
const KEEP_MIN = 10;
const KEEP_MAX = 200;
const KEEP_STEP = 10;

const SECTIONS = [
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "general", label: "General", icon: SlidersHorizontal },
  { id: "folder", label: "Claude folder", icon: FolderSimple },
  { id: "claude", label: "Claude Code", icon: PlugsConnected },
  { id: "data", label: "Your data", icon: Database },
  { id: "history", label: "History", icon: ClockCounterClockwise },
  // Not the info circle: across the app that one means "hover for more".
  { id: "about", label: "About", icon: Mountains },
] as const;
type SectionId = (typeof SECTIONS)[number]["id"];

/** A path that breaks at a slash first, and inside a word only when one piece is wider than the row. */
function Path({ children }: { children: string }) {
  return (
    <code className="selectable wrap-anywhere text-ink">
      {(children.match(/[^\\/]*[\\/]?/g) ?? []).filter(Boolean).map((part, i) => (
        <Fragment key={i}>
          {part}
          <wbr />
        </Fragment>
      ))}
    </code>
  );
}

// The section last looked at, so Settings reopens where you left it (kept like the Toolkit tab).
function savedSection(): SectionId {
  const saved = savedSettingsSection();
  return SECTIONS.find((s) => s.id === saved)?.id ?? "appearance";
}

/** Zoom out / in with the percent between and a way back to 100. */
function ZoomStepper({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const lo = ZOOM_LEVELS[0];
  const hi = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
  return (
    <div className="st-step" role="group" aria-label="Zoom">
      <IconButton aria-label="Zoom out" disabled={value <= lo} onClick={() => onChange(stepZoom(value, "out"))}>
        <Minus size={14} aria-hidden="true" />
      </IconButton>
      <span className="st-step-value st-zoom-value text-body font-medium text-ink" aria-live="polite">
        {value}%
      </span>
      <IconButton aria-label="Zoom in" disabled={value >= hi} onClick={() => onChange(stepZoom(value, "in"))}>
        <Plus size={14} aria-hidden="true" />
      </IconButton>
      <Button disabled={value === DEFAULT_ZOOM} onClick={() => onChange(DEFAULT_ZOOM)}>
        Reset
      </Button>
    </div>
  );
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
 * Settings is the calm page: no charts, no count-ups, no springs. One section at a time, picked
 * from the rail, so the page never needs to scroll. It is also the ONE place the Claude folder
 * is shown (path, Open folder, override); Dashboard and Sessions never show it.
 */
export function Settings() {
  const {
    info,
    setTheme,
    setLaunchAnimation,
    setCountCacheInTotals,
    setCloseToTray,
    setNotifyOnFinish,
    setShowShortcuts,
    setTextSize,
    setZoom,
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
  const desktop = useFetched(() => backend.desktopShortcut(), [backend]);
  const [desktopOn, setDesktopOn] = useState<boolean | null>(null);
  const shortcutOn = desktopOn ?? desktop.data ?? false;
  const setShortcut = async (on: boolean) => {
    setDesktopOn(on);
    try {
      setDesktopOn(await backend.setDesktopShortcut(on));
    } catch (e) {
      setDesktopOn(!on);
      pushToast({ message: e instanceof Error ? e.message : String(e), tone: "error" });
    }
  };
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

  // Uninstall (About): offered only when an uninstaller sits beside this Atlas.
  const [canUninstall, setCanUninstall] = useState(false);
  useEffect(() => {
    let dead = false;
    backend
      .uninstallAvailable()
      .then((yes) => !dead && setCanUninstall(yes))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [backend]);

  // Claude Code connection: always read back from Claude's own settings file.
  const [mcp, setMcp] = useState<McpStatus | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const refreshMcp = () =>
    backend
      .mcpStatus()
      .then(setMcp)
      .catch(() => setMcp(null));
  // Sandbox on or off changes which folder is read.
  useEffect(() => {
    let dead = false;
    backend
      .mcpStatus()
      .then((s) => !dead && setMcp(s))
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [backend, cfg?.dir, sb.enabled]);
  const changeMcp = async (connect: boolean) => {
    setMcpBusy(true);
    try {
      // Rust saves the choice first (so a failure never leaves Atlas free to reconnect on its
      // own), then changes the connection, and announces the new settings to the page.
      await (connect ? backend.mcpConnect() : backend.mcpDisconnect());
      pushToast({ message: connect ? "Claude Code can use Atlas now. Open a new session to see it." : "Atlas is disconnected from Claude Code and will stay that way.", tone: "info" });
    } catch (e) {
      pushToast({ message: typeof e === "string" ? e : e instanceof Error ? e.message : "Could not change the connection.", tone: "error" });
    } finally {
      setMcpBusy(false);
      void refreshMcp();
    }
  };
  const mcpWanted = info.settings.mcpAutoConnect !== false;
  // Another program owns the name "atlas" in Claude Code: shown as it is, never switched.
  const mcpForeign = mcp?.state === "foreign";
  const mcpState = !mcp
    ? "Checking"
    : mcp.sandbox
      ? "Turn Sandbox mode off to change this."
      : mcp.server === null
        ? "The connector program is missing from this install. Reinstalling Atlas puts it back."
        : mcpForeign
          ? 'Claude Code already has a different program named "atlas". Atlas leaves it alone.'
          : mcp.state === "connected"
            ? "Connected"
            : mcp.state === "moved"
              ? mcpWanted
                ? "Registered to a different copy of Atlas. Turn this off and on to use this one."
                : "Off, but a different copy of Atlas is still registered with Claude Code."
              : !mcpWanted
                ? "Off"
                : !mcp.cliFound
                  ? "Claude Code not found"
                  : "Not connected yet";

  // Updates (About): the same state the sidebar icon shows; the button asks right now.
  const upd = useUpdate();
  const [checking, setChecking] = useState(false);
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const updateBusy = upd.state.kind === "downloading" || upd.state.kind === "installing";
  const askForUpdate = async () => {
    setChecking(true);
    setUpdateNote(null);
    const r = await checkForUpdate({ manual: true });
    setChecking(false);
    if (r.outcome === "latest") setUpdateNote("You have the latest version.");
    else if (r.outcome === "failed") setUpdateNote(r.message);
  };
  const updateHint =
    upd.state.kind === "available"
      ? `Version ${upd.state.info.version} is ready.`
      : upd.state.kind === "failed"
        ? upd.state.message
        : upd.state.kind === "downloading" || upd.state.kind === "installing"
          ? `Version ${upd.state.info.version} on its way`
          : (updateNote ?? undefined);

  const ov = overview.data;
  const [active, setActiveState] = useState<SectionId>(savedSection);
  const setActive = (id: SectionId) => {
    setActiveState(id);
    rememberSettingsSection(id);
  };
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [busy, setBusy] = useState<"changed" | "full" | null>(null);

  const reindex = async (scope: "changed" | "full") => {
    setBusy(scope);
    try {
      await backend.usageReindex(scope);
      pushToast({ message: scope === "full" ? "Rebuilding from scratch. Numbers fill in as the files are read." : "Reading your sessions again.", tone: "info" });
    } catch (e) {
      pushToast({ message: e instanceof Error ? e.message : "Could not start reading your sessions.", tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const lockedTip = info.configLockedByFlag ? "Set when Atlas was launched" : sb.enabled ? "Turn off Sandbox mode first" : undefined;
  const indexing = status?.state === "indexing";
  // Keep saved sessions: Claude Code's own `cleanupPeriodDays`, changed through the one write path.
  const [keepBusy, setKeepBusy] = useState(false);
  const keepNow = keepChoice(ov?.cleanupDays ?? null, ov?.cleanupInvalid ?? false, ov?.cleanupUnknown ?? false);
  const setKeep = async (value: string) => {
    const days = Number(value);
    if (keepBusy || value === keepNow.value || !Number.isInteger(days)) return;
    setKeepBusy(true);
    try {
      const out = await backend.retentionSet(days);
      overview.reload(true);
      pushToast({
        message: keepToast(days),
        tone: "success",
        action: out.backupId
          ? {
              label: "Undo",
              onClick: async () => {
                try {
                  await backend.setupUndo(out.backupId as string);
                  pushToast({ message: "Put your settings file back exactly as it was.", tone: "success" });
                } catch (e) {
                  pushToast({ message: e instanceof Error ? e.message : typeof e === "string" ? e : "Atlas could not undo that.", tone: "error" });
                } finally {
                  overview.reload(true);
                }
              },
            }
          : undefined,
      });
    } catch (e) {
      pushToast({ message: typeof e === "string" ? e : e instanceof Error ? e.message : "Atlas could not change that. Nothing was changed.", tone: "error" });
    } finally {
      setKeepBusy(false);
    }
  };

  const bodies: Record<SectionId, ReactNode> = {
    appearance: (
      <>
        <ThemePicker theme={info.settings.theme} platform={info.platform} onChange={setTheme} />
        <Row label="Text size" tip="Larger adds a little to every size of text. Pages stay the same shape.">
          <SegmentedControl
            label="Text size"
            value={info.settings.textSize}
            options={[
              { value: "default", label: "Default" },
              { value: "larger", label: "Larger" },
            ]}
            onChange={setTextSize}
          />
        </Row>
        <Row label="Zoom" tip={`Makes everything bigger or smaller. ${modName(info.platform)}+Plus, ${modName(info.platform)}+Minus and ${modName(info.platform)}+0 do the same anywhere in Atlas.`}>
          <ZoomStepper value={info.settings.zoomPercent} onChange={setZoom} />
        </Row>
        <Row label="Launch animation">
          <Toggle label="Launch animation" checked={info.settings.launchAnimation} onChange={setLaunchAnimation} />
        </Row>
        <Row label="Show shortcuts" tip="Shows the keys in hovers, menus and search boxes. The shortcuts work either way, and Help lists them all.">
          <Toggle label="Show shortcuts" checked={info.settings.showShortcuts} onChange={setShowShortcuts} />
        </Row>
      </>
    ),
    // How Atlas behaves, apart from how it looks.
    general: (
      <>
        <Row
          label="Keep running when closed"
          tip={info.platform === "macos" ? "Keeps Atlas in the menu bar only, out of the Dock." : "Hides Atlas to the tray instead of quitting."}
        >
          <Toggle label="Keep running when closed" checked={info.settings.closeToTray} onChange={setCloseToTray} />
        </Row>
        {desktop.data != null && (
          <Row label="Shortcut on the desktop" tip="Atlas is always in the Start menu. This adds it to the desktop too.">
            <Toggle label="Shortcut on the desktop" checked={shortcutOn} onChange={(on) => void setShortcut(on)} />
          </Row>
        )}
        <Row label="Tell me when a session finishes">
          <Toggle label="Tell me when a session finishes" checked={info.settings.notifyOnFinish} onChange={setNotifyOnFinish} />
        </Row>
        <Row
          label="Count cache in token totals"
          tip="Claude saves your conversation and re-reads it on every reply. Turn this on to count those saves and reads in every token total. Totals get much bigger. Dollars do not change."
        >
          <Toggle label="Count cache in token totals" checked={info.settings.countCacheInTotals} onChange={setCountCacheInTotals} />
        </Row>
      </>
    ),
    folder: (
      <>
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
            <Button onClick={() => void chooseConfigDir()} disabled={info.configLockedByFlag || sb.enabled} title={lockedTip}>
              Choose folder
            </Button>
            {usingChosen && (
              <Button onClick={() => void clearConfigDir()} disabled={info.configLockedByFlag || sb.enabled} title={lockedTip}>
                Use default
              </Button>
            )}
          </div>
        </Row>
        {info.settingsNote && (
          <p role="status" className="border-t border-line px-5 py-3 text-caption text-ink-2">
            {info.settingsNote}
          </p>
        )}
        {cfg && <Row label="Claude Code settings" hint={ov?.claudeSettingsFile ? <Path>{ov.claudeSettingsFile}</Path> : "No settings file yet"} />}
        {cfg && <Row label="Account and projects file" hint={<Path>{cfg.claudeJson}</Path>} />}
        {ov && (
          <Row
            label="Keep saved sessions"
            tip="Forever sets 3,650 days, about ten years. Claude Code has no setting for no limit."
            hint={ov.cleanupLocked ?? (ov.cleanupInvalid ? "Your settings file holds a value Claude Code won't accept. Pick one to fix it." : "Claude Code deletes older sessions, so they drop out of search, resume and Wrapped.")}
          >
            {ov.cleanupLocked ? (
              <span className="text-body text-ink-2" aria-label={`Keep saved sessions: ${keepNow.label}`}>
                {keepNow.label}
              </span>
            ) : (
              <SegmentedControl label="Keep saved sessions" value={keepNow.value} options={keepNow.options} onChange={(v) => void setKeep(v)} />
            )}
          </Row>
        )}
        {ov?.cleanupNote && !ov.cleanupLocked && (
          <p className="border-t border-line px-5 py-3 text-caption text-ink-2">{ov.cleanupNote}</p>
        )}
        <Row label="Work on a copy" hint="Sandbox mode" tip="Atlas copies your Claude folder to a temporary place and only touches the copy. Your real files are never changed.">
          <Toggle label="Sandbox mode" checked={sb.enabled} onChange={(v) => void setSandbox(v)} />
        </Row>
        {sb.enabled && (
          <div role="status" className="border-t border-line px-5 py-3 text-body text-ink-2">
            {sb.state === "preparing" && "Making the copy..."}
            {sb.state === "failed" && (
              // The reason is the system's own words (often a path): it waits in the hover.
              <span className="text-danger" title={sb.error ?? undefined}>
                The copy could not be made. Atlas is showing nothing rather than your real folder.
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
      </>
    ),
    claude: (
      <>
        <Row
          label="Let Claude Code use Atlas"
          tip="Claude Code can list and edit your skills, agents and commands through Atlas, with a backup before every change."
          hint={<span role="status">{mcpBusy ? "Working" : mcpState}</span>}
        >
          <Toggle label="Let Claude Code use Atlas" checked={mcpWanted && !mcpForeign} onChange={(v) => void changeMcp(v)} disabled={mcpBusy || !mcp || mcp.sandbox || mcp.server === null || mcpForeign} />
        </Row>
        {mcp?.server && <Row label="Connector program" hint={<Path>{mcp.server}</Path>} />}
        <Row label="Private to you" tip="The connector talks to Claude Code through a pipe on this computer. It opens no network port, and it never reads or shows Claude's sign-in files or keys.">
          <span className="text-body text-ink-2">No network access</span>
        </Row>
      </>
    ),
    data: (
      <>
        <Row
          label="Usage numbers"
          hint={
            status ? (
              <>
                {status.state === "error" ? (
                  // A plain sentence; the engine's own words (paths, codes) wait in the hover.
                  <span className="text-danger" title={status.error ?? undefined}>
                    Atlas could not read your usage.
                  </span>
                ) : (
                  `${plural(status.filesTracked, "session file")} read${status.lastIndexedAt ? `, updated ${agoText(status.lastIndexedAt)}` : ""}.`
                )}
                {/* The file is in the Atlas data folder two rows down; its full path waits in the hover. */}
                <div className="mt-1 text-caption">
                  <span title={status.cachePath}>{formatBytes(status.cacheBytes)} on disk</span>
                </div>
              </>
            ) : (
              "Starting up"
            )
          }
        >
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => void reindex("changed")} disabled={indexing || busy !== null}>
              Read sessions again
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
                // The last good list stays in force (pricing_file.rs); the reason waits in the hover.
                <span className="text-danger" title={price.data.error}>
                  The price file could not be read. Atlas is using its last good prices.
                </span>
              ) : (
                <span title={price.data.path}>Updated {longDate(price.data.table.updated)}</span>
              )
            ) : (
              "Loading"
            )
          }
        >
          <Button onClick={() => void backend.pricingReveal().catch(() => {})}>Show file</Button>
        </Row>
        {/* No raw path on the surface in this section: a plain line, the path in its hover, the folder behind the button. */}
        <Row label="Atlas data" hint={<span title={info.dataDir}>Its settings, usage data and backups</span>}>
          <Button onClick={() => void openDataDir()}>Open folder</Button>
        </Row>
      </>
    ),
    history: (
      <>
        <Row
          label="Saved copies"
          hint={
            ov?.historyPaused
              ? "Paused in Sandbox mode"
              : ov && ov.historyVersions > 0
                ? `${plural(ov.historyVersions, "version")} of ${plural(ov.historyItems, "file")}, ${formatBytes(ov.historyBytes)}`
                : "Nothing saved yet"
          }
        >
          <Button onClick={() => void backend.historyOpenFolder().catch(() => {})}>Open folder</Button>
        </Row>
        <Row label="Versions kept per file" tip="Older copies of a file are let go once it passes this many. The newest are always kept.">
          <Stepper value={keep} onChange={setHistoryKeep} />
        </Row>
      </>
    ),
    about: (
      <>
        <Row label="Version">
          <span className="text-body text-ink-2">{info.version}</span>
        </Row>
        <Row label="Updates" hint={updateHint}>
          {updateBusy ? (
            <Button disabled>{upd.state.kind === "installing" ? "Installing" : "Downloading"}</Button>
          ) : upd.state.kind === "available" || upd.state.kind === "failed" ? (
            <Button variant="primary" onClick={() => void startInstall()}>
              {upd.state.kind === "failed" ? "Try again" : "Update and restart"}
            </Button>
          ) : (
            <Button disabled={checking} onClick={() => void askForUpdate()}>
              {checking ? "Checking" : "Check for updates"}
            </Button>
          )}
        </Row>
        {/* Facts only when there is one to tell: a release build is the normal case, and a start
            that was not timed says nothing. */}
        {info.build !== "release" && (
          <Row label="Build">
            <span className="text-body text-ink-2">Debug</span>
          </Row>
        )}
        {info.firstPaintMs !== null && (
          <Row label="Started in" tip="Time from launch to the first screen.">
            <span className="text-body text-ink-2">{`${info.firstPaintMs} ms`}</span>
          </Row>
        )}
        <Row label="Privacy" tip="Atlas sends none of your sessions or files anywhere. It goes online only to look for a new version and to load the Library.">
          <span className="text-body text-ink-2">Your sessions and files are not sent</span>
        </Row>
        {canUninstall && (
          <Row label="Uninstall" tip="Closes Atlas and asks whether to keep or remove its saved data. Your Claude Code sessions are never touched.">
            <Button
              onClick={() =>
                void backend.uninstallAtlas().catch((e: unknown) => pushToast({ message: typeof e === "string" ? e : "Could not start the uninstaller.", tone: "error" }))
              }
            >
              Uninstall Atlas...
            </Button>
          </Row>
        )}
      </>
    ),
  };
  const current = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0];

  return (
    <div className="@container flex min-h-0 flex-1 flex-col gap-4" ref={root}>
      <PageTitle title="Settings" />
      <div className={wide ? "grid min-h-0 flex-1 grid-cols-[160px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-8" : "flex min-h-0 flex-1 flex-col gap-3"}>
        <nav aria-label="Settings sections" className="st-nav" data-wide={wide ? "" : undefined}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              id={`st-tab-${s.id}`}
              className="st-nav-item text-body"
              aria-current={active === s.id ? "true" : undefined}
              aria-controls="st-panel"
              onClick={() => setActive(s.id)}
            >
              <s.icon size={16} aria-hidden="true" className="st-nav-ico" />
              {s.label}
            </button>
          ))}
        </nav>
        <section id="st-panel" key={active} aria-labelledby={`st-tab-${active}`} className="rise min-h-0 min-w-0 overflow-y-auto rounded-card">
          <h2 className="sr-only">{current.label}</h2>
          <Card>{bodies[active]}</Card>
        </section>
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
            Atlas reads every session file again. Numbers from files that Claude Code already cleared are kept.
          </p>
        </Dialog>
      )}
    </div>
  );
}
