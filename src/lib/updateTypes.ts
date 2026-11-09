// What the updater tells the page. Mirrors crates/app/src/update.rs.

/** A newer version that is ready to download. */
export interface UpdateInfo {
  version: string;
  /** The release notes, or null when the release has none. */
  notes: string | null;
  /** The version running now. */
  current: string;
}

/** Download progress. `total` is null when the server does not say how big the file is. */
export interface UpdateProgress {
  downloaded: number;
  total: number | null;
  /** The file is down and verified; the installer is taking over. */
  installing: boolean;
}
