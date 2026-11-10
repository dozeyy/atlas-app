//! "Make this a rule" against a private copy of `fixtures/claude-setup` (scorecard spec
//! criteria 13, 14 and 15). Every test works in a temp folder; nothing real is opened.

use std::fs;
use std::path::{Path, PathBuf};

use atlas_core::history::store::sha_hex;
use atlas_core::paths::{resolve_config_root, ConfigInputs};
use atlas_core::review_rule::{append_under_heading, draft_line, rule_file_text, rule_slug, HEADING, MISSING_STAMP};
use atlas_core::setup::{discover, Cache, DiscoveryInputs};
use atlas_core::setup_write::{apply_append, create_apply, file_stamp, list_backups_detailed, restore_any, tag_backup, Confine, CreateCtx, WriteError};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures")
}

fn copy_tree(src: &Path, dst: &Path, root: &str) {
    fs::create_dir_all(dst).unwrap();
    for e in fs::read_dir(src).unwrap() {
        let e = e.unwrap();
        let p = e.path();
        let t = dst.join(e.file_name());
        if p.is_dir() {
            copy_tree(&p, &t, root);
            continue;
        }
        let bytes = fs::read(&p).unwrap();
        let lower = p.to_string_lossy().to_ascii_lowercase();
        let json = lower.ends_with(".json") || lower.ends_with(".jsonl");
        let out = match String::from_utf8(bytes.clone()) {
            Ok(s) if s.contains("@ROOT@") => {
                let r = if json { root.replace('\\', "\\\\") } else { root.to_string() };
                s.replace("@ROOT@", &r).into_bytes()
            }
            _ => bytes,
        };
        fs::write(&t, out).unwrap();
    }
}

struct Fx {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    home: PathBuf,
    backups: PathBuf,
}

impl Fx {
    fn new() -> Fx {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("machine");
        let root = dir.to_string_lossy().replace('\\', "/");
        copy_tree(&fixtures().join("claude-setup"), &dir, &root);
        let home = dir.join("home");
        let backups = tmp.path().join("atlas-data").join("backups");
        Fx { _tmp: tmp, dir, home, backups }
    }
    fn inputs(&self) -> DiscoveryInputs {
        let root = resolve_config_root(&ConfigInputs { flag: None, settings_override: None, env: None, home: &self.home, cwd: &self.dir });
        DiscoveryInputs { root, home: self.home.clone(), managed_dir: Some(self.dir.join("managed")), include_worktrees: false, sandboxed: false }
    }
    fn claude(&self) -> PathBuf {
        self.home.join(".claude")
    }
    fn confine(&self) -> Confine {
        let i = self.inputs();
        let d = discover(&i, &mut Cache::default());
        Confine::from_discovery(&i.root.dir, &i.root.claude_json, &d)
    }
}

const LINE: &str = "- Check before handing work back: Missing null check on the response.";

#[test]
fn a_crlf_bom_claude_md_gains_only_the_heading_and_one_line_and_undo_is_sha_identical() {
    let fx = Fx::new();
    let file = fx.claude().join("CLAUDE.md");
    let mut original = vec![0xEF, 0xBB, 0xBF];
    original.extend_from_slice(b"# How I work\r\n\r\n- Short answers.\r\n- Ask first.\r\n");
    fs::write(&file, &original).unwrap();

    let stamp = file_stamp(&file);
    let out = apply_append(&file, "instructions", "CLAUDE.md", HEADING, LINE, &stamp, "Made a review rule", &fx.backups).unwrap();
    let after = fs::read(&file).unwrap();

    // Exactly the heading (it was missing) and one line were added; every original byte stays at the front.
    assert!(after.starts_with(&original));
    let added = &after[original.len()..];
    assert_eq!(added, format!("\r\n{HEADING}\r\n\r\n{LINE}\r\n").as_bytes());
    assert!(after.starts_with(&[0xEF, 0xBB, 0xBF]));

    // A backup exists and History lists the change as restorable.
    let id = out.backup_id.clone().unwrap();
    assert!(fx.backups.join(&id).join("file-before").exists());
    let listed = list_backups_detailed(&fx.backups, 10);
    let row = listed.iter().find(|b| b.backup_id == id).expect("History lists the change");
    assert!(row.can_restore);
    assert_eq!(row.action, "save");
    assert_eq!(row.summary.as_deref(), Some("Made a review rule"));

    // Undo puts back a sha256-identical file.
    restore_any(&fx.backups, &id, &fx.confine()).unwrap();
    assert_eq!(sha_hex(&fs::read(&file).unwrap()), sha_hex(&original));
}

#[test]
fn a_second_rule_goes_under_the_same_heading_and_leaves_the_rest_alone() {
    let fx = Fx::new();
    let file = fx.claude().join("CLAUDE.md");
    let original = format!("# Notes\n\n{HEADING}\n\n- Old one.\n\n## Other\n\nkeep this\n").into_bytes();
    fs::write(&file, &original).unwrap();
    apply_append(&file, "instructions", "CLAUDE.md", HEADING, LINE, &file_stamp(&file), "x", &fx.backups).unwrap();
    let after = String::from_utf8(fs::read(&file).unwrap()).unwrap();
    assert_eq!(after, format!("# Notes\n\n{HEADING}\n\n- Old one.\n{LINE}\n\n## Other\n\nkeep this\n"));
}

#[test]
fn a_changed_file_refuses_with_a_conflict_and_writes_nothing() {
    let fx = Fx::new();
    let file = fx.claude().join("CLAUDE.md");
    fs::write(&file, b"# One\n").unwrap();
    let stamp = file_stamp(&file); // read when the sheet opened
    fs::write(&file, b"# One\n\nsomeone added this\n").unwrap();
    let changed = fs::read(&file).unwrap();

    let err = apply_append(&file, "instructions", "CLAUDE.md", HEADING, LINE, &stamp, "x", &fx.backups).unwrap_err();
    assert!(matches!(err, WriteError::Conflict), "{err:?}");
    assert_eq!(fs::read(&file).unwrap(), changed, "nothing was written");
    let backups: Vec<_> = fs::read_dir(&fx.backups).map(|rd| rd.flatten().collect()).unwrap_or_default();
    assert!(backups.is_empty(), "no backup is left behind");
    assert_eq!(atlas_core::review_rule::STALE_MESSAGE, "This file changed since you opened it.");

    // A file that appeared after the sheet saw it missing is stale too.
    let fresh = fx.claude().join("rules").join("later.md");
    let missing = file_stamp(&fresh);
    assert_eq!(missing, MISSING_STAMP);
    fs::create_dir_all(fresh.parent().unwrap()).unwrap();
    fs::write(&fresh, b"hi\n").unwrap();
    assert!(matches!(apply_append(&fresh, "instructions", "later", HEADING, LINE, &missing, "x", &fx.backups).unwrap_err(), WriteError::Conflict));
    assert_eq!(fs::read(&fresh).unwrap(), b"hi\n");
}

#[test]
fn a_missing_global_claude_md_is_created_and_undo_removes_it() {
    let fx = Fx::new();
    let file = fx.claude().join("CLAUDE.md");
    let _ = fs::remove_file(&file);
    let stamp = file_stamp(&file);
    assert_eq!(stamp, MISSING_STAMP);
    let out = apply_append(&file, "instructions", "CLAUDE.md", HEADING, LINE, &stamp, "Made a review rule", &fx.backups).unwrap();
    assert_eq!(String::from_utf8(fs::read(&file).unwrap()).unwrap(), format!("{HEADING}\n\n{LINE}\n"));
    restore_any(&fx.backups, &out.backup_id.unwrap(), &fx.confine()).unwrap();
    assert!(!file.exists());
}

#[test]
fn the_rule_file_target_goes_through_create_apply_and_undo_removes_it() {
    let fx = Fx::new();
    let label = "[High] Missing null check on the response in src/a.ts:12";
    let slug = rule_slug(label);
    let text = rule_file_text(label);
    let cj = fx.inputs().root.claude_json;
    let root = fx.inputs().root.dir;
    let ctx = CreateCtx { root: &root, claude_json: &cj };
    let made = create_apply("rule", &slug, None, &text, &ctx, &fx.backups).unwrap();
    let path = root.join("rules").join(format!("{slug}.md"));
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    assert!(text.starts_with("# Missing Null Check On The Response\n\n"));
    assert!(text.contains(&draft_line(label)));

    tag_backup(&fx.backups, &made.backup_id, "user", "Made a review rule");
    restore_any(&fx.backups, &made.backup_id, &fx.confine()).unwrap();
    assert!(!path.exists(), "undo removes the rule file");
    // A second one of the same name is refused, never overwritten.
    create_apply("rule", &slug, None, &text, &ctx, &fx.backups).unwrap();
    assert!(create_apply("rule", &slug, None, &text, &ctx, &fx.backups).is_err());
}

#[test]
fn append_is_byte_exact_for_mixed_line_endings_and_no_final_newline() {
    let before = b"# A\r\nline\nlast without newline";
    let after = append_under_heading(before, HEADING, "- X.");
    assert!(after.starts_with(before));
    // The file has CRLF somewhere, so the new lines use CRLF; the old bytes are untouched.
    assert!(after.ends_with(b"- X.\r\n"));
}

#[test]
fn the_server_refuses_anything_but_one_dash_line_and_writes_nothing() {
    let fx = Fx::new();
    let file = fx.claude().join("CLAUDE.md");
    let original = b"# Notes\n\nKeep it short.\n".to_vec();
    fs::write(&file, &original).unwrap();
    let stamp = file_stamp(&file);
    let long = format!("- {}", "x".repeat(500));
    for bad in ["- one\n- two", "- one\n\n## A heading", "## Heading", "plain words", "- # heading", "- ```sh", long.as_str()] {
        let err = apply_append(&file, "instructions", "CLAUDE.md", HEADING, bad, &stamp, "x", &fx.backups).unwrap_err();
        assert!(matches!(err, WriteError::Refused(_)), "{bad:?} -> {err:?}");
    }
    assert_eq!(fs::read(&file).unwrap(), original, "nothing was written");
    let left: Vec<_> = fs::read_dir(&fx.backups).map(|rd| rd.flatten().collect()).unwrap_or_default();
    assert!(left.is_empty(), "no backup is left behind");
}
