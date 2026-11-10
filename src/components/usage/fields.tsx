import { CaretDown, MagnifyingGlass } from "@phosphor-icons/react";

/** A native select, dressed in the app's tokens. Native keeps keyboard and screen-reader behavior free. */
export function SelectField({
  label,
  value,
  onChange,
  options,
  wide = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** Fill the row (inside an options panel) instead of sizing to the text. */
  wide?: boolean;
}) {
  return (
    <label className={`select-wrap relative inline-flex ${wide ? "w-full" : ""}`}>
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // A long choice is cut by the field's width: the hover says it whole.
        title={options.find((o) => o.value === value)?.label}
        className={`h-8 cursor-pointer ${wide ? "w-full" : "max-w-[220px]"}  appearance-none rounded-control border border-line-strong bg-surface py-0 pl-3 pr-8 text-body text-ink hover:bg-raised`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-ink-2">
        <CaretDown size={12} weight="bold" className="select-caret" />
      </span>
    </label>
  );
}

export function SearchField({
  value,
  onChange,
  label,
  placeholder,
  tall = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder: string;
  /** The taller toolbar height (--field-tall), the same as the buttons beside it. */
  tall?: boolean;
}) {
  return (
    <label className="relative inline-flex min-w-[200px] flex-1">
      <span className="sr-only">{label}</span>
      <MagnifyingGlass
        size={tall ? 16 : 14}
        aria-hidden="true"
        className={`pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-2 ${tall ? "left-3.5" : "left-3"}`}
      />
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={`selectable w-full rounded-control border border-line-strong bg-surface pr-3 text-body text-ink placeholder:text-ink-2 hover:bg-raised focus:bg-surface ${
          tall ? "h-[var(--field-tall)] pl-9" : "h-8 pl-8"
        }`}
      />
    </label>
  );
}
