import type { Platform } from "./types";

/** The sheets the menu can open. Each is a small modal; see HelpSheets. */
export type SheetId = "about" | "guide" | "shortcuts" | "privacy" | "terms" | "report";

export interface MenuEntry {
  id: string;
  label: string;
  /** Opens this sheet. */
  sheet?: SheetId;
  /** A submenu. An entry has either `sheet` or `items`. */
  items?: MenuEntry[];
  /** Does this when picked. Its shortcut is drawn at the right edge. */
  action?: "palette";
}

/**
 * The app menu (the three lines at the top left, like the Claude app). A new menu or entry is one
 * more line here.
 */
export const APP_MENU: MenuEntry[] = [
  { id: "jump", label: "Quick jump", action: "palette" },
  {
    id: "help",
    label: "Help",
    items: [
      { id: "about", label: "About Atlas", sheet: "about" },
      { id: "guide", label: "How to use Atlas", sheet: "guide" },
      { id: "shortcuts", label: "Keyboard shortcuts", sheet: "shortcuts" },
      { id: "privacy", label: "Privacy", sheet: "privacy" },
      { id: "terms", label: "Terms of service", sheet: "terms" },
      { id: "report", label: "Report a problem", sheet: "report" },
    ],
  },
];

export const modName = (platform: Platform) => (platform === "macos" ? "Cmd" : "Ctrl");

/** Every keyboard shortcut Atlas has, for the Keyboard shortcuts sheet and the tests. */
export function shortcutGroups(platform: Platform): { title: string; rows: { keys: string; does: string }[] }[] {
  const mod = modName(platform);
  const alt = platform === "macos" ? "Option" : "Alt";
  return [
    {
      title: "Anywhere",
      rows: [
        { keys: `${mod}+K`, does: "Jump to a chat, page, project or skill; arrows move, Enter goes, Escape closes" },
        { keys: `${mod}+1 to ${mod}+7`, does: "Go to Dashboard, Now, Sessions, Toolkit, History, Settings, Wrapped" },
        { keys: `${mod}+B`, does: "Show or hide the sidebar" },
        ...(platform === "macos"
          ? [
              { keys: "Cmd+,", does: "Open Settings" },
              { keys: "Cmd+W / Cmd+Q", does: "Close the window (Atlas stays in the Dock) / quit Atlas" },
            ]
          : []),
        { keys: platform === "macos" ? "F10" : "Alt or F10", does: "Open the menu; arrow keys move, Enter picks, Escape closes" },
      ],
    },
    {
      title: "Sessions",
      rows: [
        { keys: `Escape or ${alt}+Left`, does: "Go back to the list from an open chat" },
        { keys: `${alt}+Up / ${alt}+Down`, does: "Open the previous or next chat" },
      ],
    },
    {
      title: "Toolkit",
      rows: [
        { keys: `${mod}+F`, does: "Search the open list" },
        { keys: "Up / Down", does: "Move between cards" },
        { keys: "Escape", does: "Clear the search, then go back to the tiles" },
        { keys: `${mod}+C`, does: "Copy the path of the selected item" },
      ],
    },
    {
      title: "History",
      rows: [
        { keys: `${mod}+F`, does: "Search the changes" },
        { keys: "Up / Down", does: "Move between changes" },
      ],
    },
    {
      title: "Charts",
      rows: [
        { keys: "Left / Right", does: "Move between bars; the readout follows" },
        { keys: "Escape", does: "Clear the readout" },
      ],
    },
  ];
}
