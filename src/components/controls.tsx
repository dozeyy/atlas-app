import type { ButtonHTMLAttributes, ReactNode } from "react";
import * as Switch from "@radix-ui/react-switch";
import * as ToggleGroup from "@radix-ui/react-toggle-group";

export function Button({
  variant = "secondary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  const look =
    variant === "primary"
      ? "bg-accent-solid text-on-accent hover:brightness-110"
      : "border border-line-strong bg-surface text-ink hover:bg-raised";
  return (
    <button
      type="button"
      {...rest}
      className={`press inline-flex h-8 cursor-pointer items-center gap-2 rounded-control px-3 text-body font-medium disabled:cursor-not-allowed disabled:opacity-50 ${look} ${className}`}
    />
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(v) => v && onChange(v as T)}
      className="inline-flex rounded-control border border-line-strong bg-raised p-0.5"
    >
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          className="press h-7 cursor-pointer rounded-[4px] px-3 text-body font-medium text-ink-2 hover:text-ink data-[state=on]:bg-surface data-[state=on]:text-ink data-[state=on]:shadow-[0_0_0_1px_var(--line)]"
        >
          {o.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      className="press relative h-6 w-10 shrink-0 cursor-pointer rounded-full border border-line-strong bg-raised data-[state=checked]:border-transparent data-[state=checked]:bg-accent-solid disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Switch.Thumb className="block size-4 translate-x-[3px] rounded-full bg-ink-2 transition-transform duration-[var(--dur)] ease-[var(--ease-out)] data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-on-accent" />
    </Switch.Root>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-title font-semibold tracking-[-0.01em] text-ink">{title}</h1>
      <p className="mt-1 text-lead text-ink-2">{subtitle}</p>
    </header>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-card border border-line bg-surface ${className}`}>{children}</div>
  );
}

/** One labeled row inside a Card: label + hint on the left, a control on the right. */
export function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line px-5 py-4 last:border-b-0">
      <div className="min-w-0">
        <div className="text-body font-medium text-ink">{label}</div>
        {hint && <div className="mt-0.5 text-body text-ink-2">{hint}</div>}
      </div>
      {children && <div className="shrink-0">{children}</div>}
    </div>
  );
}
