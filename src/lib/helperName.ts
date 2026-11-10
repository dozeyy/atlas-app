// How a helper's name is written. Pure text, no React: the model code (Now's progress lines, the
// Wrapped slides) and the pages share it.

/**
 * A helper's name as it is shown: a name made from a type ("ui-builder" becomes "Ui builder")
 * gets its short forms back in capitals, "UI builder". Only these six, only as whole words, and
 * nothing else in the name is touched ("Build" keeps its "ui", "price" its "pr"). Every page that
 * shows a name made from a helper's type passes it through here; a name a person or Claude wrote
 * (a description, a prompt) is left as written.
 */
export function helperName(name: string): string {
  return name.replace(/(^|[^A-Za-z0-9])(ui|qa|api|mcp|ci|pr)(?![A-Za-z0-9])/gi, (_, before: string, word: string) => before + word.toUpperCase());
}

/** A helper's name for the page: `helperName` when the name was made from its type, else as written. */
export function shownName(agent: { name: string; nameSource?: string }): string {
  return agent.nameSource === "type" ? helperName(agent.name) : agent.name;
}

/** "code-reviewer" -> "Code reviewer", "general-purpose" -> "General purpose", "ui-builder" -> "UI builder". */
export function typeName(t: string | null): string {
  if (!t) return "Helper";
  const s = t.replace(/[-_]+/g, " ").trim();
  return s ? helperName(s.charAt(0).toUpperCase() + s.slice(1)) : "Helper";
}
