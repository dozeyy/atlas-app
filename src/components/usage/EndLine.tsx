import { tailSplit } from "../../lib/receiptView";

/**
 * One line of text that ends in a path. When it is too long the folders shorten and the file name
 * stays, since the name is what tells two deep paths apart. Text with no path is cut at its end.
 */
export function EndLine({ text, path, className = "", title }: { text: string; path?: string | null; className?: string; title?: string }) {
  const parts = tailSplit(text, path);
  if (!parts) {
    return (
      <div className={`truncate ${className}`} title={title}>
        {text}
      </div>
    );
  }
  return (
    <div className={`flex min-w-0 ${className}`} title={title}>
      <span className="min-w-0 truncate">{parts[0]}</span>
      {/* The name never gives way to the folders; only a name longer than the whole line is cut. */}
      <span className="max-w-full flex-none truncate">{parts[1]}</span>
    </div>
  );
}
