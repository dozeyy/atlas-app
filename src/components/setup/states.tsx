import { FolderDashed, MagnifyingGlass, WarningOctagon } from "@phosphor-icons/react";
import { Button } from "../controls";
import { EmptyState } from "../EmptyState";

function Bar({ w, h = 12, className = "" }: { w: string; h?: number; className?: string }) {
  return <span style={{ width: w, height: h }} className={`skeleton block rounded-full ${className}`} />;
}

/** Shown only while the first scan runs. Same shapes as the real page, so nothing jumps. */
export function SetupSkeleton() {
  return (
    <div role="status" aria-label="Reading your Claude setup" aria-busy="true">
      <div className="mb-4 rounded-card border border-line bg-surface px-5 py-4">
        <Bar w="38%" />
        <Bar w="120px" h={26} className="mt-5" />
        <Bar w="100%" h={8} className="mt-4" />
      </div>
      <div className="mb-6 flex flex-wrap gap-2.5">
        {Array.from({ length: 10 }, (_, i) => (
          <div key={i} className="flex min-w-[148px] flex-[1_1_148px] items-center gap-3 rounded-card border border-line bg-surface p-3">
            <span className="skeleton size-8 rounded-control" />
            <span className="flex-1">
              <Bar w="40%" h={16} />
              <Bar w="70%" className="mt-2" />
            </span>
          </div>
        ))}
      </div>
      {[0, 1].map((g) => (
        <div key={g} className="mb-8">
          <div className="mb-3 flex items-center gap-3">
            <span className="skeleton size-8 rounded-control" />
            <Bar w="160px" h={16} />
          </div>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex min-h-[104px] gap-3 rounded-card border border-line bg-surface p-3.5">
                <span className="skeleton size-9 rounded-control" />
                <span className="flex-1">
                  <Bar w="50%" h={14} />
                  <Bar w="92%" className="mt-3" />
                  <Bar w="64%" className="mt-2" />
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SetupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState fill icon={WarningOctagon} seed={61} title="Atlas could not read your Claude setup" body={message}>
      <Button variant="primary" onClick={onRetry}>
        Try again
      </Button>
    </EmptyState>
  );
}

export function NoSetup({ dir }: { dir: string }) {
  return (
    <EmptyState
      fill
      icon={FolderDashed}
      seed={67}
      title="No Claude setup found here"
      body={`Atlas looked in ${dir} and found no skills, agents, commands or settings. If your Claude folder lives somewhere else, choose it in Settings.`}
    />
  );
}

export function NoMatches({ onClear }: { onClear: () => void }) {
  return (
    <EmptyState fill icon={MagnifyingGlass} seed={71} title="Nothing matches" body="Try a different word, or turn off a filter.">
      <Button onClick={onClear}>Clear search and filters</Button>
    </EmptyState>
  );
}
