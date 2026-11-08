import type { ConfigSource } from "./types";

export function describeSource(source: ConfigSource): string {
  switch (source) {
    case "flag":
      return "Set when Atlas was launched";
    case "settings":
      return "Chosen in Settings";
    case "env":
      return "From CLAUDE_CONFIG_DIR";
    case "sandbox":
      return "Sandbox copy";
    default:
      return "Default location";
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
