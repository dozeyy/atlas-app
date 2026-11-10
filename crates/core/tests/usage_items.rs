//! Which skills, helper types and tools were used, per session and per day, against
//! `fixtures/claude-items` (synthetic; the calls are listed in its generator).
//!
//! Session 1111 (Nov 5 and 6): Skill ui-ux-pro-max x2, Skill orchestrate x2 (one inside a helper's
//! file), Agent Explore, Agent code-reviewer, a Task with no type, Read x4, Bash x2, one MCP tool.
//! Session 2222 (Oct 1, outside a 30 day window): Skill ui-ux-pro-max, Skill old-skill, Agent
//! Explore, Bash.

mod common;

use atlas_core::usage::query::{ItemKind, ItemQuery, ItemUse};
use atlas_core::usage::time::Tz;
use common::*;
use std::fs;
use std::io::Write;

const I1: &str = "11110001-0000-4000-8000-000000000001";

fn q(kind: ItemKind, from: Option<&str>, to: Option<&str>, session: Option<&str>) -> ItemQuery {
    ItemQuery { kind, from: from.map(Into::into), to: to.map(Into::into), session_id: session.map(Into::into), limit: None }
}

fn get(fx: &Fx, kind: ItemKind, from: Option<&str>, to: Option<&str>, session: Option<&str>) -> Vec<ItemUse> {
    fx.engine.usage_by_item(&q(kind, from, to, session)).unwrap()
}

fn counts(v: &[ItemUse]) -> Vec<(&str, u64)> {
    v.iter().map(|i| (i.id.as_str(), i.uses)).collect()
}

fn find<'a>(v: &'a [ItemUse], id: &str) -> &'a ItemUse {
    v.iter().find(|i| i.id == id).unwrap_or_else(|| panic!("no item {id}"))
}

fn ms(iso: &str) -> i64 {
    atlas_core::usage::time::parse_iso_ms(iso).unwrap()
}

#[test]
fn skills_are_counted_by_name_over_all_time() {
    let fx = start(&fixture("claude-items"), Tz::Fixed(0));
    let v = get(&fx, ItemKind::Skill, None, None, None);
    assert_eq!(counts(&v), vec![("ui-ux-pro-max", 3), ("orchestrate", 2), ("old-skill", 1)], "busiest first");
    assert_eq!(find(&v, "ui-ux-pro-max").sessions, 2);
    assert_eq!(find(&v, "ui-ux-pro-max").last_used, Some(ms("2026-11-05T10:05:00.000Z")));
    assert_eq!(find(&v, "orchestrate").last_used, Some(ms("2026-11-06T09:05:00.000Z")), "the helper's own file counts, under the parent session");
    assert!(v.iter().all(|i| i.kind == ItemKind::Skill));
}

#[test]
fn a_period_counts_only_its_days_and_keeps_the_last_time_ever() {
    let fx = start(&fixture("claude-items"), Tz::Fixed(0));
    let v = get(&fx, ItemKind::Skill, Some("2026-10-09"), Some("2026-11-08"), None);
    assert_eq!(find(&v, "ui-ux-pro-max").uses, 2, "the October use is outside the window");
    assert_eq!(find(&v, "orchestrate").uses, 2);
    let old = find(&v, "old-skill");
    assert_eq!((old.uses, old.sessions), (0, 0), "not used in the window");
    assert_eq!(old.last_used, Some(ms("2026-10-01T08:00:00.000Z")), "but it says when it last ran");

    // One day.
    let day = get(&fx, ItemKind::Skill, Some("2026-11-05"), Some("2026-11-05"), None);
    assert_eq!(find(&day, "ui-ux-pro-max").uses, 2);
    assert_eq!(find(&day, "orchestrate").uses, 0);
}

#[test]
fn helper_types_come_from_the_agent_and_task_calls() {
    let fx = start(&fixture("claude-items"), Tz::Fixed(0));
    let all = get(&fx, ItemKind::Agent, None, None, None);
    assert_eq!(find(&all, "Explore").uses, 2);
    assert_eq!(find(&all, "code-reviewer").uses, 1);
    assert_eq!(find(&all, "general-purpose").uses, 1, "a Task call with no type runs the general-purpose helper");
    assert_eq!(all.len(), 3);
    let month = get(&fx, ItemKind::Agent, Some("2026-10-09"), Some("2026-11-08"), None);
    assert_eq!(find(&month, "Explore").uses, 1);
}

#[test]
fn every_tool_is_counted_by_name_including_agent_skill_and_mcp() {
    let fx = start(&fixture("claude-items"), Tz::Fixed(0));
    let v = get(&fx, ItemKind::Tool, None, None, None);
    for (id, n) in [("Skill", 6), ("Read", 4), ("Bash", 3), ("Agent", 3), ("Task", 1), ("mcp__blender__look", 1)] {
        assert_eq!(find(&v, id).uses, n, "{id}");
    }
    assert_eq!(v.iter().map(|i| i.uses).sum::<u64>(), 18);
    assert_eq!(v[0].id, "Skill", "busiest first");
}

#[test]
fn one_session_can_be_asked_alone() {
    let fx = start(&fixture("claude-items"), Tz::Fixed(0));
    let v = get(&fx, ItemKind::Skill, None, None, Some(I1));
    assert_eq!(counts(&v).len(), 2, "old-skill ran in the other session");
    assert_eq!(find(&v, "ui-ux-pro-max").uses, 2);
    assert_eq!(find(&v, "orchestrate").uses, 2);
    let tools = get(&fx, ItemKind::Tool, None, None, Some(I1));
    assert_eq!(find(&tools, "Read").uses, 4);
    assert_eq!(find(&tools, "Bash").uses, 2);
}

#[test]
fn days_follow_the_time_zone() {
    // 10:00 UTC on Nov 5 is 05:00 on Nov 5 at UTC-5 and 23:00 on Nov 5 at UTC+13; the Nov 6 09:00
    // call is still Nov 6 at UTC-5 but Nov 6 22:00 at UTC+13. Move the zone and the days move.
    let west = start(&fixture("claude-items"), Tz::Fixed(-5 * 3600));
    let v = get(&west, ItemKind::Skill, Some("2026-11-06"), Some("2026-11-06"), None);
    assert_eq!(find(&v, "orchestrate").uses, 2);
    assert_eq!(find(&v, "ui-ux-pro-max").uses, 0);
    let east = start(&fixture("claude-items"), Tz::Fixed(15 * 3600));
    // At UTC+15, Nov 5 10:00 UTC is Nov 6 01:00.
    let v = get(&east, ItemKind::Skill, Some("2026-11-06"), Some("2026-11-06"), None);
    assert_eq!(find(&v, "ui-ux-pro-max").uses, 2);
}

#[test]
fn reading_again_never_counts_twice_and_appending_adds_exactly_the_new_calls() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-items"), dir.path());
    let fx = start(dir.path(), Tz::Fixed(0));
    let before = get(&fx, ItemKind::Tool, None, None, None);
    fx.full_reread();
    assert_eq!(get(&fx, ItemKind::Tool, None, None, None), before, "a full re-read gives the same counts");

    let path = dir.path().join(format!("projects/-fx-items/{I1}.jsonl"));
    let extra = r#"{"type":"assistant","sessionId":"11110001-0000-4000-8000-000000000001","timestamp":"2026-11-07T08:00:00.000Z","message":{"id":"msg_NEW","model":"claude-sonnet-5-5","content":[{"type":"tool_use","id":"toolu_new1","name":"Skill","input":{"skill":"orchestrate"}},{"type":"tool_use","id":"toolu_new2","name":"Grep","input":{"pattern":"x"}}],"usage":{"input_tokens":1,"output_tokens":2}},"requestId":"req_NEW"}"#;
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(f, "{extra}").unwrap();
    drop(f);
    fx.rescan();
    let skills = get(&fx, ItemKind::Skill, None, None, None);
    assert_eq!(find(&skills, "orchestrate").uses, 3);
    let tools = get(&fx, ItemKind::Tool, None, None, None);
    assert_eq!(find(&tools, "Skill").uses, 7);
    assert_eq!(find(&tools, "Grep").uses, 1);
    assert_eq!(find(&tools, "Read").uses, 4, "untouched");
}

#[test]
fn a_line_that_is_not_json_or_has_no_name_adds_nothing() {
    let dir = tempfile::tempdir().unwrap();
    copy_tree(&fixture("claude-items"), dir.path());
    let path = dir.path().join(format!("projects/-fx-items/{I1}.jsonl"));
    let mut f = fs::OpenOptions::new().append(true).open(&path).unwrap();
    writeln!(f, r#"{{"type":"assistant","type":"tool_use" broken"#).unwrap();
    writeln!(f, r#"{{"type":"assistant","sessionId":"{I1}","timestamp":"2026-11-07T09:00:00.000Z","message":{{"id":"msg_Z","content":[{{"type":"tool_use","id":"t","input":{{}}}}],"usage":{{"input_tokens":1,"output_tokens":1}}}},"requestId":"r"}}"#).unwrap();
    drop(f);
    let fx = start(dir.path(), Tz::Fixed(0));
    let tools = get(&fx, ItemKind::Tool, None, None, None);
    assert_eq!(tools.iter().map(|i| i.uses).sum::<u64>(), 18);
}

#[test]
fn an_old_cache_is_upgraded_and_filled_by_one_re_read() {
    let cfg = fixture("claude-items");
    let first = start(&cfg, Tz::Fixed(0));
    let Fx { engine, data, cache, .. } = first;
    drop(engine);
    // Make the cache look like it was written before the item table existed.
    {
        let c = rusqlite::Connection::open(&cache).unwrap();
        c.execute_batch("DROP TABLE item_use; ALTER TABLE messages DROP COLUMN effort; PRAGMA user_version = 2; UPDATE meta SET value='2' WHERE key='parser_version';").unwrap();
    }
    let fx = start_in(&cfg, data, Tz::Fixed(0));
    assert_eq!(fx.one("PRAGMA user_version"), atlas_core::cache::SCHEMA_VERSION);
    let v = get(&fx, ItemKind::Skill, None, None, None);
    assert_eq!(find(&v, "ui-ux-pro-max").uses, 3);
    assert_eq!(find(&v, "orchestrate").uses, 2);
}
