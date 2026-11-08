import { useLayoutEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import * as Switch from "@radix-ui/react-switch";
import * as ToggleGroup from "@radix-ui/react-toggle-group";

type Variant = "primary" | "secondary" | "danger";

/**
 * Buttons: primary lifts 1px with a spring on hover and presses to .96 on the same frame
 * (CSS :active, no waiting for React). A danger button holds still: it never lifts.
 *
 * Two layers on purpose: the <button> is a fixed box that owns the click; the inner
 * `.btn-face` carries the look and every transform. Moving the button itself moves its hit
 * box and loses clicks near the edge (see trail.css, HIT BOX RULE).
 */
export function Button({
  variant = "secondary",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button type="button" {...rest} className={`btn btn-${variant} ${className}`}>
      <span className="btn-face">{children}</span>
    </button>
  );
}

/** A 32 px square button for one icon. Needs an aria-label. */
export function IconButton({
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { "aria-label": string; ref?: Ref<HTMLButtonElement> }) {
  return (
    <button type="button" {...rest} className={`btn-icon ${className}`}>
      <span className="btn-face">{children}</span>
    </button>
  );
}

/**
 * Pick one of a few. One thumb slides (320 ms spring) behind the labels; the first paint
 * puts it in place without moving.
 */
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
  const items = useRef(new Map<string, HTMLButtonElement>());
  const [thumb, setThumb] = useState<{ x: number; w: number } | null>(null);
  const [ready, setReady] = useState(false);

  useLayoutEffect(() => {
    const measure = () => {
      const el = items.current.get(value);
      if (el) setThumb({ x: el.offsetLeft, w: el.offsetWidth });
    };
    measure();
    const root = items.current.get(value)?.parentElement;
    let ro: ResizeObserver | undefined;
    if (root && typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(root);
    }
    const t = requestAnimationFrame(() => setReady(true));
    return () => {
      ro?.disconnect();
      cancelAnimationFrame(t);
    };
  }, [value, options]);

  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      aria-label={label}
      onValueChange={(v) => v && onChange(v as T)}
      className="seg"
    >
      {thumb && (
        <span
          aria-hidden="true"
          className="seg-thumb"
          style={{
            width: thumb.w,
            transform: `translateX(${thumb.x}px)`,
            transitionDuration: ready ? undefined : "0ms",
          }}
        />
      )}
      {options.map((o) => (
        <ToggleGroup.Item
          key={o.value}
          value={o.value}
          ref={(el) => {
            if (el) items.current.set(o.value, el);
            else items.current.delete(o.value);
          }}
          className="seg-item text-body"
        >
          <span className="seg-face">{o.label}</span>
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
      <Switch.Thumb className="block size-4 translate-x-[3px] rounded-full bg-ink-2 transition-transform duration-[var(--dur-spring)] ease-[var(--ease-spring)] data-[state=checked]:translate-x-[19px] data-[state=checked]:bg-on-accent" />
    </Switch.Root>
  );
}

/**
 * Every screen opens straight on its content, so the page title is not drawn: it is the
 * heading screen readers land on, and nothing else.
 */
export function PageTitle({ title }: { title: string }) {
  return <h1 className="sr-only">{title}</h1>;
}

/**
 * A surface. With `onClick` it becomes a button that lifts 2px on hover and presses in;
 * without, it is static and never moves. A clickable card is two layers (fixed outer button,
 * moving `.card-face`): `className` styles the face (padding), `hitClassName` the outer box
 * (grid span, margins).
 */
export function Card({
  children,
  className = "",
  hitClassName = "",
  onClick,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  hitClassName?: string;
  onClick?: () => void;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children" | "className">) {
  if (onClick) {
    return (
      <button type="button" {...rest} onClick={onClick} className={`card-hit hover-host ${hitClassName}`}>
        <div className={`card card-face ${className}`}>{children}</div>
      </button>
    );
  }
  return <div className={`card ${hitClassName} ${className}`}>{children}</div>;
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
