import { useAtlas } from "../state/AtlasProvider";
import { modName } from "./appMenu";

/**
 * Keyboard shortcut hints are opt-in (Settings > Show shortcuts, off by default). Every place that
 * draws a key next to a name asks here, so one switch covers tooltips, search badges and menus.
 * The shortcuts themselves always work, and Help > Keyboard shortcuts always lists them.
 */
export function withKeys(label: string, keys: string, show: boolean): string {
  return show ? `${label} (${keys})` : label;
}

/** `{ show, mod, tip }`: whether hints are on, the platform's modifier name, and a name-plus-keys builder. */
export function useKeyHints() {
  const { info } = useAtlas();
  const show = info.settings.showShortcuts === true;
  const mod = modName(info.platform);
  return { show, mod, tip: (label: string, keys: string) => withKeys(label, keys, show) };
}
