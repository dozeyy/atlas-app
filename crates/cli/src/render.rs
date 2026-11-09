//! Chat-ready markdown in Atlas's voice: a headline, then the app's own chart shapes drawn
//! in text (bars, and the terrain grid for 15 days to 12 weeks) inside ```text blocks so
//! columns line up in any monospace font, and a few short tables.
//!
//! Names follow the app (Sessions, Models, Projects, Activity, Helpers, "Today"). Tokens are
//! the figure; the one dollar number is the closing estimate line, always called an
//! estimate. No filler sentences: the numbers and the chart are the answer.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use atlas_core::usage::query::{ScopeReport, SessionDetail, SessionRow, TimelinePoint};
use atlas_core::usage::time::Tz;
use chrono::{Duration, NaiveDate, NaiveDateTime, Timelike};

use crate::fmt::{bar, cell, change, compact, dot, duration, heat, heat_band, heat_cuts, model, summit, usd};
use crate::scope::{BARS_DAYS, Span, short};

const BAR: usize = 24;

/// Index of the busiest row, only when it is a clear peak: three or more rows and one
/// strict maximum above zero. A tie has no summit.
fn peak(values: &[u64]) -> Option<usize> {
    if values.len() < 3 {
        return None;
    }
    let max = *values.iter().max()?;
    if max == 0 || values.iter().filter(|v| **v == max).count() != 1 {
        return None;
    }
    values.iter().position(|v| *v == max)
}

/// Rows of `label  bar  value [extra]` inside a ```text block. With `mark_peak` the busiest
/// row carries the summit mark, the app's spark planted on the peak.
fn bars(rows: &[(String, u64, String)], mark_peak: bool) -> String {
    let max = rows.iter().map(|r| r.1).max().unwrap_or(0);
    let lw = rows.iter().map(|r| r.0.chars().count()).max().unwrap_or(0);
    let vw = rows.iter().map(|r| compact(r.1).len()).max().unwrap_or(0);
    let top = if mark_peak { peak(&rows.iter().map(|r| r.1).collect::<Vec<_>>()) } else { None };
    let mut s = String::from("```text\n");
    for (i, (label, v, extra)) in rows.iter().enumerate() {
        let mut line = format!("{label:<lw$}  {}  {:>vw$}", bar(*v, max, BAR), compact(*v));
        if !extra.is_empty() {
            let _ = write!(line, "  {extra}");
        }
        if top == Some(i) {
            let _ = write!(line, "  {}", summit());
        }
        let _ = writeln!(s, "{}", line.trim_end());
    }
    s.push_str("```\n");
    s
}

/// The terrain grid: one cell per day, seven days a row, oldest first, the last cell the
/// last day of the range (labelled "Today" when it is). Cells climb in five bands cut at the
/// app's quantiles; the busiest day is the summit mark. Empty slots sit top-left.
fn grid(days: &[(NaiveDate, u64)], today: NaiveDate) -> String {
    let n = days.len();
    let pad = (7 - n % 7) % 7;
    let vals: Vec<u64> = days.iter().map(|d| d.1).collect();
    let cuts = heat_cuts(&vals);
    let top = peak(&vals);
    let rows = (n + pad) / 7;
    let labels: Vec<String> = (0..rows).map(|r| short(days[(r * 7).saturating_sub(pad)].0, today)).collect();
    let lw = labels.iter().map(|l| l.chars().count()).max().unwrap_or(0);
    let mut s = String::from("```text\n");
    for (r, label) in labels.iter().enumerate() {
        let cells: Vec<String> = (r * 7..r * 7 + 7)
            .map(|slot| match slot.checked_sub(pad) {
                None => " ".to_string(),
                Some(i) if top == Some(i) => summit().to_string(),
                Some(i) => heat(heat_band(vals[i], &cuts)).to_string(),
            })
            .collect();
        let mut line = format!("{label:<lw$}  {}", cells.join(" "));
        if r + 1 == rows {
            let last = days[n - 1].0;
            let _ = write!(line, "  {}", if last == today { "Today".to_string() } else { short(last, today) });
        }
        let _ = writeln!(s, "{}", line.trim_end());
    }
    let ramp: Vec<String> = (1..=5).map(|b| heat(b).to_string()).collect();
    let mut legend = format!("{} idle  {} busier", heat(0), ramp.join(" "));
    if let Some(i) = top {
        let _ = write!(legend, "  {} busiest day, {}: {}", summit(), days[i].0.format("%a %b %-d"), compact(days[i].1));
    }
    let _ = writeln!(s, "{legend}");
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

fn sessions(n: u64) -> String {
    if n == 1 { "1 session".into() } else { format!("{n} sessions") }
}

fn bucket_label(start: &str, bucket: &str, today: NaiveDate) -> String {
    let Some(d) = NaiveDate::parse_from_str(start, "%Y-%m-%d").ok() else { return start.to_string() };
    match bucket {
        "week" => format!("Wk of {}", short(d, today)),
        "month" => d.format("%b %Y").to_string(),
        _ if d == today => "Today".to_string(),
        _ => d.format("%a %b %-d").to_string(),
    }
}

fn series(points: &[TimelinePoint], bucket: &str, today: NaiveDate) -> Vec<(String, u64, String)> {
    points.iter().map(|p| (bucket_label(&p.start, bucket, today), p.tokens.total, String::new())).collect()
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

/// The closing line: the one dollar figure, called an estimate, never a bill.
fn estimate(parts: &[(&str, Option<f64>, bool)]) -> String {
    let priced: Vec<String> = parts
        .iter()
        .filter(|p| p.1.is_some())
        .map(|p| if parts.len() > 1 { format!("{} {}", p.0, usd(p.1, p.2)) } else { usd(p.1, p.2) })
        .collect();
    if priced.is_empty() {
        return "_No API price known for these models._".into();
    }
    if parts.len() > 1 {
        format!("_Estimated at API prices, not a bill: {}._", priced.join(", "))
    } else {
        format!("_Estimated at API prices: {}. Not a bill._", priced.join(", "))
    }
}

fn activity(r: &ScopeReport, today: NaiveDate) -> String {
    let days = r.points.len() as i64;
    let dated: Vec<(NaiveDate, u64)> =
        r.points.iter().filter_map(|p| NaiveDate::parse_from_str(&p.start, "%Y-%m-%d").ok().map(|d| (d, p.tokens.total))).collect();
    if r.bucket == "day" && days > BARS_DAYS && dated.len() == r.points.len() {
        let mut s = format!("Activity{}7 days a row\n", dot());
        s.push_str(&grid(&dated, today));
        s.push('\n');
        return s;
    }
    let mut s = String::from("Activity\n");
    s.push_str(&bars(&series(&r.points, &r.bucket, today), true));
    s.push('\n');
    s
}

pub fn range(v: &RangeView) -> String {
    let r = v.report;
    let t = &r.total;
    let mut s = String::new();
    let where_ = v.project.map(|p| format!("project **{}**", cell(p, 40))).unwrap_or_else(|| "all projects".into());

    if let Some((cs, cr)) = v.compare {
        s.push_str(&compare(v.span, r, cs, cr, v.today, v.project, v.top));
        return s;
    }

    let when = dates(v.span, v.today);
    if when == v.span.label {
        let _ = writeln!(s, "**{}**{}{}", v.span.label, dot(), where_);
    } else {
        let _ = writeln!(s, "**{}**{}{}{}{}", v.span.label, dot(), when, dot(), where_);
    }
    let _ = writeln!(s, "**{} tokens** plus {} cache reads{}{}\n", compact(t.tokens.total), compact(t.tokens.cache_read), dot(), sessions(t.sessions));

    if t.tokens.total == 0 {
        s.push_str("No Claude Code usage recorded in this range.\n");
        return s;
    }

    if r.points.len() > 1 {
        s.push_str(&activity(r, v.today));
    }

    s.push_str("Models\n");
    let rows: Vec<_> = r
        .by_model
        .iter()
        .filter(|m| m.tokens.total > 0)
        .take(v.top)
        .map(|m| (model(&m.model), m.tokens.total, pct(m.tokens.total, t.tokens.total)))
        .collect();
    s.push_str(&bars(&rows, false));
    s.push('\n');

    if v.project.is_none() && r.projects.len() > 1 {
        s.push_str("| Project | Tokens | Sessions |\n|---|--:|--:|\n");
        for p in r.projects.iter().take(v.top) {
            let _ = writeln!(s, "| {} | {} | {} |", cell(&p.name, 40), compact(p.tokens.total), p.sessions);
        }
        s.push('\n');
    }

    if !v.top_chats.is_empty() {
        if v.project.is_some() {
            s.push_str("| Biggest sessions | Tokens |\n|---|--:|\n");
        } else {
            s.push_str("| Biggest sessions | Project | Tokens |\n|---|---|--:|\n");
        }
        for c in v.top_chats {
            let name = cell(c.name.as_deref().unwrap_or("(untitled)"), 48);
            if v.project.is_some() {
                let _ = writeln!(s, "| {} | {} |", name, compact(c.tokens.total));
            } else {
                let _ = writeln!(s, "| {} | {} | {} |", name, cell(&c.project_name, 28), compact(c.tokens.total));
            }
        }
        s.push('\n');
    }
    s.push_str(&estimate(&[("", t.cost.usd, t.cost.complete)]));
    s
}

/// Tokens by name for two ranges side by side, biggest combined first.
fn pair_table(head: &str, e: &str, l: &str, rows: Vec<(String, u64, u64)>, top: usize) -> String {
    let mut rows: Vec<_> = rows.into_iter().filter(|r| r.1 > 0 || r.2 > 0).collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.1 + r.2));
    let mut s = format!("| {head} | {e} | {l} | Change |\n|---|--:|--:|--:|\n");
    for (name, x, y) in rows.into_iter().take(top) {
        let _ = writeln!(s, "| {} | {} | {} | {} |", cell(&name, 40), compact(x), compact(y), change(x, y));
    }
    s.push('\n');
    s
}

fn merged<'a>(early: impl Iterator<Item = (&'a str, u64)>, late: impl Iterator<Item = (&'a str, u64)>, name: impl Fn(&str) -> String) -> Vec<(String, u64, u64)> {
    let mut m: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    for (k, v) in early {
        m.entry(name(k)).or_default().0 += v;
    }
    for (k, v) in late {
        m.entry(name(k)).or_default().1 += v;
    }
    m.into_iter().map(|(k, (x, y))| (k, x, y)).collect()
}

/// Earlier range is the baseline; the change column is the later range against it. Only the
/// comparison is shown: the single-range lists would belong to one side and mislead.
fn compare(a: &Span, ar: &ScopeReport, b: &Span, br: &ScopeReport, today: NaiveDate, project: Option<&str>, top: usize) -> String {
    let ((e, er), (l, lr)) = if (b.from, b.to) < (a.from, a.to) { ((b, br), (a, ar)) } else { ((a, ar), (b, br)) };
    let mut s = format!("**{}** ({}) vs **{}** ({})", l.label, dates(l, today), e.label, dates(e, today));
    if let Some(p) = project {
        let _ = write!(s, "{}project **{}**", dot(), cell(p, 40));
    }
    s.push_str("\n\n");
    let rows: [(&str, String, String, String); 3] = [
        ("Tokens", compact(er.total.tokens.total), compact(lr.total.tokens.total), change(er.total.tokens.total, lr.total.tokens.total)),
        ("Cache reads", compact(er.total.tokens.cache_read), compact(lr.total.tokens.cache_read), change(er.total.tokens.cache_read, lr.total.tokens.cache_read)),
        ("Sessions", er.total.sessions.to_string(), lr.total.sessions.to_string(), change(er.total.sessions, lr.total.sessions)),
    ];
    let _ = writeln!(s, "| | {} | {} | Change |\n|---|--:|--:|--:|", e.label, l.label);
    for (k, x, y, c) in rows {
        let _ = writeln!(s, "| {k} | {x} | {y} | {c} |");
    }
    s.push('\n');

    if er.total.tokens.total + lr.total.tokens.total > 0 {
        let models = merged(
            er.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total)),
            lr.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total)),
            model,
        );
        s.push_str(&pair_table("Model", &e.label, &l.label, models, top));
        if project.is_none() {
            let projects = merged(
                er.projects.iter().map(|p| (p.name.as_str(), p.tokens.total)),
                lr.projects.iter().map(|p| (p.name.as_str(), p.tokens.total)),
                |n| n.to_string(),
            );
            if projects.len() > 1 {
                s.push_str(&pair_table("Project", &e.label, &l.label, projects, top));
            }
        }
    }

    let n = er.points.len();
    if er.bucket == "day" && lr.bucket == "day" && n == lr.points.len() && n > 1 && n as i64 <= BARS_DAYS {
        s.push_str("Day by day\n");
        let mut rows = Vec::new();
        for (p, q) in lr.points.iter().zip(&er.points) {
            rows.push((bucket_label(&p.start, "day", today), p.tokens.total, String::new()));
            rows.push((bucket_label(&q.start, "day", today), q.tokens.total, String::new()));
        }
        s.push_str(&bars(&rows, false));
        s.push('\n');
    }
    s.push_str(&estimate(&[(&e.label, er.total.cost.usd, er.total.cost.complete), (&l.label, lr.total.cost.usd, lr.total.cost.complete)]));
    s
}

fn local(ts: i64) -> Option<NaiveDateTime> {
    Tz::Local.local(ts)
}

pub fn chat(d: &SessionDetail, note: Option<&str>, top: usize) -> String {
    let r = &d.row;
    let mut s = String::new();
    let _ = writeln!(s, "**This chat**{}**{} tokens** plus {} cache reads", dot(), compact(r.tokens.total), compact(r.tokens.cache_read));
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
    let _ = writeln!(s, "{}", meta.join(dot()));
    if let Some(n) = note {
        let _ = writeln!(s, "_{n}_");
    }
    s.push('\n');

    if helpers > 0 {
        let helper_total: u64 = d.agents.iter().map(|a| a.tokens.total).sum();
        s.push_str("Where it went\n");
        s.push_str(&bars(
            &[
                ("Main chat".into(), d.main.tokens.total, pct(d.main.tokens.total, r.tokens.total)),
                (format!("Helpers ({helpers})"), helper_total, pct(helper_total, r.tokens.total)),
            ],
            false,
        ));
        s.push('\n');
    }

    let mut models: Vec<_> = d.by_model.iter().filter(|m| m.tokens.total > 0).collect();
    models.sort_by_key(|m| std::cmp::Reverse(m.tokens.total));
    if !models.is_empty() {
        s.push_str("Models\n");
        let rows: Vec<_> = models.iter().take(top).map(|m| (model(&m.model), m.tokens.total, pct(m.tokens.total, r.tokens.total))).collect();
        s.push_str(&bars(&rows, false));
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

    let activity = activity_rows(d);
    if activity.len() > 1 {
        s.push_str("Activity\n");
        s.push_str(&bars(&activity, true));
        s.push('\n');
    }
    s.push_str(&estimate(&[("", r.cost.usd, r.cost.complete)]));
    s
}

/// Tokens per local hour (a chat within a day) or per local day (longer), zero-filled.
fn activity_rows(d: &SessionDetail) -> Vec<(String, u64, String)> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fmt::{glyph_lock, set_ascii};
    use chrono::Datelike;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn days(from: &str, vals: &[u64]) -> Vec<(NaiveDate, u64)> {
        let start = d(from);
        vals.iter().enumerate().map(|(i, v)| (start + Duration::days(i as i64), *v)).collect()
    }

    #[test]
    fn the_summit_needs_a_clear_peak() {
        assert_eq!(peak(&[1, 5, 2]), Some(1));
        assert_eq!(peak(&[5, 5, 2]), None);
        assert_eq!(peak(&[0, 0, 0]), None);
        assert_eq!(peak(&[1, 9]), None);
    }

    #[test]
    fn bars_mark_the_busiest_row_and_never_pass_the_baseline() {
        let _g = glyph_lock();
        let rows: Vec<_> = [("Mon", 10u64), ("Tue", 0), ("Today", 40)].iter().map(|(l, v)| (l.to_string(), *v, String::new())).collect();
        let out = bars(&rows, true);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "```text");
        assert!(lines[1].starts_with("Mon  "), "{out}");
        assert!(lines[2].contains('\u{00B7}'), "idle day keeps its nub: {out}");
        assert!(lines[3].ends_with("  40  \u{25B2}") || lines[3].ends_with("40  \u{25B2}"), "{out}");
        assert_eq!(out.matches('\u{25B2}').count(), 1);
        // Every row is the same width up to the value column.
        let widths: Vec<usize> = lines[1..4].iter().map(|l| l.chars().take(5 + 2 + BAR).count()).collect();
        assert!(widths.iter().all(|w| *w == widths[0]));
    }

    #[test]
    fn the_grid_ends_today_bottom_right_with_empty_slots_top_left() {
        let _g = glyph_lock();
        // 10 days: two rows, the first with 4 empty slots; today is the last day.
        let g = grid(&days("2026-10-30", &[0, 5, 9, 2, 0, 0, 7, 1, 3, 40]), d("2026-11-08"));
        let lines: Vec<&str> = g.lines().collect();
        assert_eq!(lines[0], "```text");
        assert!(lines[1].starts_with("Oct 30"), "first row is labelled by its first real day: {g}");
        assert!(lines[2].starts_with("Nov 2"), "{g}");
        assert!(lines[2].ends_with("Today"), "{g}");
        // The first row has three real cells (Oct 30, 31, Nov 1... = 10 - 7 = 3 in row one).
        let first: Vec<&str> = lines[1].split_whitespace().skip(2).collect();
        assert_eq!(first.len(), 3, "{g}");
        // The busiest day (40, today) is the summit, once, and is in the last row.
        assert_eq!(g.matches('\u{25B2}').count(), 2, "one in the grid, one in the legend: {g}");
        assert!(lines[2].contains('\u{25B2}'), "{g}");
        assert!(g.contains("busiest day, Sun Nov 8: 40"), "{g}");
        assert!(g.contains("idle") && g.contains("busier"), "{g}");
        // Only block glyphs, dots, spaces, digits and letters: no row is wider than 7 cells.
        assert!(lines[2].chars().filter(|c| "\u{00B7}\u{2582}\u{2583}\u{2585}\u{2586}\u{2588}\u{25B2}".contains(*c)).count() == 7);
    }

    #[test]
    fn a_grid_of_whole_weeks_has_no_padding_and_a_dated_last_cell() {
        let _g = glyph_lock();
        let g = grid(&days("2026-10-05", &[1; 14]), d("2026-11-08"));
        let lines: Vec<&str> = g.lines().collect();
        assert!(lines[1].starts_with("Oct 5"), "{g}");
        assert!(lines[2].starts_with("Oct 12"), "{g}");
        assert!(lines[2].ends_with("Oct 18"), "range ended in the past, so the last cell shows its date: {g}");
        assert_eq!(g.matches('\u{25B2}').count(), 0, "a flat range has no summit");
    }

    #[test]
    fn ascii_output_is_ascii() {
        let _g = glyph_lock();
        set_ascii(true);
        let g = grid(&days("2026-10-30", &[0, 5, 9, 2, 0, 0, 7, 1, 3, 40]), d("2026-11-08"));
        let b = bars(&[("Mon".into(), 3, String::new()), ("Tue".into(), 0, String::new()), ("Wed".into(), 9, String::new())], true);
        set_ascii(false);
        assert!(g.is_ascii(), "{g}");
        assert!(b.is_ascii(), "{b}");
    }

    #[test]
    fn the_estimate_line_is_always_an_estimate() {
        assert_eq!(estimate(&[("", Some(2.02), true)]), "_Estimated at API prices: $2.02. Not a bill._");
        assert_eq!(estimate(&[("", None, true)]), "_No API price known for these models._");
        assert_eq!(
            estimate(&[("Last week", Some(9.0), true), ("This week", Some(2.02), false)]),
            "_Estimated at API prices, not a bill: Last week $9.00, This week $2.02+._"
        );
    }

    #[test]
    fn labels_say_today_and_skip_the_year_when_it_is_this_one() {
        let t = d("2026-11-08");
        assert_eq!(bucket_label("2026-11-08", "day", t), "Today");
        assert_eq!(bucket_label("2026-11-07", "day", t), "Sat Nov 7");
        assert_eq!(bucket_label("2026-08-09", "week", t), "Wk of Aug 9");
        assert_eq!(bucket_label("2025-12-28", "week", t), "Wk of Dec 28 2025");
        assert_eq!(bucket_label("2026-03-01", "month", t), "Mar 2026");
        assert_eq!(t.year(), 2026);
    }
}
