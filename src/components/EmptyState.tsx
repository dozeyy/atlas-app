import type { ComponentType, ReactNode } from "react";
import type { IconProps } from "@phosphor-icons/react";
import { Topo } from "./Topo";

/** A designed empty state: contour backdrop, one icon, a plain sentence, an optional action. */
export function EmptyState({
  icon: Icon,
  title,
  body,
  badge,
  seed,
  children,
}: {
  icon: ComponentType<IconProps>;
  title: string;
  body: string;
  badge?: string;
  seed?: number;
  children?: ReactNode;
}) {
  return (
    <section className="relative isolate flex min-h-[320px] flex-col items-center justify-center overflow-hidden rounded-card border border-line bg-surface px-8 py-12 text-center">
      <Topo seed={seed} />
      <div className="relative flex size-12 items-center justify-center rounded-card border border-line bg-bg text-accent-text">
        <Icon size={24} weight="duotone" aria-hidden="true" />
      </div>
      <h2 className="relative mt-4 text-subtitle font-semibold text-ink">{title}</h2>
      <p className="relative mt-2 max-w-[44ch] text-body text-ink-2">{body}</p>
      {badge && (
        <span className="relative mt-4 rounded-full border border-line bg-bg px-3 py-1 text-caption font-medium text-ink-2">
          {badge}
        </span>
      )}
      {children && <div className="relative mt-5">{children}</div>}
    </section>
  );
}
