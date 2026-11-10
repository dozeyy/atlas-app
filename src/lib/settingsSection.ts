// The Settings section last looked at, so Settings reopens where you left it (kept like the
// Toolkit tab). In its own file so another page can send you to one section ("Open Settings" on
// Now lands on Claude folder) without loading the Settings page itself.

const SECTION_KEY = "atlas.settings.section";

/** The saved section's id, or null when none was saved (or it cannot be read). */
export function savedSettingsSection(): string | null {
  try {
    return window.localStorage.getItem(SECTION_KEY);
  } catch {
    return null;
  }
}

/** Remember a section; Settings opens on it the next time it is shown. */
export function rememberSettingsSection(id: string): void {
  try {
    window.localStorage.setItem(SECTION_KEY, id);
  } catch {
    // the section just is not remembered
  }
}
