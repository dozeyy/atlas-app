//! `habits.json` in Atlas's own data folder (D43): which repeated requests Claude already
//! offered to turn into a skill, and what the person said. Ids, answers, times and skill names
//! only: never any prompt text, so the file is safe to keep and to show.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub const FILE: &str = "habits.json";
pub const SCHEMA_VERSION: u32 = 1;
/// A skill name is a folder name: lowercase letters, digits, dashes.
pub const SKILL_NAME_MAX: usize = 40;
const LOCK_WAIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Answer {
    /// Claude made the offer; the person has not answered yet (or never did).
    Offered,
    Declined,
    /// A skill was saved.
    Made,
    /// "Stop asking": no more offers at all.
    Never,
}

impl Answer {
    pub fn parse(s: &str) -> Option<Answer> {
        match s.trim().to_lowercase().as_str() {
            "offered" => Some(Answer::Offered),
            "declined" => Some(Answer::Declined),
            "made" => Some(Answer::Made),
            "never" => Some(Answer::Never),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub answer: Answer,
    pub at_ms: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_name: Option<String>,
    /// Other ids the same request has been known by (hashes of its wordings), so the answer
    /// still applies after the group's leader changes as more asks come in.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notes {
    pub schema_version: u32,
    pub offers_off: bool,
    pub groups: BTreeMap<String, Note>,
}

impl Default for Notes {
    fn default() -> Self {
        Notes { schema_version: SCHEMA_VERSION, offers_off: false, groups: BTreeMap::new() }
    }
}

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE)
}

impl Notes {
    /// The file's contents. No file yet is an empty record. A file that exists but cannot be
    /// read or parsed is treated as "offers off": a damaged record must not bring back offers
    /// the person already answered, so Atlas stays quiet until the file is fixed.
    pub fn load(data_dir: &Path) -> Notes {
        match std::fs::read(path(data_dir)) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|_| Notes::unreadable()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Notes::default(),
            Err(_) => Notes::unreadable(),
        }
    }

    fn unreadable() -> Notes {
        Notes { offers_off: true, ..Notes::default() }
    }

    /// The newest answer filed under any of `ids`.
    pub fn offer_for<'a>(&'a self, ids: impl IntoIterator<Item = &'a str>) -> Option<&'a Note> {
        let ids: Vec<&str> = ids.into_iter().collect();
        self.groups
            .iter()
            .filter(|(k, n)| ids.iter().any(|i| *i == k.as_str() || n.aliases.iter().any(|a| a == i)))
            .max_by(|(ka, a), (kb, b)| a.at_ms.cmp(&b.at_ms).then_with(|| kb.cmp(ka)))
            .map(|(_, n)| n)
    }
}

/// Record an answer. `id` and `aliases` are hex ids; `never` also turns every offer off.
/// Read-modify-write under the write lock all Atlas processes share.
pub fn record(data_dir: &Path, id: Option<&str>, aliases: &[String], answer: Answer, skill_name: Option<&str>, now_ms: i64) -> Result<Notes, String> {
    let _guard = crate::writelock::acquire(data_dir, LOCK_WAIT).map_err(|e| e.to_string())?;
    let file = path(data_dir);
    let mut notes = match std::fs::read(&file) {
        Ok(bytes) => match serde_json::from_slice::<Notes>(&bytes) {
            Ok(n) => n,
            Err(_) => {
                // Keep the unreadable file instead of overwriting it.
                let _ = std::fs::rename(&file, data_dir.join(format!("{FILE}.bad-{now_ms}")));
                Notes::unreadable()
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Notes::default(),
        Err(_) => Notes::unreadable(),
    };
    if answer == Answer::Never {
        notes.offers_off = true;
    }
    if let Some(id) = id {
        let mut aliases: Vec<String> = aliases.iter().filter(|a| a.as_str() != id && valid_id(a)).cloned().collect();
        aliases.sort();
        aliases.dedup();
        aliases.truncate(super::cluster::MEMBER_IDS + 1);
        notes.groups.insert(id.to_string(), Note { answer, at_ms: now_ms, skill_name: skill_name.map(str::to_string), aliases });
    }
    notes.schema_version = SCHEMA_VERSION;
    let bytes = serde_json::to_vec_pretty(&notes).map_err(|e| e.to_string())?;
    crate::fsutil::atomic_write(&file, &bytes).map_err(|e| format!("Atlas could not save habits.json: {e}"))?;
    Ok(notes)
}

/// 16 lowercase hex characters: an id from `cluster::id16`.
pub fn valid_id(s: &str) -> bool {
    s.len() == 16 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// A skill name as the draft template allows it: `[a-z0-9-]`, 1 to 40 characters.
pub fn valid_skill_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= SKILL_NAME_MAX && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbb";
    const C: &str = "cccccccccccccccc";

    #[test]
    fn answers_are_stored_by_id_and_found_by_alias() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(Notes::load(d.path()), Notes::default());
        record(d.path(), Some(A), &[B.to_string(), A.to_string(), "not-an-id".into()], Answer::Declined, None, 1000).unwrap();
        let n = Notes::load(d.path());
        assert!(!n.offers_off);
        assert_eq!(n.groups[A].aliases, vec![B.to_string()], "own id and junk are not aliases");
        // The leader changed to B: the answer filed under A still applies.
        assert_eq!(n.offer_for([B].into_iter()).map(|x| x.answer), Some(Answer::Declined));
        assert_eq!(n.offer_for([C].into_iter()), None);
    }

    #[test]
    fn the_newest_answer_wins_and_never_turns_offers_off() {
        let d = tempfile::tempdir().unwrap();
        record(d.path(), Some(A), &[], Answer::Offered, None, 1000).unwrap();
        record(d.path(), Some(A), &[], Answer::Made, Some("standup-notes"), 2000).unwrap();
        let n = Notes::load(d.path());
        let o = n.offer_for([A]).unwrap();
        assert_eq!((o.answer, o.at_ms, o.skill_name.as_deref()), (Answer::Made, 2000, Some("standup-notes")));
        let n = record(d.path(), None, &[], Answer::Never, None, 3000).unwrap();
        assert!(n.offers_off && Notes::load(d.path()).offers_off);
    }

    #[test]
    fn an_unreadable_file_is_kept_aside_not_overwritten() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(path(d.path()), b"{ not json").unwrap();
        record(d.path(), Some(A), &[], Answer::Offered, None, 5).unwrap();
        assert!(Notes::load(d.path()).groups.contains_key(A));
        assert_eq!(std::fs::read(d.path().join("habits.json.bad-5")).unwrap(), b"{ not json");
    }

    #[test]
    fn a_damaged_file_keeps_offers_off_until_it_is_fixed() {
        let d = tempfile::tempdir().unwrap();
        std::fs::write(path(d.path()), b"{ not json").unwrap();
        assert!(Notes::load(d.path()).offers_off, "unreadable means quiet");
        // Recording an answer over the damaged file keeps the quiet default too.
        let n = record(d.path(), Some(A), &[], Answer::Declined, None, 7).unwrap();
        assert!(n.offers_off);
        // A missing file is a normal fresh start.
        let e = tempfile::tempdir().unwrap();
        assert!(!Notes::load(e.path()).offers_off);
    }

    #[test]
    fn names_and_ids_are_checked() {
        assert!(valid_id(A) && !valid_id("ABCDEF0123456789") && !valid_id("abc"));
        assert!(valid_skill_name("standup-notes-2") && !valid_skill_name("Standup") && !valid_skill_name("a b") && !valid_skill_name(&"a".repeat(41)));
    }
}
