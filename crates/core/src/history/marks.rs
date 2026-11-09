//! Who made a change: the part of History that knows a change came from Claude through the
//! Atlas MCP server (or the in-app assistant) rather than from the user.
//!
//! Every change those two make goes through `setup_write` and leaves a tagged backup in
//! `<data dir>/setup-backups/`. History's scan reads those tags back as `Marks`, so the row for
//! the change says "edited by Claude" instead of "changed". Matching is exact (file plus the
//! SHA-256 of what the change left), so a later edit by anyone else is never mislabelled.

use std::collections::HashMap;
use std::path::Path;

use crate::setup_write::provenance;

use super::file_key;

/// How far back tagged changes are remembered (older ones were scanned long ago).
const WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
/// `.claude.json` has no per-change hash in History (it is shown as one redacted view), so a
/// tagged change to it only counts for a short time after it was made.
const CLAUDE_JSON_MS: i64 = 2 * 60 * 1000;

/// The source word History stores for a change made through the MCP server.
pub const SOURCE_MCP: &str = "atlas_mcp";
/// ... and for one the in-app assistant made.
pub const SOURCE_ASSISTANT: &str = "atlas_assistant";
/// ... and for one installed or removed from the Library tab.
pub const SOURCE_LIBRARY: &str = "atlas_library";

/// Map the word a backup is tagged with to the word History stores.
pub fn history_source(tag: &str) -> Option<&'static str> {
    match tag {
        "mcp" => Some(SOURCE_MCP),
        "assistant" => Some(SOURCE_ASSISTANT),
        "library" => Some(SOURCE_LIBRARY),
        _ => None,
    }
}

#[derive(Debug, Default, Clone)]
pub struct Marks {
    /// `<file key>|<sha256>` -> source
    by_version: HashMap<String, &'static str>,
    /// (file key, source) of deletes: the key itself, or a folder holding it
    removed: Vec<(String, &'static str)>,
    /// (when, source) of the newest tagged change to `.claude.json`
    claude_json: Option<(i64, &'static str)>,
}

impl Marks {
    /// Read the tags from the backups folder. Anything unreadable is simply not marked.
    pub fn from_backups(backups: &Path, claude_json: &Path, now_ms: i64) -> Marks {
        let mut m = Marks::default();
        let cj_key = file_key(claude_json);
        let since = (now_ms - WINDOW_MS).max(0) as u64;
        for p in provenance(backups, since) {
            let Some(src) = history_source(&p.source) else { continue };
            let key = file_key(Path::new(&p.path));
            if key == cj_key {
                let at = p.created_ms as i64;
                if m.claude_json.is_none_or(|(t, _)| at > t) {
                    m.claude_json = Some((at, src));
                }
                continue;
            }
            // A folder made from the Library: one exact version per file it holds.
            for (file, sha) in &p.files {
                m.by_version.insert(format!("{}|{sha}", file_key(Path::new(file))), src);
            }
            match p.saved_sha {
                Some(sha) => {
                    m.by_version.insert(format!("{key}|{sha}"), src);
                }
                None if p.action == "delete" => m.removed.push((key, src)),
                None => {}
            }
        }
        m
    }

    pub fn is_empty(&self) -> bool {
        self.by_version.is_empty() && self.removed.is_empty() && self.claude_json.is_none()
    }

    /// The source of the version of file `key` with this hash, when a tagged change made it.
    pub fn version(&self, key: &str, sha: &str) -> Option<&'static str> {
        self.by_version.get(&format!("{key}|{sha}")).copied()
    }

    /// The source of the delete that removed the item with this key.
    pub fn removal(&self, key: &str) -> Option<&'static str> {
        self.removed.iter().find(|(k, _)| key == k || key.strip_prefix(k.as_str()).is_some_and(|rest| rest.starts_with('/'))).map(|(_, s)| *s)
    }

    /// The source of a recent tagged change to the MCP part of `.claude.json`.
    pub fn claude_json_recent(&self, now_ms: i64) -> Option<&'static str> {
        self.claude_json.filter(|(t, _)| now_ms - t <= CLAUDE_JSON_MS).map(|(_, s)| s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removal_matches_the_item_or_a_folder_holding_it() {
        let mut m = Marks::default();
        m.removed.push(("f:C:/c/skills/x".into(), SOURCE_MCP));
        assert_eq!(m.removal("f:C:/c/skills/x/SKILL.md"), Some(SOURCE_MCP));
        assert_eq!(m.removal("f:C:/c/skills/x"), Some(SOURCE_MCP));
        assert_eq!(m.removal("f:C:/c/skills/xy/SKILL.md"), None);
    }

    #[test]
    fn only_mcp_and_assistant_tags_count() {
        assert_eq!(history_source("mcp"), Some(SOURCE_MCP));
        assert_eq!(history_source("assistant"), Some(SOURCE_ASSISTANT));
        assert_eq!(history_source("library"), Some(SOURCE_LIBRARY));
        assert_eq!(history_source("user"), None);
    }
}
