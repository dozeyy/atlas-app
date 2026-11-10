//! `get_usage_summary`: Claude Code token use for a period, from the same engine and price
//! list as the Atlas app (so the numbers match its charts). Read-only on the transcripts; the
//! index lives in Atlas's own data folder and is only started when this tool is first used.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use atlas_core::usage::naming::model_label;
use atlas_core::usage::query::{Cost, EffortUse, ModelUse, ScopeArgs, SessionRow, Tokens};
use atlas_core::usage::scorecard::{DebriefArgs, RunDebrief, Scorecard, ScorecardArgs, ThemeArgs, Themes};
use atlas_core::usage::{Event, EventSink, UsageConfig, UsageEngine, time};
use serde_json::{Value, json};

struct Quiet;
impl EventSink for Quiet {
    fn emit(&self, _: Event) {}
    fn log(&self, _: &str) {}
}

/// How long the first call waits for the first read of the transcripts.
const FIRST_PASS: Duration = Duration::from_secs(90);

pub struct Usage {
    projects_dir: PathBuf,
    config_dir: PathBuf,
    /// `<local app data>/atlas`, the same folder the app and `atlas-usage` use.
    local_data: PathBuf,
    engine: Mutex<Option<Arc<UsageEngine>>>,
}

impl Usage {
    pub fn new(projects_dir: PathBuf, config_dir: PathBuf, local_data: PathBuf) -> Usage {
        Usage { projects_dir, config_dir, local_data, engine: Mutex::new(None) }
    }

    fn engine(&self) -> Result<Arc<UsageEngine>, String> {
        let mut slot = self.engine.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(e) = &*slot {
            return Ok(Arc::clone(e));
        }
        if !self.projects_dir.is_dir() {
            return Err("There are no Claude Code chats to read yet (the projects folder does not exist).".into());
        }
        let cache_dir = self.local_data.join("cli");
        if atlas_core::usage::is_inside(&cache_dir, &self.projects_dir) || atlas_core::usage::is_inside(&cache_dir, &self.config_dir) {
            return Err("Atlas's data folder must not be inside the Claude folder.".into());
        }
        std::fs::create_dir_all(&cache_dir).map_err(|e| format!("Atlas can't create its data folder: {e}"))?;
        copy_pricing(&self.local_data, &cache_dir);
        let mut cfg = UsageConfig::new(self.projects_dir.clone(), self.config_dir.clone(), cache_dir.clone(), cache_dir.join("cache.sqlite"));
        cfg.watch = false;
        cfg.week_starts_sunday = time::week_starts_sunday();
        let e = UsageEngine::start(cfg, Arc::new(Quiet));
        *slot = Some(Arc::clone(&e));
        Ok(e)
    }

    /// The engine, once its first read of the chats is done.
    fn ready(&self) -> Result<Arc<UsageEngine>, String> {
        let engine = self.engine()?;
        if !engine.wait_pass(0, FIRST_PASS) {
            return Err("Atlas is still reading your Claude Code chats for the first time. Try again in a minute.".into());
        }
        Ok(engine)
    }

    /// The agent scorecard (read-only; `docs/specs/agent-scorecard.md`).
    pub fn scorecard(&self, a: &ScorecardArgs) -> Result<Scorecard, String> {
        self.ready()?.agent_scorecard(a)
    }

    /// The findings reviewers keep raising, grouped (masked text).
    pub fn themes(&self, a: &ThemeArgs) -> Result<Themes, String> {
        self.ready()?.review_themes(a)
    }

    /// One chat's helpers since a time; `None` when no chat has that id.
    pub fn debrief(&self, a: &DebriefArgs) -> Result<Option<RunDebrief>, String> {
        self.ready()?.run_debrief(a)
    }

    /// The chat to debrief when the caller does not know its own id: the newest one that used
    /// helpers (else the newest chat), in any project, with the plain line that says which chat it is.
    pub fn newest_chat(&self) -> Result<Option<(String, String)>, String> {
        let engine = self.ready()?;
        let q: atlas_core::usage::query::SessionQuery = serde_json::from_value(json!({ "sort": "start", "dir": "desc", "limit": 100 })).map_err(|e| e.to_string())?;
        let rows = engine.sessions_list(&q)?.rows;
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64);
        Ok(atlas_core::usage::debrief_text::pick_newest(&rows).map(|(row, has_helpers)| (row.session_id.clone(), atlas_core::usage::debrief_text::fallback_line(row, has_helpers, now))))
    }

    /// `period`: today | yesterday | 7d | 30d | month | all. `project`: part of a project name.
    pub fn summary(&self, period: &str, project: Option<&str>) -> Result<Value, String> {
        let engine = self.ready()?;
        let today = engine.today_date();
        let (from, to, label) = match period.trim().to_lowercase().as_str() {
            "today" => (today.clone(), today.clone(), "today"),
            "yesterday" => (time::add_days(&today, -1), time::add_days(&today, -1), "yesterday"),
            "7d" | "week" | "" => (time::add_days(&today, -6), today.clone(), "the last 7 days"),
            "30d" | "30" => (time::add_days(&today, -29), today.clone(), "the last 30 days"),
            "month" => (format!("{}01", &today[..today.len().min(8)]), today.clone(), "this month"),
            "all" => (engine.first_day()?.unwrap_or_else(|| today.clone()), today.clone(), "all time"),
            other => return Err(format!("Unknown period \"{other}\". Use today, yesterday, 7d, 30d, month or all.")),
        };
        let args = |key: Option<String>| ScopeArgs { from: from.clone(), to: to.clone(), project_key: key, bucket: "day".into(), top: 5 };
        let mut report = engine.scope_report(&args(None))?;
        let mut project_name = None;
        if let Some(p) = project.map(str::trim).filter(|p| !p.is_empty()) {
            let q = p.to_lowercase();
            let hit = report.projects.iter().find(|u| u.name.to_lowercase() == q).or_else(|| report.projects.iter().find(|u| u.name.to_lowercase().contains(&q) || u.path.to_lowercase().contains(&q)));
            let Some(hit) = hit else {
                return Err(format!("No project matching \"{p}\" has any use in {label}. Projects with use: {}.", report.projects.iter().take(10).map(|u| u.name.as_str()).collect::<Vec<_>>().join(", ")));
            };
            project_name = Some(hit.name.clone());
            let key = hit.project_key.clone();
            report = engine.scope_report(&args(Some(key)))?;
        }
        Ok(json!({
            "period": label,
            "from": report.from,
            "to": report.to,
            "project": project_name,
            "chats": report.total.sessions,
            "tokens": tokens(&report.total.tokens),
            "estimatedCostUsd": cost_usd(&report.total.cost),
            "costIsComplete": report.total.cost.complete,
            "costNote": "An estimate at API prices, not a bill. Subscription plans are not billed per token.",
            "byModel": report.by_model.iter().take(6).map(model_json).collect::<Vec<_>>(),
            "topProjects": report.projects.iter().take(5).map(|p| json!({"name": p.name, "tokens": p.tokens.total, "estimatedCostUsd": cost_usd(&p.cost), "chats": p.sessions})).collect::<Vec<_>>(),
            "topChats": report.chats.iter().take(5).map(chat_json).collect::<Vec<_>>(),
        }))
    }
}

impl Drop for Usage {
    fn drop(&mut self) {
        if let Some(e) = self.engine.lock().unwrap_or_else(|p| p.into_inner()).take() {
            e.stop();
        }
    }
}

fn tokens(t: &Tokens) -> Value {
    json!({"total": t.total, "input": t.input, "output": t.output, "cacheWrite": t.cache_write5m + t.cache_write1h, "cacheRead": t.cache_read})
}

/// One model: its id, the name people use ("Opus 5.5"), whether the price list knows it, and
/// its replies per reasoning effort (empty when the transcripts gave none; never guessed).
fn model_json(m: &ModelUse) -> Value {
    json!({
        "model": m.model,
        "name": model_label(&m.model),
        "priced": m.known,
        "tokens": m.tokens.total,
        "estimatedCostUsd": cost_usd(&m.cost),
        "efforts": efforts_json(&m.efforts),
    })
}

fn chat_json(c: &SessionRow) -> Value {
    json!({
        "name": c.name.clone().unwrap_or_else(|| format!("Chat in {}", c.project_name)),
        "project": c.project_name,
        "model": (!c.main_model.is_empty()).then(|| model_label(&c.main_model)),
        "efforts": efforts_json(&c.efforts),
        "tokens": c.tokens.total,
        "estimatedCostUsd": cost_usd(&c.cost),
    })
}

fn efforts_json(e: &[EffortUse]) -> Value {
    Value::Array(e.iter().map(|x| json!({"effort": x.effort, "replies": x.replies})).collect())
}

fn cost_usd(c: &Cost) -> Option<f64> {
    c.usd.map(|v| (v * 100.0).round() / 100.0)
}

fn copy_pricing(app_dir: &Path, cache_dir: &Path) {
    for name in ["pricing.json", "pricing.seed-hash"] {
        let src = app_dir.join(name);
        if src.is_file() {
            let _ = std::fs::copy(&src, cache_dir.join(name));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_carry_their_name_price_state_and_effort_mix() {
        let m = ModelUse {
            model: "claude-fable-5-2".into(),
            known: true,
            tokens: Tokens { total: 10, ..Default::default() },
            cost: Cost::default(),
            efforts: vec![EffortUse { effort: "high".into(), replies: 3 }],
        };
        let v = model_json(&m);
        assert_eq!(v["name"], "Fable 5.2");
        assert_eq!(v["priced"], true);
        assert_eq!(v["efforts"][0]["effort"], "high");
        assert_eq!(v["efforts"][0]["replies"], 3);
        let unknown = model_json(&ModelUse { model: "claude-nova-9-1".into(), known: false, efforts: Vec::new(), ..m });
        assert_eq!(unknown["name"], "Nova 9.1");
        assert_eq!(unknown["priced"], false);
        assert_eq!(unknown["efforts"], json!([]), "absent effort stays empty");
    }
}
