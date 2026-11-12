//! "Keep sessions longer": the one `cleanupPeriodDays` write, against temp copies of
//! `fixtures/claude-basic`. Nothing real is opened. The value written is only ever 30, 365 or
//! 3650 (never 0, which Claude Code's docs say fails validation and which older builds may treat
//! as "delete everything"), the backup holds the exact old bytes, and Undo puts them back.

use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::retention::{inspect, set_days, set_days_hooked, FOREVER_DAYS, KEY, PICKS, YEAR_DAYS};
use atlas_core::setup_write::{list_backups_detailed, restore_any, Confine, WriteError};
use serde_json::Value;

struct Fx {
    _t: tempfile::TempDir,
    dir: PathBuf,
    backups: PathBuf,
    managed: PathBuf,
}

impl Fx {
    /// A copy of the basic fixture's settings.json (plus whatever else it has) in a scratch folder.
    fn new() -> Fx {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path().join("claude");
        fs::create_dir_all(&dir).unwrap();
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-basic").join("settings.json");
        fs::copy(src, dir.join("settings.json")).unwrap();
        let backups = t.path().join("data").join("backups");
        let managed = t.path().join("managed");
        Fx { _t: t, dir, backups, managed }
    }
    fn file(&self) -> PathBuf {
        self.dir.join("settings.json")
    }
    fn bytes(&self) -> Vec<u8> {
        fs::read(self.file()).unwrap()
    }
    fn write(&self, b: &[u8]) {
        fs::write(self.file(), b).unwrap();
    }
    fn set(&self, days: u32) -> Result<atlas_core::retention::Changed, WriteError> {
        set_days(&self.dir, Some(&self.managed), &[], &self.backups, days)
    }
    fn confine(&self) -> Confine {
        Confine::new(&self.dir, &self.dir.join(".claude.json"), [])
    }
    fn json(&self) -> Value {
        serde_json::from_slice(&self.bytes()).unwrap()
    }
    fn backup_count(&self) -> usize {
        list_backups_detailed(&self.backups, usize::MAX).len()
    }
}

/// `after` is `before` with the one `"cleanupPeriodDays": N` member added after the last member.
fn only_the_key_added(before: &[u8], after: &[u8], n: u32) {
    let (b, a) = (String::from_utf8(before.to_vec()).unwrap(), String::from_utf8(after.to_vec()).unwrap());
    let close = b.trim_end().rfind('}').unwrap();
    let head = b[..close].trim_end();
    let tail = &b[close..];
    assert!(a.starts_with(head), "text before the new key changed");
    assert!(a.ends_with(tail), "text after the new key changed");
    let mid = &a[head.len()..a.len() - tail.len()];
    assert_eq!(mid.replace("\r\n", "\n"), format!(",\n  \"{KEY}\": {n}\n"));
}

#[test]
fn missing_key_reads_as_the_default_and_a_pick_adds_only_that_key() {
    let fx = Fx::new();
    let original = fx.bytes();
    assert!(fx.json().get(KEY).is_none(), "the fixture must start without the key");
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert_eq!((r.days, r.invalid, r.locked), (None, false, None));
    assert_eq!(fx.bytes(), original, "reading changes nothing");

    let out = fx.set(YEAR_DAYS).unwrap();
    assert_eq!(out.days, 365);
    assert!(out.backup_id.is_some());
    only_the_key_added(&original, &fx.bytes(), 365);
    let mut expect: Value = serde_json::from_slice(&original).unwrap();
    expect[KEY] = 365.into();
    assert_eq!(fx.json(), expect, "every other key keeps its value");
    // key order: every old key still comes in the same order, the new one last
    let keys: Vec<String> = fx.json().as_object().unwrap().keys().cloned().collect();
    let mut old_keys: Vec<String> = serde_json::from_slice::<Value>(&original).unwrap().as_object().unwrap().keys().cloned().collect();
    old_keys.push(KEY.into());
    assert_eq!(keys, old_keys);
    assert_eq!(inspect(&fx.dir, Some(&fx.managed), &[]).days, Some(365));
}

#[test]
fn each_pick_writes_exactly_its_number_and_forever_is_never_zero() {
    for (days, expect) in [(30u32, 30u64), (365, 365), (FOREVER_DAYS, 3650)] {
        let fx = Fx::new();
        fx.set(days).unwrap();
        let v = fx.json()[KEY].as_u64().unwrap();
        assert_eq!(v, expect);
        assert!(v >= 1);
    }
    assert_eq!(FOREVER_DAYS, 3650);
    assert!(PICKS.iter().all(|d| *d >= 1));
}

#[test]
fn existing_values_are_shown_as_they_are_and_replaced_in_place() {
    for (text, shows) in [("30", 30u32), ("365", 365), ("3650", 3650), ("90", 90)] {
        let fx = Fx::new();
        fx.write(format!("{{\n  \"a\": [1,   2],\n  \"{KEY}\": {text},\n  \"z\": \"last\"\n}}\n").as_bytes());
        let r = inspect(&fx.dir, Some(&fx.managed), &[]);
        assert_eq!((r.days, r.invalid), (Some(shows), false), "{text}");
        // Not touched until the user picks.
        assert_eq!(fx.backup_count(), 0);
        let target = if shows == 365 { FOREVER_DAYS } else { YEAR_DAYS };
        let before = fx.bytes();
        fx.set(target).unwrap();
        let expect = String::from_utf8(before).unwrap().replace(&format!("\"{KEY}\": {text}"), &format!("\"{KEY}\": {target}"));
        assert_eq!(String::from_utf8(fx.bytes()).unwrap(), expect, "only the number changed ({text})");
    }
}

#[test]
fn picking_the_value_already_set_writes_nothing() {
    let fx = Fx::new();
    fx.write(format!("{{\"{KEY}\": 365}}\n").as_bytes());
    let before = fx.bytes();
    let out = fx.set(365).unwrap();
    assert!(out.backup_id.is_none());
    assert_eq!(fx.bytes(), before);
    assert_eq!(fx.backup_count(), 0);
}

#[test]
fn the_backup_holds_the_old_bytes_and_undo_restores_them_exactly() {
    let fx = Fx::new();
    let original = fx.bytes();
    let id = fx.set(FOREVER_DAYS).unwrap().backup_id.unwrap();
    assert_ne!(fx.bytes(), original);
    let infos = list_backups_detailed(&fx.backups, usize::MAX);
    assert_eq!(infos.len(), 1);
    assert_eq!(infos[0].backup_id, id);
    assert!(infos[0].can_restore);
    assert!(infos[0].summary.as_deref().unwrap_or("").contains("forever"));
    // The copy on disk is the exact old file.
    assert_eq!(fs::read(fx.backups.join(&id).join("file-before")).unwrap(), original);
    restore_any(&fx.backups, &id, &fx.confine()).unwrap();
    assert_eq!(fx.bytes(), original, "Undo gives back the exact original bytes");
}

#[test]
fn undo_after_replacing_a_custom_value_brings_the_custom_value_back() {
    let fx = Fx::new();
    fx.write(format!("{{\n  \"keep\": true,\n  \"{KEY}\": 90\n}}\n").as_bytes());
    let original = fx.bytes();
    let id = fx.set(YEAR_DAYS).unwrap().backup_id.unwrap();
    assert_eq!(fx.json()[KEY], 365);
    restore_any(&fx.backups, &id, &fx.confine()).unwrap();
    assert_eq!(fx.bytes(), original);
    assert_eq!(inspect(&fx.dir, Some(&fx.managed), &[]).days, Some(90));
}

#[test]
fn bom_crlf_tabs_unknown_keys_and_odd_spacing_survive() {
    let fx = Fx::new();
    let src = "\u{feff}{\r\n\t\"future\": {\"x\":   [1,2,3]},\r\n\t\"model\": \"m\"\r\n}\r\n";
    fx.write(src.as_bytes());
    fx.set(YEAR_DAYS).unwrap();
    let out = String::from_utf8(fx.bytes()).unwrap();
    assert_eq!(out, "\u{feff}{\r\n\t\"future\": {\"x\":   [1,2,3]},\r\n\t\"model\": \"m\",\r\n\t\"cleanupPeriodDays\": 365\r\n}\r\n");
}

#[test]
fn a_missing_file_is_created_and_undo_removes_it_again() {
    let fx = Fx::new();
    fs::remove_file(fx.file()).unwrap();
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert_eq!((r.days, r.invalid, r.locked), (None, false, None));
    let id = fx.set(YEAR_DAYS).unwrap().backup_id.unwrap();
    assert_eq!(String::from_utf8(fx.bytes()).unwrap(), "{\n  \"cleanupPeriodDays\": 365\n}\n");
    restore_any(&fx.backups, &id, &fx.confine()).unwrap();
    assert!(!fx.file().exists());
}

#[test]
fn a_value_claude_code_would_reject_is_flagged_and_a_pick_repairs_it() {
    for bad in ["0", "-5", "\"30\"", "1.5", "null", "true", "[30]"] {
        let fx = Fx::new();
        fx.write(format!("{{\"{KEY}\": {bad}}}\n").as_bytes());
        let r = inspect(&fx.dir, Some(&fx.managed), &[]);
        assert_eq!((r.days, r.invalid), (None, true), "{bad}");
        fx.set(YEAR_DAYS).unwrap();
        assert_eq!(fx.json()[KEY], 365, "{bad}");
    }
}

#[test]
fn nothing_but_the_three_picks_can_ever_be_written_least_of_all_zero() {
    let fx = Fx::new();
    let original = fx.bytes();
    let mut tried = vec![0u32, 1, 7, 29, 31, 90, 364, 366, 3649, 3651, 36_500, 1_000_000, u32::MAX];
    tried.extend(0..=4000);
    for bad in tried.into_iter().filter(|d| !PICKS.contains(d)) {
        assert!(matches!(fx.set(bad), Err(WriteError::Refused(_))), "{bad} must be refused");
    }
    assert_eq!(fx.bytes(), original, "a refused value leaves the file alone");
    assert_eq!(fx.backup_count(), 0, "and makes no backup");
    // Whatever a pick writes, the file never holds 0 or a negative number.
    for p in PICKS {
        fx.set(p).unwrap();
        let n = fx.json()[KEY].as_i64().unwrap();
        assert!(n >= 1, "{n}");
    }
}

#[test]
fn a_managed_setting_unreadable_or_read_only_file_is_left_alone_with_a_reason() {
    // An organization's file sets it.
    let fx = Fx::new();
    fs::create_dir_all(&fx.managed).unwrap();
    fs::write(fx.managed.join("managed-settings.json"), format!("{{\"{KEY}\": 14}}")).unwrap();
    let original = fx.bytes();
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert!(r.locked.as_deref().unwrap().contains("organization"));
    assert!(matches!(fx.set(YEAR_DAYS), Err(WriteError::Refused(_))));
    assert_eq!(fx.bytes(), original);
    assert_eq!(fx.backup_count(), 0);

    // A drop-in file counts too.
    let fx = Fx::new();
    fs::create_dir_all(fx.managed.join("managed-settings.d")).unwrap();
    fs::write(fx.managed.join("managed-settings.d").join("10-org.json"), format!("{{\"{KEY}\": 14}}")).unwrap();
    assert!(inspect(&fx.dir, Some(&fx.managed), &[]).locked.is_some());

    // A managed file that does not set it does not lock.
    let fx = Fx::new();
    fs::create_dir_all(&fx.managed).unwrap();
    fs::write(fx.managed.join("managed-settings.json"), "{\"model\": \"x\"}").unwrap();
    assert!(inspect(&fx.dir, Some(&fx.managed), &[]).locked.is_none());

    // The settings file is not JSON: refuse, change nothing.
    let fx = Fx::new();
    fx.write(b"{ not json");
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert!(r.locked.is_some());
    assert_eq!((r.days, r.invalid, r.unknown), (None, false, true), "what it says is not known, so no 30 days is shown");
    assert!(matches!(fx.set(YEAR_DAYS), Err(WriteError::Refused(_))));
    assert_eq!(fx.bytes(), b"{ not json");

    // Not an object.
    let fx = Fx::new();
    fx.write(b"[1, 2]");
    assert!(inspect(&fx.dir, Some(&fx.managed), &[]).locked.is_some());
    assert!(fx.set(YEAR_DAYS).is_err());
    assert_eq!(fx.bytes(), b"[1, 2]");

    // Read-only file.
    let fx = Fx::new();
    let mut perms = fs::metadata(fx.file()).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(fx.file(), perms.clone()).unwrap();
    let original = fx.bytes();
    assert!(inspect(&fx.dir, Some(&fx.managed), &[]).locked.as_deref().unwrap().contains("read-only"));
    assert!(fx.set(YEAR_DAYS).is_err());
    assert_eq!(fx.bytes(), original);
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(fx.file(), perms).unwrap();
}

#[test]
fn a_file_that_lists_the_key_twice_is_not_guessed_at() {
    let fx = Fx::new();
    let src = format!("{{\"{KEY}\": 1, \"a\": 1, \"{KEY}\": 2}}\n");
    fx.write(src.as_bytes());
    assert!(fx.set(YEAR_DAYS).is_err());
    assert_eq!(fx.bytes(), src.as_bytes());
}

// ---- what Claude Code will actually use (managed and project files win over the user's file) ----

fn put(path: &Path, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

#[test]
fn managed_settings_show_their_own_value_not_the_users() {
    let fx = Fx::new();
    fx.write(format!("{{\"{KEY}\": 365}}").as_bytes());
    put(&fx.managed.join("managed-settings.json"), &format!("{{\"{KEY}\": 14}}"));
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert_eq!((r.days, r.invalid, r.unknown), (Some(14), false, false), "14 wins over the user's 365");
    assert!(r.locked.as_deref().unwrap().contains("14 days"), "{:?}", r.locked);

    // A drop-in is read after the base file, in name order; the last one that sets it wins.
    put(&fx.managed.join("managed-settings.d").join("10-a.json"), &format!("{{\"{KEY}\": 20}}"));
    put(&fx.managed.join("managed-settings.d").join("20-b.json"), &format!("{{\"{KEY}\": 1}}"));
    put(&fx.managed.join("managed-settings.d").join("30-c.json"), "{\"model\": \"x\"}");
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert_eq!(r.days, Some(1));
    assert!(r.locked.as_deref().unwrap().contains("1 day,"), "{:?}", r.locked);

    // A managed value Claude Code rejects is shown as rejected, never as the user's value.
    put(&fx.managed.join("managed-settings.json"), &format!("{{\"{KEY}\": 0}}"));
    fs::remove_dir_all(fx.managed.join("managed-settings.d")).unwrap();
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert_eq!((r.days, r.invalid), (None, true));
    assert!(r.locked.is_some());
}

#[test]
fn managed_settings_still_win_when_the_users_file_is_broken() {
    let fx = Fx::new();
    fx.write(b"{ not json");
    put(&fx.managed.join("managed-settings.json"), &format!("{{\"{KEY}\": 14}}"));
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert_eq!((r.days, r.unknown), (Some(14), false));
    assert!(r.locked.as_deref().unwrap().contains("organization"));
    assert_eq!(fx.bytes(), b"{ not json", "reading changes nothing");
}

#[test]
fn a_project_that_sets_its_own_value_is_a_note_and_never_locks_the_picker() {
    let fx = Fx::new();
    fx.write(format!("{{\"{KEY}\": 365}}").as_bytes());
    let t = fx._t.path().join("projects");
    let (p1, p2, p3) = (t.join("alpha"), t.join("beta"), t.join("gamma"));
    put(&p1.join(".claude").join("settings.json"), &format!("{{\"{KEY}\": 60}}"));
    put(&p2.join(".claude").join("settings.json"), "{ broken");
    let projects = vec![p2.clone(), p1.clone()];
    let r = inspect(&fx.dir, Some(&fx.managed), &projects);
    // The user's value is still the one shown, and the picker is still open.
    assert_eq!((r.days, r.invalid, r.unknown, r.locked.clone()), (Some(365), false, false, None));
    assert_eq!(r.project_note.as_deref(), Some("alpha keeps chats for 60 days; its own settings file sets that."));
    // So it can be changed, and only the user's file is written.
    assert!(fx.set(FOREVER_DAYS).is_ok());
    assert_eq!(fx.json()[KEY], 3650);
    assert!(inspect(&fx.dir, Some(&fx.managed), &projects).project_note.is_some());

    // The first project that sets it is named, with a count of the rest; local beats shared inside one project.
    put(&p1.join(".claude").join("settings.local.json"), &format!("{{\"{KEY}\": 7}}"));
    put(&p3.join(".claude").join("settings.local.json"), &format!("{{\"{KEY}\": 1}}"));
    let projects = vec![p2.clone(), p1.clone(), p3.clone()];
    let note = inspect(&fx.dir, Some(&fx.managed), &projects).project_note.unwrap();
    assert_eq!(note, "alpha keeps chats for 7 days; its own settings file sets that (and 1 more).");
    // A project value Claude Code would reject is not worth a note.
    put(&p3.join(".claude").join("settings.local.json"), &format!("{{\"{KEY}\": 0}}"));
    put(&p1.join(".claude").join("settings.local.json"), "{}");
    put(&p1.join(".claude").join("settings.json"), "{}");
    assert!(inspect(&fx.dir, Some(&fx.managed), &projects).project_note.is_none());

    // Managed settings still lock, and then the note is not shown at all.
    put(&p1.join(".claude").join("settings.json"), &format!("{{\"{KEY}\": 60}}"));
    put(&fx.managed.join("managed-settings.json"), &format!("{{\"{KEY}\": 14}}"));
    let r = inspect(&fx.dir, Some(&fx.managed), &projects);
    assert_eq!(r.days, Some(14));
    assert!(r.locked.is_some() && r.project_note.is_none());
}

#[test]
fn the_home_folder_as_a_project_does_not_make_the_users_own_file_a_project_file() {
    // ~/.claude is the Claude folder and ~ is a project (Claude Code was run there).
    let t = tempfile::tempdir().unwrap();
    let home = t.path().join("home");
    let dir = home.join(".claude");
    put(&dir.join("settings.json"), &format!("{{\"{KEY}\": 365}}"));
    let backups = t.path().join("data").join("backups");
    let managed = t.path().join("managed");
    let r = inspect(&dir, Some(&managed), std::slice::from_ref(&home));
    assert_eq!((r.days, r.locked, r.project_note), (Some(365), None, None), "its own file is not a project override");
    assert!(set_days(&dir, Some(&managed), std::slice::from_ref(&home), &backups, FOREVER_DAYS).is_ok());
    let now: Value = serde_json::from_slice(&fs::read(dir.join("settings.json")).unwrap()).unwrap();
    assert_eq!(now[KEY], 3650);
    // The same folder's separate local file is a real project file and is only a note.
    put(&dir.join("settings.local.json"), &format!("{{\"{KEY}\": 45}}"));
    let r = inspect(&dir, Some(&managed), std::slice::from_ref(&home));
    assert_eq!((r.days, r.locked), (Some(3650), None));
    assert_eq!(r.project_note.as_deref(), Some("home keeps chats for 45 days; its own settings file sets that."));
}

#[test]
fn a_project_whose_file_can_not_be_read_changes_nothing() {
    let fx = Fx::new();
    let p = fx._t.path().join("projects").join("beta");
    put(&p.join(".claude").join("settings.json"), "{ broken");
    let r = inspect(&fx.dir, Some(&fx.managed), &[p]);
    assert_eq!((r.locked, r.project_note), (None, None));
}

#[test]
fn an_empty_or_blank_settings_file_counts_as_missing_and_undo_puts_the_blank_file_back() {
    for blank in ["", "  \n", "\u{feff}", "\u{feff}\r\n\t "] {
        let fx = Fx::new();
        fx.write(blank.as_bytes());
        let r = inspect(&fx.dir, Some(&fx.managed), &[]);
        assert_eq!((r.days, r.invalid, r.unknown, r.locked), (None, false, false, None), "{blank:?}");
        let id = fx.set(YEAR_DAYS).unwrap().backup_id.unwrap();
        let out = String::from_utf8(fx.bytes()).unwrap();
        assert!(out.trim_start_matches('\u{feff}').starts_with('{') && out.contains("\"cleanupPeriodDays\": 365"), "{out:?}");
        assert_eq!(out.starts_with('\u{feff}'), blank.starts_with('\u{feff}'), "a BOM the file had is kept");
        let parsed: Value = serde_json::from_str(out.trim_start_matches('\u{feff}')).unwrap();
        assert_eq!(parsed[KEY], 365);
        restore_any(&fx.backups, &id, &fx.confine()).unwrap();
        assert_eq!(fx.bytes(), blank.as_bytes(), "Undo gives back the blank file exactly");
    }
}

/// Make a symlink to `target` at `link`; false when this machine won't (Windows without developer
/// mode or admin). The test then says so and returns: skipped, never faked.
fn try_symlink(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    let r = std::os::unix::fs::symlink(target, link);
    #[cfg(windows)]
    let r = std::os::windows::fs::symlink_file(target, link);
    r.is_ok()
}

#[test]
fn a_symlinked_settings_file_is_written_through_and_the_link_survives() {
    let fx = Fx::new();
    let real = fx._t.path().join("dotfiles").join("claude-settings.json");
    fs::create_dir_all(real.parent().unwrap()).unwrap();
    fs::rename(fx.file(), &real).unwrap();
    if !try_symlink(&real, &fx.file()) {
        eprintln!("skipped: this machine can't create symlinks (Windows needs developer mode or admin)");
        return;
    }
    let original = fs::read(&real).unwrap();
    let r = inspect(&fx.dir, Some(&fx.managed), &[]);
    assert_eq!((r.days, r.locked), (None, None));
    let id = fx.set(FOREVER_DAYS).unwrap().backup_id.unwrap();
    assert!(fs::symlink_metadata(fx.file()).unwrap().file_type().is_symlink(), "the link is still a link");
    let through: Value = serde_json::from_slice(&fs::read(&real).unwrap()).unwrap();
    assert_eq!(through[KEY], 3650, "the file the link points at has the value");
    assert_eq!(fx.json()[KEY], 3650, "and so does reading it through the link");
    only_the_key_added(&original, &fs::read(&real).unwrap(), 3650);
    // Undo goes through the link too.
    restore_any(&fx.backups, &id, &fx.confine()).unwrap();
    assert!(fs::symlink_metadata(fx.file()).unwrap().file_type().is_symlink());
    assert_eq!(fs::read(&real).unwrap(), original);
}

#[test]
fn a_file_changed_between_reading_and_writing_is_refused_and_not_overwritten() {
    let fx = Fx::new();
    let theirs = b"{\n  \"model\": \"changed-by-claude-code\"\n}\n".to_vec();
    let (file, their_write) = (fx.file(), theirs.clone());
    let e = set_days_hooked(&fx.dir, Some(&fx.managed), &[], &fx.backups, YEAR_DAYS, move || fs::write(&file, &their_write).unwrap()).unwrap_err();
    match e {
        WriteError::Refused(m) => assert!(m.contains("changed the file"), "{m}"),
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert_eq!(fx.bytes(), theirs, "the other writer's file is exactly as they left it");
    assert_eq!(fx.backup_count(), 0, "a refused write leaves no backup behind");
    // Nothing is stuck: trying again now works, on top of their change.
    assert!(fx.set(YEAR_DAYS).is_ok());
    assert_eq!(fx.json()[KEY], 365);
    assert_eq!(fx.json()["model"], "changed-by-claude-code");
}
