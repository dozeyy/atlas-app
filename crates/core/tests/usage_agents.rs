//! Subagents: grouping under the parent session, naming and its fallbacks, per-agent spend and
//! "counted once", against `fixtures/claude-agents` (synthetic; numbers are in the generator).

mod common;

use std::sync::Arc;

use atlas_core::cache;
use atlas_core::usage::query::{AgentSummary, SessionDetail, SessionQuery};
use atlas_core::usage::time::Tz;
use atlas_core::usage::{NullSink, UsageEngine};
use common::*;
use rusqlite::Connection;

const SA: &str = "aaaa0001-0000-4000-8000-000000000001";
const SB: &str = "bbbb0002-0000-4000-8000-000000000002";
const SC: &str = "cccc0003-0000-4000-8000-000000000003";
const SD: &str = "dddd0004-0000-4000-8000-000000000004";
const SE: &str = "eeee0005-0000-4000-8000-000000000005";

fn detail(fx: &Fx, id: &str) -> SessionDetail {
    fx.engine.session_detail(id).unwrap().unwrap()
}

fn agent<'a>(d: &'a SessionDetail, id: &str) -> &'a AgentSummary {
    d.agents.iter().find(|a| a.agent_id == id).unwrap_or_else(|| panic!("no agent {id}"))
}

fn near(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} != {b}");
}

#[test]
fn subagents_nest_under_their_session_and_are_never_rows() {
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let page = fx.engine.sessions_list(&SessionQuery { limit: 50, ..Default::default() }).unwrap();
    let mut ids: Vec<&str> = page.rows.iter().map(|r| r.session_id.as_str()).collect();
    ids.sort();
    assert_eq!(ids, vec![SA, SB, SC, SD, SE], "five sessions, no row for any agent");
    assert_eq!(page.total, 5);
    let row = |id: &str| page.rows.iter().find(|r| r.session_id == id).unwrap();
    assert_eq!(row(SA).agent_count, 5);
    assert_eq!(row(SB).agent_count, 1);
    assert_eq!(row(SC).agent_count, 0);
    assert_eq!(row(SA).subagent_messages, 7);
    assert_eq!(fx.one("SELECT COUNT(*) FROM agents"), 6);
}

#[test]
fn main_thread_and_helpers_add_up_and_nothing_is_counted_twice() {
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let d = detail(&fx, SA);

    // The main thread alone.
    assert_eq!(d.main.messages, 2);
    assert_eq!((d.main.tokens.input, d.main.tokens.output, d.main.tokens.cache_write5m, d.main.tokens.cache_read), (150, 600, 2000, 22000));
    assert_eq!(d.main.tokens.total, 2750);
    assert_eq!(d.main.tool_calls, 2);

    // Each helper.
    assert_eq!(agent(&d, "a1").tokens.total, 400);
    assert_eq!(agent(&d, "a1").messages, 3);
    assert_eq!(agent(&d, "b2").tokens.total, 1340);
    assert_eq!(agent(&d, "c3").tokens.total, 65);
    assert_eq!(agent(&d, "d4").tokens.total, 77);
    assert_eq!(agent(&d, "e5").tokens.total, 89);

    // Main plus helpers is the session, exactly: tokens, messages and dollars.
    let helpers_tokens: u64 = d.agents.iter().map(|a| a.tokens.total).sum();
    let helpers_messages: u64 = d.agents.iter().map(|a| a.messages).sum();
    assert_eq!(d.main.tokens.total + helpers_tokens, d.row.tokens.total);
    assert_eq!(d.row.tokens.total, 4721);
    assert_eq!(d.main.messages + helpers_messages, d.row.messages);
    assert_eq!(d.row.messages, 9);
    let helpers_cost: f64 = d.agents.iter().map(|a| a.cost.usd.unwrap()).sum();
    near(d.main.cost.usd.unwrap() + helpers_cost, d.row.cost.usd.unwrap());

    // A message present in the main file and in a helper's file is one message, owned by the
    // copy with more output (the helper's), and the dashboard agrees with the sessions.
    assert_eq!(fx.one("SELECT COUNT(*) FROM messages WHERE msg_key LIKE 'msg_DUP|%'"), 1);
    let owner: String = fx.db().query_row("SELECT agent_id FROM messages WHERE msg_key LIKE 'msg_DUP|%'", [], |r| r.get(0)).unwrap();
    assert_eq!(owner, "a1");
    let sessions_total: u64 = fx
        .engine
        .sessions_list(&SessionQuery { limit: 50, ..Default::default() })
        .unwrap()
        .rows
        .iter()
        .map(|r| r.tokens.total)
        .sum();
    let by_model_total: u64 = d.by_model.iter().map(|m| m.tokens.total).sum();
    assert_eq!(by_model_total, d.row.tokens.total);
    assert_eq!(fx.one("SELECT SUM(input+output+cw5m+cw1h) FROM messages") as u64, sessions_total);
}

#[test]
fn helpers_are_named_by_description_then_type_then_prompt_then_helper() {
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let d = detail(&fx, SA);

    let a1 = agent(&d, "a1");
    assert_eq!((a1.name.as_str(), a1.name_source.as_str()), ("Find usages of Invoice", "description"));
    assert_eq!(a1.agent_type.as_deref(), Some("Explore"));
    assert_eq!(a1.tool_use_id.as_deref(), Some("toolu_spawn_a1"));

    let b2 = agent(&d, "b2");
    assert_eq!((b2.name.as_str(), b2.name_source.as_str()), ("General purpose", "type"), "a blank description falls back to the type");

    let c3 = agent(&d, "c3");
    assert_eq!(c3.name_source, "prompt", "no sidecar: the first prompt names it");
    assert!(c3.name.starts_with("Write unit tests for the rounding helper"), "{}", c3.name);
    assert!(c3.name.chars().count() <= 83);

    let d4 = agent(&d, "d4");
    assert_eq!((d4.name.as_str(), d4.name_source.as_str()), ("Helper", "fallback"), "a command wrapper is not a name");

    let e5 = agent(&d, "e5");
    assert_eq!(e5.name, "Check currency rounding docs");
    assert_eq!(e5.parent_agent_id.as_deref(), Some("a1"));
    assert_eq!(e5.spawn_depth, 2);

    // Spawn order, not file-name order.
    let order: Vec<&str> = d.agents.iter().map(|a| a.agent_id.as_str()).collect();
    assert_eq!(order, vec!["a1", "e5", "b2", "c3", "d4"]);
    for a in &d.agents {
        assert!(!a.name.contains("0000"), "an id is never a name: {}", a.name);
    }
}

#[test]
fn sessions_are_named_by_title_then_agent_name_then_prompt_never_an_id() {
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let page = fx.engine.sessions_list(&SessionQuery { limit: 50, ..Default::default() }).unwrap();
    let row = |id: &str| page.rows.iter().find(|r| r.session_id == id).unwrap();
    let pair = |id: &str| (row(id).name.clone(), row(id).name_source.clone());
    assert_eq!(pair(SA), (Some("Refactor the billing module so invoices round correctly".into()), "prompt".into()));
    assert_eq!(pair(SB), (Some("Billing cleanup".into()), "title".into()));
    assert_eq!(pair(SC), (Some("Docs pass".into()), "agent".into()));
    assert_eq!(pair(SD), (Some("Add a dark mode toggle to the settings page".into()), "prompt".into()));
    assert_eq!(pair(SE), (None, "none".into()), "nothing to go on: the UI says Session in <project>");
    // The search box finds a session by what it is called now.
    let hit = fx.engine.sessions_list(&SessionQuery { text: Some("dark mode".into()), limit: 50, ..Default::default() }).unwrap();
    assert_eq!(hit.rows.len(), 1);
    assert_eq!(hit.rows[0].session_id, SD);
}

#[test]
fn also_ids_adds_chats_found_by_message_search_to_the_title_matches() {
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let ids = |q: SessionQuery| -> Vec<String> {
        let mut v: Vec<String> = fx.engine.sessions_list(&q).unwrap().rows.into_iter().map(|r| r.session_id).collect();
        v.sort();
        v
    };
    let base = SessionQuery { limit: 50, ..Default::default() };
    // Only the ids: those sessions and nothing else, and the total counts them.
    let only = SessionQuery { also_ids: vec![SB.into(), SC.into()], ..base.clone() };
    assert_eq!(ids(only.clone()), vec![SB.to_string(), SC.to_string()]);
    assert_eq!(fx.engine.sessions_list(&only).unwrap().total, 2);
    // With text: the union (title match for "dark mode" is SD).
    let both = SessionQuery { text: Some("dark mode".into()), also_ids: vec![SB.into()], ..base.clone() };
    assert_eq!(ids(both), vec![SB.to_string(), SD.to_string()]);
    // The other filters still apply to an id that was found by message text.
    let wrong_project = SessionQuery { also_ids: vec![SB.into()], projects: vec!["no-such-project".into()], ..base.clone() };
    assert!(ids(wrong_project).is_empty());
    // An id that does not exist adds nothing and breaks nothing.
    let ghost = SessionQuery { also_ids: vec!["ghost".into()], ..base };
    assert!(ids(ghost).is_empty());
}

#[test]
fn one_helper_shows_what_it_spent_and_what_it_was_asked() {
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let a = fx.engine.agent_detail(SA, "a1").unwrap().unwrap();
    assert_eq!(a.agent.name, "Find usages of Invoice");
    assert_eq!(a.agent.model, "claude-haiku-5-5", "the model that did most of the work");
    assert_eq!(a.agent.models, vec!["claude-haiku-5-5".to_string(), "claude-opus-5-5".to_string()]);
    assert_eq!(a.agent.tool_calls, 3);
    assert_eq!(a.agent.tokens.input, 60);
    assert_eq!(a.agent.tokens.output, 340);
    assert_eq!(a.agent.tokens.cache_read, 1200);
    assert_eq!(a.agent.duration_ms, 18 * 60_000 + 50_000);
    assert_eq!(a.timeline.len(), 3);
    assert_eq!(a.by_model.len(), 2);
    let model_cost: f64 = a.by_model.iter().map(|m| m.cost.usd.unwrap()).sum();
    near(model_cost, a.agent.cost.usd.unwrap());
    assert_eq!(a.prompt.as_deref(), Some("Search the repo for every use of Invoice and report the files"));
    assert_eq!(a.session_tokens.total, 4721);
    assert_eq!(a.parent_name, None);

    let e = fx.engine.agent_detail(SA, "e5").unwrap().unwrap();
    assert_eq!(e.parent_name.as_deref(), Some("Find usages of Invoice"));
    assert!(fx.engine.agent_detail(SA, "nope").unwrap().is_none());
    assert!(fx.engine.agent_detail("no-such-session", "a1").unwrap().is_none());
}

#[test]
fn a_session_without_helpers_has_an_empty_list_and_main_is_the_whole_session() {
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let d = detail(&fx, SC);
    assert!(d.agents.is_empty());
    assert_eq!(d.main.tokens.total, d.row.tokens.total);
    assert_eq!(d.main.messages, d.row.messages);
}

#[test]
fn include_missing_defaults_to_what_the_ui_sends() {
    assert!(SessionQuery::default().include_missing);
    let q: SessionQuery = serde_json::from_str("{}").unwrap();
    assert!(q.include_missing);
    let q: SessionQuery = serde_json::from_str(r#"{"includeMissing":false}"#).unwrap();
    assert!(!q.include_missing);
}

/// A cache from before helpers were tracked (schema 1) is upgraded and re-read, so the helpers appear.
#[test]
fn an_older_cache_is_migrated_and_re_read() {
    let config = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-agents"), config.path());
    let data = tempfile::tempdir().unwrap();
    let db = data.path().join("cache.sqlite");
    let engine = UsageEngine::start(config_for(config.path(), data.path(), Tz::Fixed(0)), Arc::new(NullSink));
    assert!(engine.wait_pass(0, WAIT));
    engine.stop();
    drop(engine);
    {
        let c = Connection::open(&db).unwrap();
        c.execute_batch(
            "DROP TABLE agents; ALTER TABLE files DROP COLUMN tool_calls; ALTER TABLE sessions DROP COLUMN prompt_summary;
             UPDATE meta SET value='1' WHERE key='parser_version'; PRAGMA user_version = 1;",
        )
        .unwrap();
    }
    let engine = UsageEngine::start(config_for(config.path(), data.path(), Tz::Fixed(0)), Arc::new(NullSink));
    assert!(engine.wait_pass(0, WAIT));
    let c = Connection::open(&db).unwrap();
    assert_eq!(c.query_row::<i64, _, _>("PRAGMA user_version", [], |r| r.get(0)).unwrap(), cache::SCHEMA_VERSION);
    assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM agents", [], |r| r.get(0)).unwrap(), 6);
    assert_eq!(c.query_row::<i64, _, _>("SELECT COUNT(*) FROM messages", [], |r| r.get(0)).unwrap(), 14);
    let d = engine.session_detail(SA).unwrap().unwrap();
    assert_eq!(d.agents.len(), 5);
    assert_eq!(d.row.tokens.total, 4721, "re-reading must not double anything");
}

#[test]
fn wrapped_habits_split_helper_work_from_the_chats_and_find_the_busiest_crowd() {
    use atlas_core::usage::wrapped::{LONG_CHAT_MS, SHORT_CHAT_MS};
    let fx = start(&fixture("claude-agents"), Tz::Fixed(0));
    let h = fx.engine.wrapped_habits("2000-01-01", "2100-12-31").unwrap();
    let rows = fx.engine.sessions_list(&SessionQuery { limit: 50, ..Default::default() }).unwrap().rows;

    assert_eq!(h.chats, 5);
    assert_eq!(h.all_tokens, rows.iter().map(|r| r.tokens.total).sum::<u64>(), "the story's total");
    let helpers: u64 = rows.iter().map(|r| detail(&fx, &r.session_id).agents.iter().map(|a| a.tokens.total).sum::<u64>()).sum();
    assert!(helpers > 0);
    assert_eq!(h.helper_tokens, helpers, "every helper token, once");
    assert_eq!(h.short_chats, rows.iter().filter(|r| r.duration_ms < SHORT_CHAT_MS).count() as u64);
    assert_eq!(h.long_chats, rows.iter().filter(|r| r.duration_ms >= LONG_CHAT_MS).count() as u64);

    let crowd = h.most_helpers.expect("one chat had helpers");
    assert_eq!(crowd.session_id, SA);
    assert_eq!(crowd.agent_count, 5);

    // A range with nothing in it says so instead of inventing a chat.
    let none = fx.engine.wrapped_habits("2001-01-01", "2001-01-02").unwrap();
    assert_eq!((none.chats, none.all_tokens, none.helper_tokens), (0, 0, 0));
    assert!(none.most_helpers.is_none());
}
