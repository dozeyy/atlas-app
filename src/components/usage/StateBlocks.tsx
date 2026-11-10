import type { CSSProperties, ReactNode } from "react";

/** A quiet placeholder block while the first answer is on its way. */
export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
  return <div aria-hidden="true" style={style} className={`pulse-dot rounded-control bg-raised ${className}`} />;
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <h2 className="h-section">{children}</h2>
      {aside}
    </div>
  );
}
