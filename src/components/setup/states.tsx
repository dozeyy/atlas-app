import { EmptyState } from "../EmptyState";

function Bar({ w, h = 12, className = "" }: { w: string; h?: number; className?: string }) {
  return <span style={{ width: w, height: h }} className={`skeleton block rounded-full ${className}`} />;
}

/** Shown only while the first scan runs. Same shapes as the real page, so nothing jumps. */
export function SetupSkeleton() {
  return (
    <div role="status" aria-label="Reading your toolkit" aria-busy="true">
      <div className="mb-4 rounded-card border border-line bg-surface px-5 py-4">
        <Bar w="34%" h={16} />
        <Bar w="100%" h={8} className="mt-4" />
        <Bar w="60%" className="mt-4" />
        <Bar w="52%" className="mt-2" />
      </div>
      {/* The type tiles: the same grid, row height and icon size as TypeTiles. */}
      <div className="grid auto-rows-[72px] grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3">
        {Array.from({ length: 12 }, (_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-card border border-line bg-surface px-3">
            <span className="skeleton size-11 rounded-control" />
            <span className="flex-1">
              <Bar w="24%" h={16} />
              <Bar w="52%" className="mt-2" />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NoSetup() {
  return (
    <EmptyState
      fill
      seed={9}
      title="No toolkit found here"
      body="Atlas found no skills, agents, commands or settings. If your Claude folder lives somewhere else, choose it in Settings."
    />
  );
}
