import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react";

/** A native select, dressed in the app's tokens. Native keeps keyboard and screen-reader behavior free. */
export function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <label className="relative inline-flex">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="press h-8 max-w-[220px] cursor-pointer appearance-none rounded-control border border-line-strong bg-surface py-0 pl-3 pr-8 text-body text-ink hover:bg-raised"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <CaretDown
        size={12}
        weight="bold"
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-2"
      />
    </label>
  );
}

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <label className="relative inline-flex min-w-[200px] flex-1">
      <span className="sr-only">{label}</span>
      <MagnifyingGlass
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2"
      />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="selectable h-8 w-full rounded-control border border-line-strong bg-surface pl-8 pr-3 text-body text-ink placeholder:text-ink-2 hover:bg-raised focus:bg-surface"
      />
    </label>
  );
}
