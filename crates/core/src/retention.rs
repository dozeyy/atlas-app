//! How long Claude Code keeps chat transcripts: the `cleanupPeriodDays` key in the user's Claude
//! Code `settings.json`, shown and changed from Settings > Claude folder.
//!
//! Claude Code's docs (code.claude.com/docs/en/settings-reference#cleanupperioddays): "Type: number
//! of days, a whole number, minimum 1. Default: 30. Setting 0 fails validation, so pick a large
//! value such as 3650 for long retention." Older Claude Code builds were reported to treat 0 as
//! "delete everything", so this module can never write 0: the only values it writes are `PICKS`,
//! and every write path ends in `assert_safe`.
//!
//! The write goes through `setup_write::edit_json_text`, the same backup, last-look, atomic-swap
//! and read-back path every other Atlas change uses. Only the one value changes: the bytes
//! around it (key order, other keys, spacing, BOM, line endings) are left as they were.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

use crate::setup_write::{self as sw, Style, WriteError};

type Res<T> = Result<T, WriteError>;

/// The settings key.
pub const KEY: &str = "cleanupPeriodDays";
/// What Claude Code uses when the key is missing.
pub const DEFAULT_DAYS: u32 = 30;
pub const YEAR_DAYS: u32 = 365;
/// "Forever": the large value the docs suggest (ten years). Never 0.
pub const FOREVER_DAYS: u32 = 3650;
/// The only values Atlas ever writes.
pub const PICKS: [u32; 3] = [DEFAULT_DAYS, YEAR_DAYS, FOREVER_DAYS];

/// What Settings shows for the key: what Claude Code will actually use, not just what the user's
/// own file says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Retention {
    /// A whole number of days, 1 or more, from managed settings when they set it, else the user's
    /// file. None when nothing sets it (Claude Code then uses `DEFAULT_DAYS`), when the value is
    /// not valid, or when it can't be known (`unknown`).
    pub days: Option<u32>,
    /// The winning value is there but is not a whole number of days, 1 or more. Claude Code will not accept it.
    pub invalid: bool,
    /// The user's settings file can't be read as JSON, so what it says is not known.
    pub unknown: bool,
    /// Why Atlas can't change it (plain words), or None when it can.
    pub locked: Option<String>,
    /// Plain words naming a project whose own settings file sets a different value. Only a note:
    /// it doesn't lock the picker or change `days`. None when no project does.
    pub project_note: Option<String>,
}

/// The JSON object in a settings file. A file that is missing, empty or only whitespace has
/// nothing in it (`Ok(None)`); one that is not valid JSON, or not an object, is `InvalidData`.
fn read_object(p: &Path) -> Result<Option<serde_json::Map<String, Value>>, std::io::Error> {
    let bytes = match fs::read(p) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let s = String::from_utf8_lossy(&bytes);
    let text = s.trim_start_matches('\u{feff}');
    if text.trim().is_empty() {
        return Ok(None);
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(m)) => Ok(Some(m)),
        _ => Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "not a JSON object")),
    }
}

/// The valid number of days a value stands for, if it is one.
fn days_of(v: &Value) -> Option<u32> {
    v.as_u64().filter(|d| *d >= 1).map(|d| d.min(u32::MAX as u64) as u32)
}

/// The value an organisation's managed settings give the key, if they set it: the base file, then
/// the drop-in files in name order, the last one that sets it winning. Managed settings win over
/// every other file. (Policy delivered through the registry, MDM or the claude.ai console is not
/// readable from here.)
fn managed_value(managed_dir: &Path) -> Option<Value> {
    let mut files = vec![managed_dir.join("managed-settings.json")];
    if let Ok(rd) = fs::read_dir(managed_dir.join("managed-settings.d")) {
        let mut drops: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "json")).collect();
        drops.sort();
        files.extend(drops);
    }
    files.iter().filter_map(|f| read_object(f).ok().flatten()).filter_map(|m| m.get(KEY).cloned()).next_back()
}

/// The projects whose own settings files set the key to a valid number of days, as (project
/// folder, days), in the order given (a project's local file before its shared one, one entry per
/// project). Claude Code lists the key as settable from any file, so the project it was started
/// in beats the user's file; Atlas can't know which project that is, so these are only a note.
/// A project file that is the user's own settings file (the home folder is a project, and its
/// `.claude/settings.json` is the Claude folder's) is not a project file.
fn project_overrides(projects: &[PathBuf], user_file: &Path) -> Vec<(PathBuf, u32)> {
    let user = fs::canonicalize(user_file).unwrap_or_else(|_| user_file.to_path_buf());
    let mut out = Vec::new();
    for dir in projects {
        for name in ["settings.local.json", "settings.json"] {
            let f = dir.join(".claude").join(name);
            if fs::canonicalize(&f).unwrap_or_else(|_| f.clone()) == user {
                continue;
            }
            if let Some(d) = read_object(&f).ok().flatten().and_then(|m| m.get(KEY).and_then(days_of)) {
                out.push((dir.clone(), d));
                break;
            }
        }
    }
    out
}

/// The quiet line under the picker: the first project that sets its own value, and how many more do.
fn override_note(over: &[(PathBuf, u32)]) -> Option<String> {
    let (dir, days) = over.first()?;
    let name = dir.file_name().map_or_else(|| dir.to_string_lossy().into_owned(), |n| n.to_string_lossy().into_owned());
    let more = match over.len() - 1 {
        0 => String::new(),
        n => format!(" (and {n} more)"),
    };
    Some(format!("{name} keeps chats for {}; its own settings file sets that{more}.", plain_days(*days)))
}

fn plain_days(d: u32) -> String {
    if d == 1 { "1 day".into() } else { format!("{d} days") }
}

/// What Claude Code will use and whether Atlas may change the user's file. `projects` are the
/// folders of the projects Atlas knows about; their `.claude` settings files can override the
/// user's for a chat started there, which `project_note` says.
pub fn inspect(config_dir: &Path, managed_dir: Option<&Path>, projects: &[PathBuf]) -> Retention {
    let file = config_dir.join("settings.json");
    let mut out = Retention { days: None, invalid: false, unknown: false, locked: None, project_note: None };

    // The user's own file: what the picker would change.
    let user = read_object(&file);
    let mut user_note: Option<String> = None;
    match &user {
        Ok(m) => {
            if let Some(v) = m.as_ref().and_then(|m| m.get(KEY)) {
                match days_of(v) {
                    Some(d) => out.days = Some(d),
                    None => out.invalid = true,
                }
            }
            if fs::metadata(&file).is_ok_and(|m| m.permissions().readonly()) {
                user_note = Some("Your Claude Code settings file is read-only.".into());
            }
        }
        Err(e) => {
            out.unknown = true;
            user_note = Some(if e.kind() == std::io::ErrorKind::InvalidData {
                "Your Claude Code settings file isn't valid JSON, so Atlas won't touch it.".into()
            } else {
                "Atlas can't read your Claude Code settings file.".into()
            });
        }
    }

    // Higher files win; the first one that sets the key is what Claude Code uses.
    let said = |v: &Value| days_of(v).map_or("a value it won't accept".to_string(), plain_days);
    if let Some(v) = managed_dir.and_then(managed_value) {
        out.days = days_of(&v);
        out.invalid = out.days.is_none();
        out.unknown = false;
        out.locked = Some(format!("Your organization sets this to {}, so Atlas can't change it.", said(&v)));
    } else {
        out.locked = user_note;
        // A project's own value doesn't lock the picker or replace the shown one: it is a note.
        out.project_note = override_note(&project_overrides(projects, &file));
    }
    out
}

/// The last gate before any byte is written: a pick Atlas offers, never 0 or anything outside the list.
fn assert_safe(days: u32) -> Res<()> {
    if days == 0 || !PICKS.contains(&days) {
        return Err(WriteError::Refused("Atlas only sets 30 days, a year or forever for saved sessions.".into()));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Changed {
    pub days: u32,
    /// The backup Atlas made first (Undo puts the file back from it). None when nothing needed writing.
    pub backup_id: Option<String>,
}

/// Set `cleanupPeriodDays` to one of `PICKS` in `<config_dir>/settings.json`.
pub fn set_days(config_dir: &Path, managed_dir: Option<&Path>, projects: &[PathBuf], backups: &Path, days: u32) -> Res<Changed> {
    set_days_hooked(config_dir, managed_dir, projects, backups, days, || {})
}

/// `set_days` with a hook that runs after the file has been read and before anything is written.
/// Tests use it to change the file in that gap, as Claude Code can; nothing else needs it.
#[doc(hidden)]
pub fn set_days_hooked(config_dir: &Path, managed_dir: Option<&Path>, projects: &[PathBuf], backups: &Path, days: u32, between: impl FnOnce()) -> Res<Changed> {
    assert_safe(days)?;
    let now = inspect(config_dir, managed_dir, projects);
    if let Some(why) = now.locked {
        return Err(WriteError::Refused(why));
    }
    if now.days == Some(days) {
        return Ok(Changed { days, backup_id: None });
    }
    let file: PathBuf = config_dir.join("settings.json");
    let id = sw::edit_json_text(
        &file,
        backups,
        "set-retention",
        "settings",
        "settings.json",
        &[KEY],
        |root| {
            root[KEY] = json!(days);
            Ok(())
        },
        |before, _, style| {
            assert_safe(days)?;
            between();
            set_member(before, KEY, &days.to_string(), style)
        },
    )?;
    sw::tag_backup(backups, &id, "user", &format!("Set how long Claude Code keeps sessions to {}", words(days)));
    Ok(Changed { days, backup_id: Some(id) })
}

fn words(days: u32) -> String {
    match days {
        YEAR_DAYS => "a year".into(),
        FOREVER_DAYS => "forever".into(),
        d => format!("{d} days"),
    }
}

// ---------------------------------------------------------------------------
// Changing one member's text without re-flowing the file
// ---------------------------------------------------------------------------

fn skip_ws(b: &[u8], mut i: usize) -> usize {
    while i < b.len() && matches!(b[i], b' ' | b'\t' | b'\r' | b'\n') {
        i += 1;
    }
    i
}

/// End (exclusive) of the string that starts at `i` (which holds the opening quote).
fn string_end(b: &[u8], mut i: usize) -> Option<usize> {
    i += 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// End (exclusive) of the JSON value that starts at `i`.
fn value_end(b: &[u8], i: usize) -> Option<usize> {
    match *b.get(i)? {
        b'"' => string_end(b, i),
        b'{' | b'[' => {
            let (mut depth, mut j) = (0usize, i);
            while j < b.len() {
                match b[j] {
                    b'"' => j = string_end(b, j)?,
                    b'{' | b'[' => {
                        depth += 1;
                        j += 1;
                    }
                    b'}' | b']' => {
                        depth = depth.checked_sub(1)?;
                        j += 1;
                        if depth == 0 {
                            return Some(j);
                        }
                    }
                    _ => j += 1,
                }
            }
            None
        }
        _ => {
            let mut j = i;
            while j < b.len() && !matches!(b[j], b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n') {
                j += 1;
            }
            (j > i).then_some(j)
        }
    }
}

struct Member {
    key: String,
    key_start: usize,
    val_start: usize,
    val_end: usize,
}

/// The top-level members of the object in `b` (after any BOM) and the position of its closing brace.
fn scan_object(b: &[u8], from: usize) -> Option<(usize, Vec<Member>, usize)> {
    let open = skip_ws(b, from);
    if b.get(open) != Some(&b'{') {
        return None;
    }
    let mut members = Vec::new();
    let mut i = open + 1;
    loop {
        i = skip_ws(b, i);
        match *b.get(i)? {
            b'}' => return Some((open, members, i)),
            b'"' => {
                let key_start = i;
                let ke = string_end(b, i)?;
                let key: String = serde_json::from_slice(&b[key_start..ke]).ok()?;
                i = skip_ws(b, ke);
                if b.get(i) != Some(&b':') {
                    return None;
                }
                let val_start = skip_ws(b, i + 1);
                let val_end = value_end(b, val_start)?;
                members.push(Member { key, key_start, val_start, val_end });
                i = skip_ws(b, val_end);
                match *b.get(i)? {
                    b',' => i += 1,
                    b'}' => return Some((open, members, i)),
                    _ => return None,
                }
            }
            _ => return None,
        }
    }
}

/// `before` with the top-level member `key` set to the number text `value`: replaced in place when
/// it is there, else added after the last member in the file's own indentation. A file that is not
/// there yet gets a small new object. Anything unexpected returns an error and nothing is changed.
pub(crate) fn set_member(before: Option<&[u8]>, key: &str, value: &str, style: &Style) -> Res<Vec<u8>> {
    let nl = if style.crlf { "\r\n" } else { "\n" };
    let indent = String::from_utf8_lossy(&style.indent).into_owned();
    let member = format!("\"{key}\": {value}");
    let blank = |b: &[u8]| String::from_utf8_lossy(b).trim_start_matches('\u{feff}').trim().is_empty();
    let Some(b) = before.filter(|b| !blank(b)) else {
        // Not there, or empty: a small new object (keeping a BOM the empty file had).
        let bom = if before.is_some_and(|b| b.starts_with(&[0xEF, 0xBB, 0xBF])) { "\u{feff}" } else { "" };
        return Ok(format!("{bom}{{{nl}{indent}{member}{nl}}}{nl}").into_bytes());
    };
    let bom = if b.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
    let odd = || WriteError::Refused("Atlas could not find its place in your Claude Code settings file, so nothing was changed.".to_string());
    let (open, members, close) = scan_object(b, bom).ok_or_else(odd)?;
    let same: Vec<&Member> = members.iter().filter(|m| m.key == key).collect();
    let mut out = Vec::with_capacity(b.len() + member.len() + 8);
    match same.as_slice() {
        [m] => {
            out.extend_from_slice(&b[..m.val_start]);
            out.extend_from_slice(value.as_bytes());
            out.extend_from_slice(&b[m.val_end..]);
        }
        [] => match members.last() {
            None => {
                out.extend_from_slice(&b[..open + 1]);
                out.extend_from_slice(format!("{nl}{indent}{member}{nl}").as_bytes());
                out.extend_from_slice(&b[close..]);
            }
            Some(last) => {
                // Same indentation as the member before it; a one-line object gets a one-line member.
                let line_start = b[..last.key_start].iter().rposition(|c| *c == b'\n').map_or(0, |p| p + 1);
                let lead = &b[line_start..last.key_start];
                let glue = if lead.iter().all(|c| matches!(c, b' ' | b'\t')) && line_start >= bom && b[..last.key_start].contains(&b'\n') {
                    format!(",{nl}{}{member}", String::from_utf8_lossy(lead))
                } else {
                    format!(", {member}")
                };
                out.extend_from_slice(&b[..last.val_end]);
                out.extend_from_slice(glue.as_bytes());
                out.extend_from_slice(&b[last.val_end..]);
            }
        },
        _ => return Err(WriteError::Refused("Your Claude Code settings file lists this setting more than once, so Atlas left it alone.".into())),
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn st() -> Style {
        Style::default()
    }

    fn set(src: &str, n: u32) -> String {
        String::from_utf8(set_member(Some(src.as_bytes()), KEY, &n.to_string(), &st()).unwrap()).unwrap()
    }

    #[test]
    fn replaces_in_place_and_touches_nothing_else() {
        let src = "{\n  \"a\": [1,2,  3],\n  \"cleanupPeriodDays\": 90,\n  \"z\": {\"k\":  true}\n}\n";
        assert_eq!(set(src, 365), "{\n  \"a\": [1,2,  3],\n  \"cleanupPeriodDays\": 365,\n  \"z\": {\"k\":  true}\n}\n");
    }

    #[test]
    fn adds_after_the_last_member_in_its_indentation() {
        assert_eq!(set("{\n    \"a\": 1\n}\n", 3650), "{\n    \"a\": 1,\n    \"cleanupPeriodDays\": 3650\n}\n");
        assert_eq!(set("{\n\t\"a\": {\n\t\t\"b\": 2\n\t}\n}", 30), "{\n\t\"a\": {\n\t\t\"b\": 2\n\t},\n\t\"cleanupPeriodDays\": 30\n}");
        assert_eq!(set("{\"a\":1}", 30), "{\"a\":1, \"cleanupPeriodDays\": 30}");
    }

    #[test]
    fn keeps_bom_and_crlf() {
        let sty = Style { crlf: true, ..Style::default() };
        let src = "\u{feff}{\r\n  \"a\": 1\r\n}\r\n";
        let out = set_member(Some(src.as_bytes()), KEY, "365", &sty).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "\u{feff}{\r\n  \"a\": 1,\r\n  \"cleanupPeriodDays\": 365\r\n}\r\n");
        let out = set_member(Some(b"{}"), KEY, "30", &sty).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "{\r\n  \"cleanupPeriodDays\": 30\r\n}");
    }

    #[test]
    fn empty_object_and_missing_file() {
        assert_eq!(set("{}\n", 30), "{\n  \"cleanupPeriodDays\": 30\n}\n");
        assert_eq!(set("{\n}\n", 30), "{\n  \"cleanupPeriodDays\": 30\n}\n");
        let out = set_member(None, KEY, "365", &st()).unwrap();
        assert_eq!(String::from_utf8(out).unwrap(), "{\n  \"cleanupPeriodDays\": 365\n}\n");
    }

    #[test]
    fn a_nested_or_string_lookalike_is_not_the_key() {
        let src = "{\n  \"x\": {\"cleanupPeriodDays\": 5},\n  \"note\": \"cleanupPeriodDays: 7 \\\" }\"\n}\n";
        let out = set(src, 365);
        assert!(out.contains("\"x\": {\"cleanupPeriodDays\": 5}"));
        assert!(out.contains("\"note\": \"cleanupPeriodDays: 7 \\\" }\","), "{out}");
        assert!(out.ends_with("  \"cleanupPeriodDays\": 365\n}\n"), "{out}");
    }

    #[test]
    fn a_repeated_key_or_a_non_object_is_refused() {
        let dup = "{\"cleanupPeriodDays\": 1, \"cleanupPeriodDays\": 2}";
        assert!(set_member(Some(dup.as_bytes()), KEY, "30", &st()).is_err());
        assert!(set_member(Some(b"[1]"), KEY, "30", &st()).is_err());
        assert!(set_member(Some(b"nope"), KEY, "30", &st()).is_err());
    }

    #[test]
    fn only_the_three_picks_pass_the_gate() {
        for ok in PICKS {
            assert!(assert_safe(ok).is_ok());
        }
        for bad in [0, 1, 29, 31, 90, 364, 3649, 3651, 36500, u32::MAX] {
            assert!(assert_safe(bad).is_err(), "{bad} must be refused");
        }
        assert!(!PICKS.contains(&0));
    }
}
