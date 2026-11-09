// Pure: which family a model id belongs to, so the helper map can give each its own icon.

export type ModelFamily = "opus" | "sonnet" | "haiku" | "fable" | "other";

export const FAMILIES: ModelFamily[] = ["opus", "sonnet", "haiku", "fable", "other"];

export const FAMILY_NAME: Record<ModelFamily, string> = {
  opus: "Opus",
  sonnet: "Sonnet",
  haiku: "Haiku",
  fable: "Fable",
  other: "Other model",
};

/** "claude-opus-5-5" -> "opus". Anything that names none of the families is "other". */
export function modelFamily(model: string | null | undefined): ModelFamily {
  const id = (model ?? "").toLowerCase();
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  if (id.includes("fable")) return "fable";
  return "other";
}
