import { Fragment, useMemo } from "react";
import { parseInline, parseMarkdown, type Block } from "../../lib/markdown";

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((t, i) => {
        switch (t.type) {
          case "code":
            return (
              <code key={i} className="mono rounded-[4px] bg-raised px-1 text-ink">
                {t.text}
              </code>
            );
          case "strong":
            return (
              <strong key={i} className="font-semibold text-ink">
                {t.text}
              </strong>
            );
          case "em":
            return <em key={i}>{t.text}</em>;
          case "link":
            return (
              <span key={i} className="text-accent-text underline">
                {t.text}
              </span>
            );
          default:
            return <Fragment key={i}>{t.text}</Fragment>;
        }
      })}
    </>
  );
}

const HEADING = ["", "text-subtitle", "text-lead", "text-lead", "text-body", "text-body", "text-body"];

function BlockView({ b }: { b: Block }) {
  switch (b.type) {
    case "heading":
      return (
        <p role="heading" aria-level={Math.min(6, b.level + 2)} className={`mt-4 font-semibold text-ink first:mt-0 ${HEADING[b.level]}`}>
          <Inline text={b.text} />
        </p>
      );
    case "paragraph":
      return (
        <p className="mt-2 text-body text-ink first:mt-0">
          <Inline text={b.text} />
        </p>
      );
    case "list": {
      const Tag = b.ordered ? "ol" : "ul";
      return (
        <Tag className={`mt-2 space-y-1 pl-5 text-body text-ink first:mt-0 ${b.ordered ? "list-decimal" : "list-disc"}`}>
          {b.items.map((it, i) => (
            <li key={i}>
              <Inline text={it} />
            </li>
          ))}
        </Tag>
      );
    }
    case "code":
      return <pre className="mono mt-2 overflow-x-auto rounded-control bg-raised px-3 py-2 text-ink first:mt-0">{b.text}</pre>;
    case "quote":
      return (
        <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-body text-ink-2 first:mt-0">
          <Inline text={b.text} />
        </blockquote>
      );
    case "rule":
      return <hr className="my-3 border-line" />;
  }
}

/** The body of a Markdown file as it reads, not as it is written. */
export function Preview({ body }: { body: string }) {
  const blocks = useMemo(() => parseMarkdown(body), [body]);
  if (blocks.length === 0) return <p className="text-body text-ink-2">There is no text in this file yet.</p>;
  return (
    <div className="selectable max-h-[min(420px,calc(var(--app-h)*0.5))] overflow-y-auto rounded-card border border-line bg-surface px-4 py-3">
      {blocks.map((b, i) => (
        <BlockView key={i} b={b} />
      ))}
    </div>
  );
}
