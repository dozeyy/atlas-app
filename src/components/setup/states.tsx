import { FolderDashed, MagnifyingGlass, WarningOctagon } from "@phosphor-icons/react";
import { Button } from "../controls";
import { EmptyState } from "../EmptyState";

function Bar({ w, h = 12, className = "" }: { w: string; h?: number; className?: string }) {
  return <span style={{ width: w, height: h }} className={`skeleton block rounded-full ${className}`} />;
}

/** Shown only while the first scan runs. Same shapes as the real page, so nothing jumps. */
export function SetupSkeleton() {
  return (
    <div role="status" aria-label="Reading your toolkit" aria-busy="true">
      <div className="mb-6 rounded-card border border-line bg-surface px-5 py-4">
        <Bar w="34%" h={16} />
        <Bar w="100%" h={8} className="mt-4" />
        <Bar w="60%" className="mt-4" />
        <Bar w="52%" className="mt-2" />
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex h-[92px] items-center gap-3 rounded-card border border-line bg-surface px-3.5">
            <span className="skeleton size-9 rounded-control" />
            <span className="flex-1">
              <Bar w="60%" h={14} />
              <Bar w="30%" className="mt-2" />
            </span>
          </div>
        ))}
      </div>
      <div className="mt-8">
        <Bar w="180px" h={16} />
        <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3">
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
    </div>
  );
}

export function SetupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <EmptyState fill icon={WarningOctagon} seed={61} title="Atlas could not read your toolkit" body={message}>
      <Button variant="primary" onClick={onRetry}>
        Try again
      </Button>
    </EmptyState>
  );
}

export function NoSetup() {
  return (
    <EmptyState
      fill
      icon={FolderDashed}
      seed={67}
      title="No toolkit found here"
      body="Atlas found no skills, agents, commands or settings. If your Claude folder lives somewhere else, choose it in Settings."
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
