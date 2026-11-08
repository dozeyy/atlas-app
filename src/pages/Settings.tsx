import { Button, Card, PageHeader, Row, SegmentedControl, Toggle } from "../components/controls";
import { useAtlas } from "../state/AtlasProvider";
import { describeSource, formatBytes } from "../lib/labels";
import type { Theme } from "../lib/types";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

function SectionTitle({ children }: { children: string }) {
  return <h2 className="mb-3 mt-8 text-lead font-semibold text-ink first:mt-0">{children}</h2>;
}

export function Settings() {
  const { info, setTheme, setLaunchAnimation, setSandbox, chooseConfigDir, clearConfigDir } = useAtlas();
  const cfg = info.config;
  const sb = info.sandbox;
  const usingChosen = info.settings.configDirOverride !== null;

  return (
    <>
      <PageHeader title="Settings" subtitle="How Atlas looks and which Claude folder it reads." />

      <SectionTitle>Appearance</SectionTitle>
      <Card>
        <Row label="Theme" hint="System follows your computer's light or dark setting.">
          <SegmentedControl
            label="Theme"
            value={info.settings.theme}
            options={THEMES}
            onChange={setTheme}
          />
        </Row>
        <Row
          label="Launch animation"
          hint="A short animation when Atlas opens. Click or press any key to skip it. A quick fade instead when your computer asks for reduced motion."
        >
          <Toggle
            label="Launch animation"
            checked={info.settings.launchAnimation}
            onChange={setLaunchAnimation}
          />
        </Row>
      </Card>

      <SectionTitle>Claude folder</SectionTitle>
      <Card>
        <Row
          label="Folder Atlas reads"
          hint={
            <>
              {cfg ? (
                <code className="selectable break-all text-ink">{cfg.dir}</code>
              ) : (
                <span>Waiting for the sandbox copy</span>
              )}
              {cfg && <div className="mt-1 text-caption">{describeSource(cfg.source)}</div>}
            </>
          }
        >
          <div className="flex gap-2">
            <Button
              onClick={() => void chooseConfigDir()}
              disabled={info.configLockedByFlag || sb.enabled}
            >
              Choose folder
            </Button>
            {usingChosen && (
              <Button
                onClick={() => void clearConfigDir()}
                disabled={info.configLockedByFlag || sb.enabled}
              >
                Use default
              </Button>
            )}
          </div>
        </Row>
        {(info.configLockedByFlag || sb.enabled) && (
          <p className="border-t border-line px-5 py-3 text-caption text-ink-2">
            {info.configLockedByFlag
              ? "This folder was set when Atlas was launched, so it cannot be changed here."
              : "Turn off Sandbox mode to change the folder."}
          </p>
        )}
        {info.settingsNote && (
          <p role="status" className="border-t border-line px-5 py-3 text-caption text-ink-2">
            {info.settingsNote}
          </p>
        )}
      </Card>

      <SectionTitle>Sandbox mode</SectionTitle>
      <Card>
        <Row
          label="Work on a copy"
          hint="Atlas copies your Claude folder to a temporary place and only touches the copy. Your real files are never changed. Large conversation logs are linked read-only instead of copied."
        >
          <Toggle
            label="Sandbox mode"
            checked={sb.enabled}
            onChange={(v) => void setSandbox(v)}
          />
        </Row>
        {sb.enabled && (
          <div role="status" className="border-t border-line px-5 py-3 text-body text-ink-2">
            {sb.state === "preparing" && "Making the copy..."}
            {sb.state === "failed" && (
              <span className="text-danger">
                The copy could not be made{sb.error ? `: ${sb.error}` : "."} Atlas is showing nothing
                rather than your real folder.
              </span>
            )}
            {sb.state === "ready" && sb.report && (
              <>
                Copied {sb.report.filesCopied} files ({formatBytes(sb.report.bytesCopied)})
                {sb.report.skippedTotal > 0 && `, left ${sb.report.skippedTotal} out`}.
                {sb.path && (
                  <div className="mt-1">
                    <code className="selectable break-all">{sb.path}</code>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      <SectionTitle>About</SectionTitle>
      <Card>
        <Row label="Version">
          <span className="text-body text-ink-2">{info.version}</span>
        </Row>
        <Row label="Started in" hint="Time from launch to the first screen.">
          <span className="text-body text-ink-2">
            {info.firstPaintMs === null ? "Not measured" : `${info.firstPaintMs} ms`}
          </span>
        </Row>
        <Row label="Atlas data" hint={<code className="selectable break-all">{info.dataDir}</code>} />
      </Card>
    </>
  );
}
