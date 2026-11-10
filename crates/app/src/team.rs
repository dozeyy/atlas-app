//! The Team tab's door to the page: the scorecard and review themes (read from the usage
//! cache, never on the UI thread), and "Make this a rule" (a CLAUDE.md line or a rule file,
//! through the one write path: backup first, atomic write, History, Undo).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use atlas_core::review_rule::{self, MadeRule};
use atlas_core::setup::Project;
use atlas_core::setup_write::{self as sw, CreateCtx, WriteError};
use atlas_core::usage::scorecard::{Scorecard, ScorecardArgs, ThemeArgs, Themes};
use atlas_core::usage::UsageEngine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::setup_service::{backups_dir, write_lock, SetupHub};
use crate::state::AppState;

type Info<'a> = State<'a, Arc<AppState>>;
type Hub<'a> = State<'a, Arc<SetupHub>>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

async fn on_engine<T: Send + 'static>(engine: Result<Arc<UsageEngine>, String>, f: impl FnOnce(Arc<UsageEngine>) -> Result<T, String> + Send + 'static) -> Result<T, String> {
    let engine = engine?;
    blocking(move || f(engine)).await
}

#[tauri::command]
pub async fn team_scorecard(state: Info<'_>, args: ScorecardArgs) -> Result<Scorecard, String> {
    on_engine(state.usage.engine(), move |e| e.agent_scorecard(&args)).await
}

/// The themes plus which of them already became a rule (theme id -> where, when).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemesOut {
    #[serde(flatten)]
    themes: Themes,
    made: BTreeMap<String, MadeRule>,
}

#[tauri::command]
pub async fn team_themes(state: Info<'_>, args: ThemeArgs) -> Result<ThemesOut, String> {
    let data_dir = state.data_dir.clone();
    on_engine(state.usage.engine(), move |e| {
        let themes = e.review_themes(&args)?;
        Ok(ThemesOut { themes, made: review_rule::load(&data_dir) })
    })
    .await
}

// ---------------------------------------------------------------------------
// Make this a rule
// ---------------------------------------------------------------------------

/// One place a rule can go.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleTarget {
    /// `global` | `project:<folder>` | `file`
    id: String,
    /// `line` (a line in a CLAUDE.md) | `file` (a new rule file)
    kind: &'static str,
    title: String,
    /// Where it will be written, for display.
    path: String,
    /// What the file looked like when the sheet opened; handed back with Save.
    stamp: String,
    /// The CLAUDE.md or rule file is already there.
    exists: bool,
    /// The text the editor starts with.
    text: String,
    /// Why this target cannot be used (a rule file of that name already exists).
    blocked: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSheet {
    targets: Vec<RuleTarget>,
}

/// A folder as compared: slashes unified, no trailing slash, lower-case (Windows paths).
fn path_key(p: &str) -> String {
    p.replace('\\', "/").trim_end_matches('/').to_ascii_lowercase()
}

/// The CLAUDE.md files a theme's rule can go in: the global one, then the CLAUDE.md of up to three
/// of the theme's project folders. The page names folders; only a folder the scan knows (not the
/// home folder, not a worktree, still on disk, with a CLAUDE.md already in it) is offered, so a
/// path from the page is never written to unchecked. A project's id is its folder, so the id the
/// sheet showed still means the same file when Save looks it up again, whatever order a rescan
/// returns the projects in.
fn claude_md_targets(projects: &[Project], root_dir: &Path, asked: &[String]) -> Vec<(String, String, PathBuf)> {
    let mut out = vec![("global".to_string(), "CLAUDE.md in your Claude folder".to_string(), root_dir.join("CLAUDE.md"))];
    let mut found: Vec<(&Project, PathBuf)> = Vec::new();
    for want in asked {
        if found.len() >= 3 {
            break;
        }
        let key = path_key(want);
        let Some(p) = projects.iter().find(|p| !p.is_home && !p.is_worktree && p.exists && path_key(&p.path) == key) else { continue };
        let file = PathBuf::from(&p.path).join("CLAUDE.md");
        // A project without a CLAUDE.md is not offered: Atlas adds a line to a file, it does not
        // start a project's instructions.
        if !file.is_file() || found.iter().any(|(_, f)| *f == file) || out.iter().any(|(_, _, f)| *f == file) {
            continue;
        }
        found.push((p, file));
    }
    for (p, file) in &found {
        let same_name = found.iter().filter(|(q, _)| q.name.eq_ignore_ascii_case(&p.name)).count() > 1;
        // Two repos called "app": the folder they sit in tells them apart.
        let title = match Path::new(&p.path).parent().and_then(|d| d.file_name()).filter(|_| same_name) {
            Some(parent) => format!("CLAUDE.md in {} ({})", p.name, parent.to_string_lossy()),
            None => format!("CLAUDE.md in {}", p.name),
        };
        out.push((format!("project:{}", p.path), title, file.clone()));
    }
    out
}

/// The sheet's targets for a theme, each with the stamp of its file as it is right now.
fn build_targets(projects: &[Project], root_dir: &Path, asked: &[String], label: &str) -> Vec<RuleTarget> {
    let line = review_rule::draft_line(label);
    let mut targets: Vec<RuleTarget> = claude_md_targets(projects, root_dir, asked)
        .into_iter()
        .map(|(id, title, file)| RuleTarget {
            id,
            kind: "line",
            title,
            path: atlas_core::setup::display_path(&file),
            stamp: sw::file_stamp(&file),
            exists: file.is_file(),
            text: line.clone(),
            blocked: None,
        })
        .collect();
    let slug = review_rule::rule_slug(label);
    let rule_path = root_dir.join("rules").join(format!("{slug}.md"));
    let taken = rule_path.exists();
    targets.push(RuleTarget {
        id: "file".into(),
        kind: "file",
        title: format!("A rule file, rules/{slug}.md"),
        path: atlas_core::setup::display_path(&rule_path),
        stamp: sw::file_stamp(&rule_path),
        exists: taken,
        text: review_rule::rule_file_text(label),
        blocked: taken.then(|| "A rule file with this name is already there.".to_string()),
    });
    targets
}

/// The sheet's targets, each with the stamp of its file as it is right now.
#[tauri::command]
pub async fn rule_sheet(app: AppHandle, state: Info<'_>, hub: Hub<'_>, label: String, project_paths: Vec<String>) -> Result<RuleSheet, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let d = hub.current(&app, &st)?;
        Ok(RuleSheet { targets: build_targets(&d.snapshot.projects, &i.root.dir, &project_paths, &label) })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSave {
    theme_id: String,
    label: String,
    /// The folders the sheet was opened with; each is checked against the scan again on Save.
    project_paths: Vec<String>,
    target_id: String,
    /// The editor's text: one line for a CLAUDE.md, the whole file for a rule file.
    text: String,
    /// The stamp the sheet read for this target.
    stamp: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleReply {
    /// saved | already (the line was in the file, nothing written) | conflict
    status: &'static str,
    backup_id: Option<String>,
    path: Option<String>,
    /// Shown on a conflict: "This file changed since you opened it."
    message: Option<String>,
    /// A quiet extra sentence on success (the rule is saved, a side note could not be kept).
    note: Option<String>,
}

fn reply(status: &'static str) -> RuleReply {
    RuleReply { status, backup_id: None, path: None, message: None, note: None }
}

fn conflict() -> RuleReply {
    RuleReply { message: Some(review_rule::STALE_MESSAGE.into()), ..reply("conflict") }
}

/// Save the rule. The page names a target; Atlas works out the path itself, so a path from the
/// page is never trusted.
#[tauri::command]
pub async fn rule_save(app: AppHandle, state: Info<'_>, hub: Hub<'_>, args: RuleSave) -> Result<RuleReply, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let _lock = write_lock(&st)?;
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let d = hub.current(&app, &st)?;
        let backups = backups_dir(&st);
        let summary = "Made a rule from a review theme";
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        let (backup_id, path, already) = if args.target_id == "file" {
            let slug = review_rule::rule_slug(&args.label);
            let target = i.root.dir.join("rules").join(format!("{slug}.md"));
            // A rule file is new: if something is there now, the sheet is out of date.
            if sw::file_stamp(&target) != args.stamp {
                return Ok(conflict());
            }
            let out = match sw::create_apply("rule", &slug, None, &args.text, &CreateCtx { root: &i.root.dir, claude_json: &i.root.claude_json }, &backups) {
                Ok(o) => o,
                Err(WriteError::Conflict) => return Ok(conflict()),
                Err(e) => return Err(e.message()),
            };
            sw::tag_backup(&backups, &out.backup_id, "user", summary);
            (Some(out.backup_id), atlas_core::setup::display_path(&target), false)
        } else {
            let found = claude_md_targets(&d.snapshot.projects, &i.root.dir, &args.project_paths).into_iter().find(|(id, _, _)| *id == args.target_id);
            let Some((_, _, file)) = found else { return Err("That place for the rule is not available any more. Close this and try again.".into()) };
            let line = review_rule::validate_line(&args.text).map_err(|m| m.to_string())?;
            // The line is already there (a save whose note was lost, or a hand edit): nothing to
            // write, and no second copy.
            if std::fs::read(&file).is_ok_and(|b| review_rule::has_line(&b, &line)) {
                (None, atlas_core::setup::display_path(&file), true)
            } else {
                match sw::apply_append(&file, "instructions", "CLAUDE.md", review_rule::HEADING, &line, &args.stamp, summary, &backups) {
                    Ok(o) => (o.backup_id, atlas_core::setup::display_path(&file), false),
                    Err(WriteError::Conflict) => return Ok(conflict()),
                    Err(e) => return Err(e.message()),
                }
            }
        };
        // The log only feeds the "Made a rule" label; the rule is already written either way.
        let note = match review_rule::record(&st.data_dir, &args.theme_id, &path, now) {
            Ok(()) => None,
            Err(e) => {
                eprintln!("[atlas] review-rules.json: {e}");
                Some("The rule is saved, but Atlas could not note it here, so this problem may offer the button again.".to_string())
            }
        };
        if !already {
            hub.refresh(&app, &st);
        }
        Ok(RuleReply { backup_id, path: Some(path), note, ..reply(if already { "already" } else { "saved" }) })
    })
    .await
}

/// After Undo: the theme offers the button again.
#[tauri::command]
pub async fn rule_forget(state: Info<'_>, theme_id: String) -> Result<(), String> {
    let data_dir = state.data_dir.clone();
    blocking(move || review_rule::forget(&data_dir, &theme_id).map_err(|e| e.to_string())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(name: &str, path: &Path) -> Project {
        Project {
            id: format!("id-{name}"),
            name: name.into(),
            path: path.to_string_lossy().into_owned(),
            exists: true,
            is_home: false,
            is_worktree: false,
            parent_id: None,
            worktree_count: 0,
            item_count: 0,
            local_mcp_count: 0,
            last_activity_ms: 0,
        }
    }

    /// A project folder with a CLAUDE.md in it.
    fn repo(base: &Path, parent: &str, name: &str) -> Project {
        let dir = base.join(parent).join(name);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("CLAUDE.md"), format!("# {name}\n")).unwrap();
        project(name, &dir)
    }

    fn ids(t: &[(String, String, PathBuf)]) -> Vec<String> {
        t.iter().map(|(id, _, _)| id.clone()).collect()
    }

    #[test]
    fn global_comes_first_and_projects_are_named_by_folder_not_position() {
        let base = tempfile::tempdir().unwrap();
        let claude = base.path().join(".claude");
        let (a, b) = (repo(base.path(), "w", "alpha"), repo(base.path(), "w", "beta"));
        let asked = vec![a.path.clone(), b.path.clone()];

        let one = claude_md_targets(&[a.clone(), b.clone()], &claude, &asked);
        // A rescan returns the projects in the other order: the id still means the same file.
        let two = claude_md_targets(&[b.clone(), a.clone()], &claude, &asked);
        assert_eq!(ids(&one)[0], "global");
        assert_eq!(one[0].2, claude.join("CLAUDE.md"));
        let file_of = |t: &[(String, String, PathBuf)], id: &str| t.iter().find(|(i, _, _)| i == id).map(|(_, _, f)| f.clone());
        for p in [&a, &b] {
            let id = format!("project:{}", p.path);
            assert_eq!(file_of(&one, &id), Some(PathBuf::from(&p.path).join("CLAUDE.md")), "{id}");
            assert_eq!(file_of(&two, &id), file_of(&one, &id), "same id, same file after a rescan");
        }
        // Even when the page asks in a different order, an id never points at another folder.
        let swapped = claude_md_targets(&[a.clone(), b.clone()], &claude, &[b.path.clone(), a.path.clone()]);
        for p in [&a, &b] {
            let id = format!("project:{}", p.path);
            assert_eq!(file_of(&swapped, &id), file_of(&one, &id));
        }
    }

    #[test]
    fn two_repos_with_one_name_are_both_offered_and_told_apart() {
        let base = tempfile::tempdir().unwrap();
        let claude = base.path().join(".claude");
        let (x, y) = (repo(base.path(), "work", "app"), repo(base.path(), "play", "app"));
        let t = claude_md_targets(&[x.clone(), y.clone()], &claude, &[x.path.clone(), y.path.clone()]);
        assert_eq!(t.len(), 3, "global and both repos");
        let titles: Vec<&str> = t.iter().skip(1).map(|(_, title, _)| title.as_str()).collect();
        assert_ne!(titles[0], titles[1]);
        assert!(titles[0].contains("work") && titles[1].contains("play"), "{titles:?}");
        assert_ne!(t[1].2, t[2].2);
    }

    #[test]
    fn a_folder_the_scan_does_not_know_or_may_not_take_a_rule_is_not_offered() {
        let base = tempfile::tempdir().unwrap();
        let claude = base.path().join(".claude");
        let known = repo(base.path(), "w", "known");
        let stranger = base.path().join("w").join("stranger");
        std::fs::create_dir_all(&stranger).unwrap();
        std::fs::write(stranger.join("CLAUDE.md"), "x").unwrap();
        let mut home = repo(base.path(), "w", "home");
        home.is_home = true;
        let mut tree = repo(base.path(), "w", "tree");
        tree.is_worktree = true;
        let mut gone = repo(base.path(), "w", "gone");
        gone.exists = false;
        let bare = project("bare", &base.path().join("w").join("bare")); // no CLAUDE.md on disk
        let all = [known.clone(), home.clone(), tree.clone(), gone.clone(), bare.clone()];
        let asked: Vec<String> = [&known, &home, &tree, &gone, &bare].iter().map(|p| p.path.clone()).chain([stranger.to_string_lossy().into_owned(), "../../etc".into()]).collect();
        let t = claude_md_targets(&all, &claude, &asked);
        assert_eq!(ids(&t), vec!["global".to_string(), format!("project:{}", known.path)]);
    }

    #[test]
    fn paths_match_across_slash_style_and_case_and_offer_at_most_three() {
        let base = tempfile::tempdir().unwrap();
        let claude = base.path().join(".claude");
        let ps: Vec<Project> = (0..5).map(|n| repo(base.path(), "w", &format!("p{n}"))).collect();
        let asked: Vec<String> = ps.iter().map(|p| p.path.replace('\\', "/").to_uppercase()).collect();
        let t = claude_md_targets(&ps, &claude, &asked);
        assert_eq!(t.len(), 1 + 3, "global and three projects");
        let again = claude_md_targets(&ps, &claude, &[ps[0].path.clone(), ps[0].path.clone()]);
        assert_eq!(again.len(), 2, "the same folder twice is one target");
    }

    #[test]
    fn the_sheet_ends_with_the_rule_file_and_blocks_a_name_already_taken() {
        let base = tempfile::tempdir().unwrap();
        let claude = base.path().join(".claude");
        let p = repo(base.path(), "w", "alpha");
        let t = build_targets(std::slice::from_ref(&p), &claude, std::slice::from_ref(&p.path), "Missing test for the empty cache case");
        assert_eq!(t.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), vec!["global".to_string(), format!("project:{}", p.path), "file".to_string()]);
        let global = &t[0];
        assert_eq!((global.kind, global.exists, global.stamp.as_str()), ("line", false, review_rule::MISSING_STAMP));
        assert_eq!(global.text, "- Check before handing work back: Missing test for the empty cache case.");
        assert!(t[1].exists && t[1].stamp != review_rule::MISSING_STAMP);
        let file = &t[2];
        assert_eq!((file.kind, file.blocked.is_none()), ("file", true));
        assert!(file.text.starts_with("# Missing Test For The Empty Cache"));
        // Once that rule file exists the target is blocked.
        std::fs::create_dir_all(claude.join("rules")).unwrap();
        std::fs::write(claude.join("rules").join("missing-test-for-the-empty-cache-case.md"), "x").unwrap();
        let again = build_targets(&[p], &claude, &[], "Missing test for the empty cache case");
        assert!(again.last().unwrap().blocked.is_some());
    }

    #[test]
    fn the_draft_in_a_sheet_carries_no_secret_import_or_link() {
        let base = tempfile::tempdir().unwrap();
        let t = build_targets(&[], &base.path().join(".claude"), &[], "uses @~/.ssh/id_rsa and [docs](https://evil.example) with `sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789`");
        for x in &t {
            assert!(!x.text.contains('@') && !x.text.contains("evil.example") && !x.text.contains('`') && !x.text.contains("sk-ant-api03"), "{}", x.text);
        }
    }
}
