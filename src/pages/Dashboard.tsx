import { CheckCircle, Circle, SquaresFour } from "@phosphor-icons/react";
import { Card, PageHeader } from "../components/controls";
import { EmptyState } from "../components/EmptyState";
import { useAtlas } from "../state/AtlasProvider";
import { describeSource } from "../lib/labels";

function Check({ ok, label }: { ok: boolean; label: string }) {
  const Icon = ok ? CheckCircle : Circle;
  return (
    <li className="flex items-center gap-2 text-body text-ink">
      <Icon
        size={16}
        weight={ok ? "fill" : "regular"}
        aria-hidden="true"
        className={ok ? "text-success" : "text-ink-2"}
      />
      <span>{label}</span>
      <span className="sr-only">{ok ? "found" : "not found"}</span>
      <span aria-hidden="true" className="text-ink-2">
        {ok ? "" : "not found"}
      </span>
    </li>
  );
}

export function Dashboard() {
  const { info } = useAtlas();
  const cfg = info.config;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="How you are using Claude Code, at a glance." />

      <EmptyState
        icon={SquaresFour}
        seed={7}
        title="Your usage will show up here"
        body="Tokens, cost and activity by day, project and model, once Atlas starts reading your sessions."
        badge="Coming soon"
      />

      <h2 className="mb-3 mt-8 text-lead font-semibold text-ink">Claude folder</h2>
      <Card className="px-5 py-4">
        {cfg ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <code className="selectable break-all text-ink">{cfg.dir}</code>
              <span className="text-caption text-ink-2">{describeSource(cfg.source)}</span>
            </div>
            <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
              <Check ok={cfg.dirExists} label="Folder" />
              <Check ok={cfg.claudeJsonExists} label="Settings file" />
              <Check ok={cfg.projectsExists} label="Projects" />
            </ul>
          </>
        ) : (
          <p role="status" className="text-body text-ink-2">
            {info.sandbox.state === "failed"
              ? "The sandbox copy could not be made, so nothing is shown. See Settings."
              : "Making a safe copy of your Claude folder..."}
          </p>
        )}
      </Card>
    </>
  );
}
