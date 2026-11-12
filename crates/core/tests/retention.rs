//! "Keep sessions longer": the one `cleanupPeriodDays` write, against temp copies of
//! `fixtures/claude-basic`. Nothing real is opened. The value written is only ever 30, 365 or
//! 3650 (never 0, which Claude Code's docs say fails validation and which older builds may treat
//! as "delete everything"), the backup holds the exact old bytes, and Undo puts them back.

use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::retention::{inspect, set_days, FOREVER_DAYS, KEY, PICKS, YEAR_DAYS};
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
        set_days(&self.dir, Some(&self.managed), &self.backups, days)
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
    let r = inspect(&fx.dir, Some(&fx.managed));
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
    assert_eq!(inspect(&fx.dir, Some(&fx.managed)).days, Some(365));
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
        let r = inspect(&fx.dir, Some(&fx.managed));
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
    assert_eq!(inspect(&fx.dir, Some(&fx.managed)).days, Some(90));
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
    let r = inspect(&fx.dir, Some(&fx.managed));
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
        let r = inspect(&fx.dir, Some(&fx.managed));
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
    let r = inspect(&fx.dir, Some(&fx.managed));
    assert!(r.locked.as_deref().unwrap().contains("organization"));
    assert!(matches!(fx.set(YEAR_DAYS), Err(WriteError::Refused(_))));
    assert_eq!(fx.bytes(), original);
    assert_eq!(fx.backup_count(), 0);

    // A drop-in file counts too.
    let fx = Fx::new();
    fs::create_dir_all(fx.managed.join("managed-settings.d")).unwrap();
    fs::write(fx.managed.join("managed-settings.d").join("10-org.json"), format!("{{\"{KEY}\": 14}}")).unwrap();
    assert!(inspect(&fx.dir, Some(&fx.managed)).locked.is_some());

    // A managed file that does not set it does not lock.
    let fx = Fx::new();
    fs::create_dir_all(&fx.managed).unwrap();
    fs::write(fx.managed.join("managed-settings.json"), "{\"model\": \"x\"}").unwrap();
    assert!(inspect(&fx.dir, Some(&fx.managed)).locked.is_none());

    // The settings file is not JSON: refuse, change nothing.
    let fx = Fx::new();
    fx.write(b"{ not json");
    let r = inspect(&fx.dir, Some(&fx.managed));
    assert!(r.locked.is_some());
    assert!(matches!(fx.set(YEAR_DAYS), Err(WriteError::Refused(_))));
    assert_eq!(fx.bytes(), b"{ not json");

    // Not an object.
    let fx = Fx::new();
    fx.write(b"[1, 2]");
    assert!(inspect(&fx.dir, Some(&fx.managed)).locked.is_some());
    assert!(fx.set(YEAR_DAYS).is_err());
    assert_eq!(fx.bytes(), b"[1, 2]");

    // Read-only file.
    let fx = Fx::new();
    let mut perms = fs::metadata(fx.file()).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(fx.file(), perms.clone()).unwrap();
    let original = fx.bytes();
    assert!(inspect(&fx.dir, Some(&fx.managed)).locked.as_deref().unwrap().contains("read-only"));
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
