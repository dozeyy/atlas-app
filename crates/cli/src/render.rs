//! Chat-ready markdown: a headline line, block-bar charts in ```text blocks (so columns
//! line up in any monospace font) and a few short tables.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use atlas_core::usage::query::{ScopeReport, SessionDetail, SessionRow, TimelinePoint};
use atlas_core::usage::time::Tz;
use chrono::{Duration, NaiveDate, NaiveDateTime, Timelike};

use crate::fmt::{bar, cell, change, compact, duration, model, usd};
use crate::scope::{Span, short};

const BAR: usize = 24;
const DOT: &str = " \u{00B7} ";
const FOOTER: &str = "_Tokens = input + output + cache writes; cache reads are shown apart. Dollar figures are API-price estimates, not a bill._";

/// Rows of `label  bar  value [extra]` inside a ```text block.
fn bars(rows: &[(String, u64, String)]) -> String {
    let max = rows.iter().map(|r| r.1).max().unwrap_or(0);
    let lw = rows.iter().map(|r| r.0.chars().count()).max().unwrap_or(0);
    let vw = rows.iter().map(|r| compact(r.1).len()).max().unwrap_or(0);
    let mut s = String::from("```text\n");
    for (label, v, extra) in rows {
        let line = format!("{label:<lw$}  {}  {:>vw$}{}", bar(*v, max, BAR), compact(*v), if extra.is_empty() { String::new() } else { format!("  {extra}") });
        let _ = writeln!(s, "{}", line.trim_end());
    }
    s.push_str("```\n");
    s
}

fn pct(part: u64, whole: u64) -> String {
    if whole == 0 {
        return "0%".into();
    }
    let p = part as f64 / whole as f64 * 100.0;
    if p > 0.0 && p < 1.0 { "<1%".into() } else { format!("{p:.0}%") }
}

fn bucket_label(start: &str, bucket: &str) -> String {
    let Some(d) = NaiveDate::parse_from_str(start, "%Y-%m-%d").ok() else { return start.to_string() };
    match bucket {
        "week" => format!("wk of {}", d.format("%b %-d %Y")),
        "month" => d.format("%b %Y").to_string(),
        _ => d.format("%a %b %-d").to_string(),
    }
}

fn series(points: &[TimelinePoint], bucket: &str) -> Vec<(String, u64, String)> {
    points.iter().map(|p| (bucket_label(&p.start, bucket), p.tokens.total, String::new())).collect()
}

pub struct RangeView<'a> {
    pub span: &'a Span,
    pub today: NaiveDate,
    pub report: &'a ScopeReport,
    pub project: Option<&'a str>,
    pub top_chats: &'a [SessionRow],
    pub compare: Option<(&'a Span, &'a ScopeReport)>,
    pub top: usize,
}

fn dates(s: &Span, today: NaiveDate) -> String {
    if s.from == s.to { short(s.from, today) } else { format!("{} - {}", short(s.from, today), short(s.to, today)) }
}

pub fn range(v: &RangeView) -> String {
    let r = v.report;
    let t = &r.total;
    let mut s = String::new();
    let where_ = v.project.map(|p| format!("project **{}**", cell(p, 40))).unwrap_or_else(|| "all projects".into());
    let _ = writeln!(s, "**{}**{DOT}{}{DOT}{}", v.span.label, dates(v.span, v.today), where_);
    let _ = writeln!(
        s,
        "**{} tokens**{DOT}{} cache reads{DOT}{} chats{DOT}~{} API-price estimate\n",
        compact(t.tokens.total),
        compact(t.tokens.cache_read),
        t.sessions,
        usd(t.cost.usd, t.cost.complete)
    );

    if let Some((cs, cr)) = v.compare {
        s.push_str(&compare(v.span, r, cs, cr, v.today));
    } else if t.tokens.total == 0 {
        s.push_str("No Claude Code usage recorded in this range.\n\n");
    } else if r.points.len() > 1 {
        let per = match r.bucket.as_str() {
            "week" => "Per week",
            "month" => "Per month",
            _ => "Per day",
        };
        let _ = writeln!(s, "{per}");
        s.push_str(&bars(&series(&r.points, &r.bucket)));
        s.push('\n');
    }

    if t.tokens.total > 0 {
        // With a comparison, the lists below are for the first range only; say which.
        let _ = writeln!(s, "Models{}", if v.compare.is_some() { format!("{DOT}{}", v.span.label) } else { String::new() });
        let rows: Vec<_> = r
            .by_model
            .iter()
            .filter(|m| m.tokens.total > 0)
            .take(v.top)
            .map(|m| (model(&m.model), m.tokens.total, pct(m.tokens.total, t.tokens.total)))
            .collect();
        s.push_str(&bars(&rows));
        s.push('\n');
    }

    if v.project.is_none() && r.projects.len() > 1 {
        s.push_str("| Project | Tokens | Chats |\n|---|--:|--:|\n");
        for p in r.projects.iter().take(v.top) {
            let _ = writeln!(s, "| {} | {} | {} |", cell(&p.name, 40), compact(p.tokens.total), p.sessions);
        }
        s.push('\n');
    }

    if !v.top_chats.is_empty() {
        s.push_str("| Biggest chats active in this range | Project | Tokens (whole chat) |\n|---|---|--:|\n");
        for c in v.top_chats {
            let name = c.name.as_deref().unwrap_or("(untitled)");
            let _ = writeln!(s, "| {} | {} | {} |", cell(name, 48), cell(&c.project_name, 28), compact(c.tokens.total));
        }
        s.push('\n');
    }
    s.push_str(FOOTER);
    s
}

/// Earlier range is the baseline; the change column is the later range against it.
fn compare(a: &Span, ar: &ScopeReport, b: &Span, br: &ScopeReport, today: NaiveDate) -> String {
    let ((e, er), (l, lr)) = if (b.from, b.to) < (a.from, a.to) { ((b, br), (a, ar)) } else { ((a, ar), (b, br)) };
    let mut s = format!("**{}** ({}) vs **{}** ({})\n", l.label, dates(l, today), e.label, dates(e, today));
    let rows: [(&str, String, String, String); 4] = [
        ("Tokens", compact(er.total.tokens.total), compact(lr.total.tokens.total), change(er.total.tokens.total, lr.total.tokens.total)),
        ("Cache reads", compact(er.total.tokens.cache_read), compact(lr.total.tokens.cache_read), change(er.total.tokens.cache_read, lr.total.tokens.cache_read)),
        ("Chats", er.total.sessions.to_string(), lr.total.sessions.to_string(), change(er.total.sessions, lr.total.sessions)),
        ("API estimate", usd(er.total.cost.usd, er.total.cost.complete), usd(lr.total.cost.usd, lr.total.cost.complete), String::new()),
    ];
    let _ = writeln!(s, "\n| | {} | {} | Change |\n|---|--:|--:|--:|", e.label, l.label);
    for (k, x, y, c) in rows {
        let _ = writeln!(s, "| {k} | {x} | {y} | {c} |");
    }
    s.push('\n');
    if er.bucket == "day" && lr.bucket == "day" && er.points.len() == lr.points.len() && er.points.len() > 1 {
        s.push_str("Day by day\n");
        let mut rows = Vec::new();
        for (p, q) in lr.points.iter().zip(&er.points) {
            rows.push((bucket_label(&p.start, "day"), p.tokens.total, String::new()));
            rows.push((bucket_label(&q.start, "day"), q.tokens.total, String::new()));
        }
        s.push_str(&bars(&rows));
        s.push('\n');
    }
    s
}

fn local(ts: i64) -> Option<NaiveDateTime> {
    Tz::Local.local(ts)
}

pub fn chat(d: &SessionDetail, note: Option<&str>, top: usize) -> String {
    let r = &d.row;
    let mut s = String::new();
    let _ = writeln!(
        s,
        "**This chat**{DOT}**{} tokens**{DOT}{} cache reads{DOT}~{} API-price estimate",
        compact(r.tokens.total),
        compact(r.tokens.cache_read),
        usd(r.cost.usd, r.cost.complete)
    );
    let mut meta = Vec::new();
    if let Some(n) = r.name.as_deref() {
        meta.push(format!("\"{}\"", cell(n, 60)));
    }
    if !r.project_name.is_empty() {
        meta.push(cell(&r.project_name, 40));
    }
    meta.push(duration(r.duration_ms));
    meta.push(format!("{} messages", r.messages));
    let helpers = d.agents.len();
    meta.push(format!("{helpers} helper{}", if helpers == 1 { "" } else { "s" }));
    let _ = writeln!(s, "{}", meta.join(DOT));
    if let Some(n) = note {
        let _ = writeln!(s, "_{n}_");
    }
    s.push('\n');

    if helpers > 0 {
        let helper_total: u64 = d.agents.iter().map(|a| a.tokens.total).sum();
        s.push_str("Where it went\n");
        s.push_str(&bars(&[
            ("Main thread".into(), d.main.tokens.total, pct(d.main.tokens.total, r.tokens.total)),
            (format!("Helpers ({helpers})"), helper_total, pct(helper_total, r.tokens.total)),
        ]));
        s.push('\n');
    }

    let mut models: Vec<_> = d.by_model.iter().filter(|m| m.tokens.total > 0).collect();
    models.sort_by_key(|m| std::cmp::Reverse(m.tokens.total));
    if !models.is_empty() {
        s.push_str("Models\n");
        let rows: Vec<_> = models.iter().take(top).map(|m| (model(&m.model), m.tokens.total, pct(m.tokens.total, r.tokens.total))).collect();
        s.push_str(&bars(&rows));
        s.push('\n');
    }

    if helpers > 0 {
        let mut agents: Vec<_> = d.agents.iter().collect();
        agents.sort_by_key(|a| std::cmp::Reverse(a.tokens.total));
        s.push_str("| Helper | Type | Model | Tokens |\n|---|---|---|--:|\n");
        for a in agents.iter().take(top) {
            let _ = writeln!(
                s,
                "| {} | {} | {} | {} |",
                cell(&a.name, 40),
                cell(a.agent_type.as_deref().unwrap_or("-"), 24),
                model(&a.model),
                compact(a.tokens.total)
            );
        }
        if agents.len() > top {
            let _ = writeln!(s, "\n_+{} more helpers_", agents.len() - top);
        }
        s.push('\n');
    }

    let activity = activity(d);
    if activity.len() > 1 {
        s.push_str("Activity\n");
        s.push_str(&bars(&activity));
        s.push('\n');
    }
    s.push_str(FOOTER);
    s
}

/// Tokens per local hour (a chat within a day) or per local day (longer), zero-filled.
fn activity(d: &SessionDetail) -> Vec<(String, u64, String)> {
    let pts: Vec<(NaiveDateTime, u64)> = d.timeline.iter().filter_map(|p| local(p.ts).map(|t| (t, p.tokens.total))).collect();
    let (Some(lo), Some(hi)) = (pts.iter().map(|p| p.0).min(), pts.iter().map(|p| p.0).max()) else { return Vec::new() };
    let hourly = (hi - lo) <= Duration::hours(24);
    let key = |t: NaiveDateTime| if hourly { t.date().and_hms_opt(t.hour(), 0, 0).unwrap_or(t) } else { t.date().and_hms_opt(0, 0, 0).unwrap_or(t) };
    let mut sums: BTreeMap<NaiveDateTime, u64> = BTreeMap::new();
    let step = if hourly { Duration::hours(1) } else { Duration::days(1) };
    let mut k = key(lo);
    while k <= key(hi) {
        sums.insert(k, 0);
        k += step;
    }
    for (t, v) in pts {
        *sums.entry(key(t)).or_default() += v;
    }
    let multi_day = lo.date() != hi.date();
    let rows: Vec<_> = sums
        .into_iter()
        .map(|(k, v)| {
            let label = match (hourly, multi_day) {
                (true, false) => k.format("%H:00").to_string(),
                (true, true) => k.format("%a %H:00").to_string(),
                _ => k.format("%a %b %-d").to_string(),
            };
            (label, v, String::new())
        })
        .collect();
    // Keep the most recent month when a chat ran for longer.
    let skip = rows.len().saturating_sub(31);
    rows.into_iter().skip(skip).collect()
}
