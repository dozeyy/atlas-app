import { WarningCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Button } from "../controls";

/** A quiet placeholder block while the first answer is on its way. */
export function Skeleton({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" className={`pulse-dot rounded-control bg-raised ${className}`} />;
}

/** The page could not get its numbers: say so and offer the one way forward. */
export function ErrorBlock({ message, onRetry, title = "Could not load this" }: { message: string; onRetry?: () => void; title?: string }) {
  return (
    <section role="alert" className="flex flex-col items-center rounded-card border border-line bg-surface px-8 py-10 text-center">
      <WarningCircle size={28} weight="duotone" aria-hidden="true" className="text-danger" />
      <h2 className="mt-3 text-lead font-semibold text-ink">{title}</h2>
      <p className="mt-1 max-w-[52ch] text-body text-ink-2">{message}</p>
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </section>
  );
}

export function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-4">
      <h2 className="d d-figure text-ink">{children}</h2>
      {aside}
    </div>
  );
}
