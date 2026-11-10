//! The Team tab's door to the page: the scorecard and review themes (read from the usage
//! cache, never on the UI thread), and "Make this a rule" (a CLAUDE.md line or a rule file,
//! through the one write path: backup first, atomic write, History, Undo).

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use atlas_core::review_rule::{self, MadeRule};
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
    /// `global` | `project:<n>` | `file`
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

fn same_name(a: &str, b: &str) -> bool {
    a.trim().eq_ignore_ascii_case(b.trim())
}

/// The CLAUDE.md files a theme's rule can go in: the global one, then the CLAUDE.md of up to three
/// of the theme's projects (matched by name against the projects the scan knows).
fn claude_md_targets(d: &atlas_core::setup::Discovery, root_dir: &std::path::Path, projects: &[String]) -> Vec<(String, String, PathBuf)> {
    let mut out = vec![("global".to_string(), "CLAUDE.md in your Claude folder".to_string(), root_dir.join("CLAUDE.md"))];
    let mut n = 0usize;
    for name in projects {
        if n >= 3 {
            break;
        }
        let hit = d.snapshot.projects.iter().find(|p| {
            !p.is_home
                && !p.is_worktree
                && p.exists
                && (same_name(&p.name, name) || std::path::Path::new(&p.path).file_name().is_some_and(|f| same_name(&f.to_string_lossy(), name)))
        });
        let Some(p) = hit else { continue };
        let file = PathBuf::from(&p.path).join("CLAUDE.md");
        // A project without a CLAUDE.md is not offered: Atlas adds a line to a file, it does not
        // start a project's instructions.
        if !file.is_file() || out.iter().any(|(_, _, f)| *f == file) {
            continue;
        }
        out.push((format!("project:{n}"), format!("CLAUDE.md in {}", p.name), file));
        n += 1;
    }
    out
}

/// The sheet's targets, each with the stamp of its file as it is right now.
#[tauri::command]
pub async fn rule_sheet(app: AppHandle, state: Info<'_>, hub: Hub<'_>, label: String, projects: Vec<String>) -> Result<RuleSheet, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let i = st.setup_inputs(false).ok_or_else(|| "Your Claude folder is not ready yet.".to_string())?;
        let d = hub.current(&app, &st)?;
        let line = review_rule::draft_line(&label);
        let mut targets = Vec::new();
        for (id, title, file) in claude_md_targets(&d, &i.root.dir, &projects) {
            targets.push(RuleTarget {
                id,
                kind: "line",
                title,
                path: atlas_core::setup::display_path(&file),
                stamp: sw::file_stamp(&file),
                exists: file.is_file(),
                text: line.clone(),
                blocked: None,
            });
        }
        let slug = review_rule::rule_slug(&label);
        let rule_path = i.root.dir.join("rules").join(format!("{slug}.md"));
        let taken = rule_path.exists();
        targets.push(RuleTarget {
            id: "file".into(),
            kind: "file",
            title: format!("A rule file, rules/{slug}.md"),
            path: atlas_core::setup::display_path(&rule_path),
            stamp: sw::file_stamp(&rule_path),
            exists: taken,
            text: review_rule::rule_file_text(&label),
            blocked: taken.then(|| "A rule file with this name is already there.".to_string()),
        });
        Ok(RuleSheet { targets })
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSave {
    theme_id: String,
    label: String,
    projects: Vec<String>,
    target_id: String,
    /// The editor's text: one line for a CLAUDE.md, the whole file for a rule file.
    text: String,
    /// The stamp the sheet read for this target.
    stamp: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleReply {
    /// saved | conflict
    status: &'static str,
    backup_id: Option<String>,
    path: Option<String>,
    /// Shown on a conflict: "This file changed since you opened it."
    message: Option<String>,
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
        let (backup_id, path) = if args.target_id == "file" {
            let slug = review_rule::rule_slug(&args.label);
            let target = i.root.dir.join("rules").join(format!("{slug}.md"));
            // A rule file is new: if something is there now, the sheet is out of date.
            if sw::file_stamp(&target) != args.stamp {
                return Ok(RuleReply { status: "conflict", backup_id: None, path: None, message: Some(review_rule::STALE_MESSAGE.into()) });
            }
            let out = match sw::create_apply("rule", &slug, None, &args.text, &CreateCtx { root: &i.root.dir, claude_json: &i.root.claude_json }, &backups) {
                Ok(o) => o,
                Err(WriteError::Conflict) => return Ok(RuleReply { status: "conflict", backup_id: None, path: None, message: Some(review_rule::STALE_MESSAGE.into()) }),
                Err(e) => return Err(e.message()),
            };
            sw::tag_backup(&backups, &out.backup_id, "user", summary);
            (out.backup_id, atlas_core::setup::display_path(&target))
        } else {
            let found = claude_md_targets(&d, &i.root.dir, &args.projects).into_iter().find(|(id, _, _)| *id == args.target_id);
            let Some((_, _, file)) = found else { return Err("That place for the rule is not available any more. Close this and try again.".into()) };
            match sw::apply_append(&file, "instructions", "CLAUDE.md", review_rule::HEADING, &args.text, &args.stamp, summary, &backups) {
                Ok(o) => (o.backup_id.unwrap_or_default(), atlas_core::setup::display_path(&file)),
                Err(WriteError::Conflict) => return Ok(RuleReply { status: "conflict", backup_id: None, path: None, message: Some(review_rule::STALE_MESSAGE.into()) }),
                Err(e) => return Err(e.message()),
            }
        };
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        // The log only feeds the "Made a rule" label; the rule is already written either way.
        if let Err(e) = review_rule::record(&st.data_dir, &args.theme_id, &path, now) {
            eprintln!("[atlas] review-rules.json: {e}");
        }
        hub.refresh(&app, &st);
        Ok(RuleReply { status: "saved", backup_id: Some(backup_id), path: Some(path), message: None })
    })
    .await
}

/// After Undo: the theme offers the button again.
#[tauri::command]
pub async fn rule_forget(state: Info<'_>, theme_id: String) -> Result<(), String> {
    let data_dir = state.data_dir.clone();
    blocking(move || review_rule::forget(&data_dir, &theme_id).map_err(|e| e.to_string())).await
}
