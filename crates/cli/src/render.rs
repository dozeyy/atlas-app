//! Chat-ready markdown in Atlas's voice: a headline, then the app's own chart shapes drawn
//! in text (bars, and the terrain grid for 15 days to 12 weeks) inside ```text blocks so
//! columns line up in any monospace font, and a few short tables.
//!
//! Names follow the app (Sessions, Models, Projects, Activity, Helpers, "Today"). Tokens are
//! the figure; the one dollar number is the closing estimate line, always called an
//! estimate. No filler sentences: the numbers and the chart are the answer.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use atlas_core::usage::query::{EffortUse, ScopeReport, SessionDetail, SessionRow, TimelinePoint, effort_rank};
use atlas_core::usage::time::Tz;
use chrono::{Duration, NaiveDate, NaiveDateTime, Timelike};

use crate::fmt::{bar, cell, change, compact, dot, duration, effort_mix, heat, heat_band, heat_cuts, model, plain, summit, usd};
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
/// app's quantiles; the busiest day is the summit mark. Empty slots sit top-left. `None` when
/// the days are not consecutive (a cell would then sit under the wrong date): the caller
/// draws bars instead.
fn grid(days: &[(NaiveDate, u64)], today: NaiveDate) -> Option<String> {
    let n = days.len();
    if n == 0 || days.windows(2).any(|w| w[1].0 - w[0].0 != Duration::days(1)) {
        return None;
    }
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
    Some(s)
}

fn pct(part: u64, whole: u64) -> String {
    if whole == 0 {
        return "0%".into();
    }
    crate::fmt::share_text(part as f64 / whole as f64 * 100.0)
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

/// Models under the names the app shows. Ids that share a name (a dated and an undated id of
/// the same model) are one row with their tokens added, biggest first; this runs before any
/// row limit so the limit counts rows as displayed.
///
/// Each row's label is the full model name, then its most used reasoning effort when the
/// transcripts gave one ("Opus 5.5 · high"), then "(not priced)" for a model the price list
/// does not know.
fn by_label<'a>(items: impl Iterator<Item = (&'a str, u64, &'a [EffortUse], bool)>) -> Vec<(String, u64)> {
    #[derive(Default)]
    struct Row {
        tokens: u64,
        efforts: BTreeMap<String, u64>,
        unpriced: bool,
    }
    let mut m: BTreeMap<String, Row> = BTreeMap::new();
    for (id, tokens, efforts, priced) in items.filter(|i| i.1 > 0) {
        let r = m.entry(model(id)).or_default();
        r.tokens += tokens;
        r.unpriced |= !priced;
        for e in efforts {
            *r.efforts.entry(e.effort.clone()).or_default() += e.replies;
        }
    }
    let mut rows: Vec<(String, u64)> = m
        .into_iter()
        .map(|(name, r)| {
            let top = r.efforts.iter().max_by(|a, b| a.1.cmp(b.1).then_with(|| effort_rank(b.0).cmp(&effort_rank(a.0)))).map(|e| e.0.clone());
            let mut label = name;
            if let Some(e) = top {
                label = format!("{label}{}{e}", dot());
            }
            if r.unpriced {
                label.push_str(" (not priced)");
            }
            (label, r.tokens)
        })
        .collect();
    rows.sort_by_key(|r| std::cmp::Reverse(r.1));
    rows
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
    if r.bucket == "day"
        && days > BARS_DAYS
        && dated.len() == r.points.len()
        && let Some(g) = grid(&dated, today)
    {
        return format!("Activity{}7 days per row\n{g}\n", dot());
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
    if t.tokens.total == 0 {
        s.push_str("\nNo Claude Code usage recorded in this range.\n");
        return s;
    }
    let _ = writeln!(s, "**{} tokens** plus {} cache reads{}{}\n", compact(t.tokens.total), compact(t.tokens.cache_read), dot(), sessions(t.sessions));

    if r.points.len() > 1 {
        s.push_str(&activity(r, v.today));
    }

    s.push_str("Models\n");
    let rows: Vec<_> = by_label(r.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total, m.efforts.as_slice(), m.known)))
        .into_iter()
        .take(v.top)
        .map(|(label, tokens)| (label, tokens, pct(tokens, t.tokens.total)))
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

/// A range's name in the compare headline, with its dates unless the name already is them
/// ("Today", "Nov 2 - Nov 7").
fn side(s: &Span, today: NaiveDate) -> String {
    let when = dates(s, today);
    if when == s.label { format!("**{}**", s.label) } else { format!("**{}** ({when})", s.label) }
}

/// Earlier range is the baseline; the change column is the later range against it. Only the
/// comparison is shown: the single-range lists would belong to one side and mislead.
fn compare(a: &Span, ar: &ScopeReport, b: &Span, br: &ScopeReport, today: NaiveDate, project: Option<&str>, top: usize) -> String {
    let ((e, er), (l, lr)) = if (b.from, b.to) < (a.from, a.to) { ((b, br), (a, ar)) } else { ((a, ar), (b, br)) };
    let mut s = format!("{} vs {}", side(l, today), side(e, today));
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
    if !r.main_model.is_empty() {
        let mix = effort_mix(&r.efforts);
        meta.push(if mix.is_empty() { model(&r.main_model) } else { format!("{}{}{}", model(&r.main_model), dot(), mix) });
    }
    meta.push(duration(r.duration_ms));
    meta.push(format!("{} messages", r.messages));
    let helpers = d.agents.len();
    meta.push(format!("{helpers} helper{}", if helpers == 1 { "" } else { "s" }));
    let _ = writeln!(s, "{}", meta.join(dot()));
    if let Some(n) = note {
        let _ = writeln!(s, "_{}_", plain(n));
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

    let models = by_label(d.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total, m.efforts.as_slice(), m.known)));
    if !models.is_empty() {
        s.push_str("Models\n");
        let rows: Vec<_> = models.into_iter().take(top).map(|(label, tokens)| (label, tokens, pct(tokens, r.tokens.total))).collect();
        s.push_str(&bars(&rows, false));
        s.push('\n');
    }

    if helpers > 0 {
        let mut agents: Vec<_> = d.agents.iter().collect();
        agents.sort_by_key(|a| std::cmp::Reverse(a.tokens.total));
        s.push_str("| Helper | Type | Model | Effort | Tokens |\n|---|---|---|---|--:|\n");
        for a in agents.iter().take(top) {
            let mix = effort_mix(&a.efforts);
            let _ = writeln!(
                s,
                "| {} | {} | {} | {} | {} |",
                cell(&a.name, 40),
                cell(a.agent_type.as_deref().unwrap_or("-"), 24),
                model(&a.model),
                if mix.is_empty() { "-" } else { mix.as_str() },
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
    use atlas_core::usage::query::{AgentSummary, ByModel, Cost, MainThread, MessagePoint, ModelUse, Period, ProjectUse, Tokens};
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
        // label (padded to the widest, 5), two spaces, a BAR-cell bar, two spaces, the value.
        let blank = |n: usize| " ".repeat(n);
        assert_eq!(lines[1], format!("Mon    {}{}  10", "\u{2588}".repeat(6), blank(BAR - 6)), "a quarter of the busiest: {out}");
        assert_eq!(lines[2], format!("Tue    \u{00B7}{}   0", blank(BAR - 1)), "idle day keeps its nub: {out}");
        assert_eq!(lines[3], format!("Today  {}  40  \u{25B2}", "\u{2588}".repeat(BAR)), "the peak fills the bar and carries the summit: {out}");
        assert_eq!(out.matches('\u{25B2}').count(), 1);
    }

    #[test]
    fn the_grid_ends_today_bottom_right_with_empty_slots_top_left() {
        let _g = glyph_lock();
        // 10 days: two rows, the first with 4 empty slots; today is the last day.
        let g = grid(&days("2026-10-30", &[0, 5, 9, 2, 0, 0, 7, 1, 3, 40]), d("2026-11-08")).unwrap();
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
        let g = grid(&days("2026-10-05", &[1; 14]), d("2026-11-08")).unwrap();
        let lines: Vec<&str> = g.lines().collect();
        assert!(lines[1].starts_with("Oct 5"), "{g}");
        assert!(lines[2].starts_with("Oct 12"), "{g}");
        assert!(lines[2].ends_with("Oct 18"), "range ended in the past, so the last cell shows its date: {g}");
        assert_eq!(g.matches('\u{25B2}').count(), 0, "a flat range has no summit");
    }

    /// Whole fixtures for the three views, built the way the engine builds them.
    fn tok(total: u64, cache_read: u64) -> Tokens {
        Tokens { input: total, total, cache_read, ..Tokens::default() }
    }

    fn priced(v: f64) -> Cost {
        Cost { usd: Some(v), complete: true, unpriced_tokens: 0 }
    }

    fn point(start: &str, total: u64) -> TimelinePoint {
        TimelinePoint { start: start.into(), tokens: tok(total, 0), cost: Cost::default(), sessions: 1 }
    }

    /// One point per day, consecutive, the last one on `last`.
    fn points_to(last: &str, vals: &[u64]) -> Vec<TimelinePoint> {
        let first = d(last) - Duration::days(vals.len() as i64 - 1);
        vals.iter().enumerate().map(|(i, v)| point(&(first + Duration::days(i as i64)).format("%Y-%m-%d").to_string(), *v)).collect()
    }

    fn model_use(id: &str, total: u64) -> ModelUse {
        ModelUse { model: id.into(), known: true, tokens: tok(total, 0), cost: Cost::default(), efforts: Vec::new() }
    }

    fn project_use(name: &str, total: u64, sessions: u64) -> ProjectUse {
        ProjectUse { project_key: name.into(), name: name.into(), path: String::new(), tokens: tok(total, 0), cost: Cost::default(), sessions }
    }

    fn row(name: &str, project: &str, total: u64) -> SessionRow {
        SessionRow {
            session_id: "s1".into(),
            title: None,
            name: Some(name.into()),
            name_source: "title".into(),
            agent_count: 0,
            project_name: project.into(),
            project_path: String::new(),
            started_at: 0,
            ended_at: 0,
            duration_ms: 90_000,
            models: Vec::new(),
            main_model: String::new(),
            efforts: Vec::new(),
            messages: 12,
            subagent_messages: 0,
            tokens: tok(total, 0),
            cost: priced(1.0),
            missing: false,
        }
    }

    /// A range report whose total is the sum of its models.
    fn report(bucket: &str, points: Vec<TimelinePoint>, models: &[(&str, u64)], projects: Vec<ProjectUse>, chats: Vec<SessionRow>) -> ScopeReport {
        let total: u64 = models.iter().map(|m| m.1).sum();
        ScopeReport {
            from: String::new(),
            to: String::new(),
            bucket: bucket.into(),
            total: Period { tokens: tok(total, 5_200_000), cost: priced(1.23), sessions: 4 },
            by_model: models.iter().map(|m| model_use(m.0, m.1)).collect(),
            points,
            projects,
            chats,
        }
    }

    fn span(from: &str, to: &str, label: &str) -> Span {
        Span { from: d(from), to: d(to), label: label.into() }
    }

    const SONNET: &str = "claude-sonnet-4-5";
    const SONNET_DATED: &str = "claude-sonnet-4-5-20250929";
    const TODAY: &str = "2026-11-08";

    fn week_report() -> ScopeReport {
        report(
            "day",
            points_to(TODAY, &[10, 20, 0, 30, 5, 15, 40]),
            &[(SONNET, 600), (SONNET_DATED, 200), ("claude-opus-5-5", 500), ("claude-haiku-5-5", 100)],
            vec![project_use("atlas", 900, 3), project_use("other", 500, 1)],
            vec![row("Fix the grid", "atlas", 700)],
        )
    }

    fn range_of<'a>(span: &'a Span, rep: &'a ScopeReport, project: Option<&'a str>, top: usize) -> RangeView<'a> {
        RangeView { span, today: d(TODAY), report: rep, project, top_chats: &rep.chats, compare: None, top }
    }

    #[test]
    fn range_reads_tokens_first_merges_model_ids_and_ends_on_one_estimate() {
        let _g = glyph_lock();
        let (sp, rep) = (span("2026-11-02", TODAY, "This week"), week_report());
        let out = range(&range_of(&sp, &rep, None, 2));
        assert!(out.starts_with("**This week** \u{00B7} Nov 2 - Nov 8 \u{00B7} all projects\n**1.4k tokens** plus 5.2M cache reads \u{00B7} 4 sessions\n"), "{out}");
        assert!(out.contains("Activity\n```text\n"), "a week is bars: {out}");
        assert!(!out.contains("7 days per row"), "{out}");
        // Two Sonnet 4.5 ids are one row (800 of 1400), counted before the row limit of 2.
        assert_eq!(out.matches("Sonnet 4.5").count(), 1, "{out}");
        assert!(out.lines().any(|l| l.starts_with("Sonnet 4.5") && l.contains("800") && l.ends_with("57%")), "{out}");
        assert!(out.contains("Opus 5.5"), "the second row survives the merge: {out}");
        assert!(!out.contains("Haiku 5.5"), "the third is cut by the limit: {out}");
        assert!(out.contains("| Project | Tokens | Sessions |\n|---|--:|--:|\n| atlas | 900 | 3 |\n"), "{out}");
        assert!(out.contains("| Biggest sessions | Project | Tokens |\n|---|---|--:|\n| Fix the grid | atlas | 700 |\n"), "{out}");
        assert!(out.ends_with("_Estimated at API prices: $1.23. Not a bill._"), "{out}");
        assert_eq!(out.matches('$').count(), 1, "one dollar figure: {out}");
        assert!(!out.contains('!') && !out.contains("Live"), "{out}");
    }

    #[test]
    fn a_project_range_drops_the_project_table_and_column() {
        let _g = glyph_lock();
        let (sp, rep) = (span("2026-11-02", TODAY, "This week"), week_report());
        let out = range(&range_of(&sp, &rep, Some("atlas"), 5));
        assert!(out.starts_with("**This week** \u{00B7} Nov 2 - Nov 8 \u{00B7} project **atlas**\n"), "{out}");
        assert!(!out.contains("| Project |"), "{out}");
        assert!(out.contains("| Biggest sessions | Tokens |\n|---|--:|\n| Fix the grid | 700 |\n"), "{out}");
    }

    #[test]
    fn an_empty_range_says_so_and_shows_no_token_line() {
        let _g = glyph_lock();
        let sp = span("2026-11-02", TODAY, "This week");
        let mut rep = week_report();
        rep.total.tokens.total = 0; // cache reads stay (5.2M): they are not usage
        let out = range(&range_of(&sp, &rep, None, 5));
        assert_eq!(out, "**This week** \u{00B7} Nov 2 - Nov 8 \u{00B7} all projects\n\nNo Claude Code usage recorded in this range.\n");
    }

    /// The lines of the first ```text block after `marker`, up to the legend.
    fn grid_rows<'a>(out: &'a str, marker: &str) -> Vec<&'a str> {
        let after = out.split(marker).nth(1).expect(marker);
        after.lines().skip(2).take_while(|l| !l.contains("idle")).collect()
    }

    #[test]
    fn bars_up_to_14_days_and_the_grid_from_15_to_84() {
        let _g = glyph_lock();
        let today = d(TODAY);
        for (n, expect_grid) in [(14usize, false), (15, true), (84, true)] {
            let rep = report("day", points_to(TODAY, &vec![7; n]), &[(SONNET, 700)], vec![], vec![]);
            let sp = span("2026-01-01", TODAY, "A range");
            let out = range(&range_of(&sp, &rep, None, 5));
            assert_eq!(out.contains("Activity \u{00B7} 7 days per row\n```text\n"), expect_grid, "{n} days: {out}");
            if expect_grid {
                let rows = grid_rows(&out, "7 days per row");
                assert_eq!(rows.len(), n.div_ceil(7), "{n} days: {out}");
                assert!(rows.last().unwrap().ends_with("Today"), "{n} days: today is bottom-right: {out}");
                // Whole weeks have no empty slot; 15 days leaves 6 empty slots in row one.
                let first_cells = rows[0].split_whitespace().skip(2).count();
                assert_eq!(first_cells, if n == 84 { 7 } else { 1 }, "{n} days: {out}");
            } else {
                assert!(out.contains("Activity\n```text\n"), "{n} days: {out}");
                assert_eq!(out.lines().filter(|l| l.ends_with("  7")).count(), n, "{n} bars, a row per day: {out}");
            }
        }
        // The same at the grid's edges when drawn directly.
        for n in [15usize, 84] {
            let g = grid(&days("2026-08-01", &vec![3; n]), today).unwrap();
            assert_eq!(g.lines().count(), 2 + n.div_ceil(7) + 1, "fence, rows, legend, fence: {g}");
        }
    }

    #[test]
    fn days_that_are_not_consecutive_get_bars_not_a_misleading_grid() {
        let _g = glyph_lock();
        let mut pts = points_to(TODAY, &[5; 16]);
        pts.remove(6); // 15 points but a missing day: every later cell would sit under the wrong date
        assert_eq!(pts.len(), 15);
        let dated: Vec<(NaiveDate, u64)> = pts.iter().map(|p| (d(&p.start), p.tokens.total)).collect();
        assert!(grid(&dated, d(TODAY)).is_none());
        assert!(grid(&[], d(TODAY)).is_none());
        let rep = report("day", pts, &[(SONNET, 70)], vec![], vec![]);
        let out = range(&range_of(&span("2026-10-25", TODAY, "A range"), &rep, None, 5));
        assert!(!out.contains("7 days per row"), "{out}");
        assert!(out.contains("Activity\n```text\n"), "{out}");
    }

    #[test]
    fn compare_names_each_side_once_and_merges_model_ids() {
        let _g = glyph_lock();
        let yesterday = report("day", points_to("2026-11-07", &[1000]), &[(SONNET, 700), (SONNET_DATED, 300)], vec![], vec![]);
        let mut today = report("day", points_to(TODAY, &[500]), &[(SONNET, 500)], vec![], vec![]);
        today.total.sessions = 2;
        let (a, b) = (span("2026-11-08", TODAY, "Today"), span("2026-11-07", "2026-11-07", "Yesterday"));
        let view = RangeView { compare: Some((&b, &yesterday)), ..range_of(&a, &today, None, 5) };
        let out = range(&view);
        assert!(out.starts_with("**Today** (Nov 8) vs **Yesterday** (Nov 7)\n\n"), "{out}");
        assert!(out.contains("| | Yesterday | Today | Change |\n|---|--:|--:|--:|\n| Tokens | 1k | 500 | -50% |\n"), "{out}");
        assert_eq!(out.matches("| Sonnet 4.5 |").count(), 1, "{out}");
        assert!(out.contains("| Sonnet 4.5 | 1k | 500 | -50% |"), "{out}");
        assert!(!out.contains("Day by day"), "one day each has no day-by-day: {out}");
        assert!(out.ends_with("_Estimated at API prices, not a bill: Yesterday $1.23, Today $1.23._"), "{out}");

        // A range whose label already is its dates is not named twice.
        let (c, e) = (span("2026-11-04", "2026-11-04", "Nov 4"), span("2026-11-03", "2026-11-03", "Nov 3"));
        let view = RangeView { compare: Some((&e, &yesterday)), ..range_of(&c, &today, None, 5) };
        assert!(range(&view).starts_with("**Nov 4** vs **Nov 3**\n\n"), "{}", range(&view));
    }

    fn agent(name: &str, total: u64) -> AgentSummary {
        AgentSummary {
            agent_id: "a1".into(),
            name: name.into(),
            name_source: "description".into(),
            agent_type: Some("Explore".into()),
            description: None,
            tool_use_id: None,
            parent_agent_id: None,
            spawn_depth: 1,
            model: SONNET.into(),
            models: vec![SONNET.into()],
            efforts: Vec::new(),
            messages: 4,
            tokens: tok(total, 0),
            cost: priced(0.5),
            started_at: 0,
            ended_at: 0,
            duration_ms: 1000,
            tool_calls: 2,
            missing: false,
        }
    }

    fn by_model(id: &str, total: u64) -> ByModel {
        ByModel { model: id.into(), known: true, tokens: tok(total, 0), cost: priced(0.5), efforts: Vec::new() }
    }

    fn message(ts: i64, total: u64) -> MessagePoint {
        MessagePoint { ts, model: SONNET.into(), agent_id: None, tokens: tok(total, 0), cost: priced(0.1), skill: None }
    }

    fn detail(name: &str, project: &str, helper: &str) -> SessionDetail {
        const HOUR: i64 = 3_600_000;
        SessionDetail {
            row: row(name, project, 1000),
            by_model: vec![by_model(SONNET, 500), by_model(SONNET_DATED, 300), by_model("claude-opus-5-5", 200)],
            by_agent: Vec::new(),
            agents: vec![agent(helper, 300)],
            main: MainThread { messages: 8, tokens: tok(700, 0), cost: priced(0.5), tool_calls: 3 },
            timeline: vec![message(1_700_000_000_000, 400), message(1_700_000_000_000 + 2 * HOUR, 600)],
            files: Vec::new(),
            claude_code_cost_usd: None,
        }
    }

    #[test]
    fn chat_splits_main_from_helpers_and_merges_model_ids() {
        let _g = glyph_lock();
        let out = chat(&detail("caf\u{e9}", "\u{65e5}\u{672c}\u{8a9e}", "scout|x"), None, 5);
        assert!(out.starts_with("**This chat** \u{00B7} **1k tokens** plus 0 cache reads\n\"caf\u{e9}\" \u{00B7} \u{65e5}\u{672c}\u{8a9e} \u{00B7} "), "{out}");
        assert!(out.contains("12 messages \u{00B7} 1 helper\n"), "{out}");
        assert!(out.lines().any(|l| l.starts_with("Main chat") && l.ends_with("700  70%")), "{out}");
        assert!(out.lines().any(|l| l.starts_with("Helpers (1)") && l.ends_with("300  30%")), "{out}");
        assert_eq!(out.matches("Sonnet 4.5").count(), 2, "one model row, one helper row: {out}");
        assert!(out.lines().any(|l| l.starts_with("Sonnet 4.5") && l.contains("800") && l.ends_with("80%")), "{out}");
        assert!(
            out.contains("| Helper | Type | Model | Effort | Tokens |\n|---|---|---|---|--:|\n| scout x | Explore | Sonnet 4.5 | - | 300 |\n"),
            "pipes never break a table; no effort recorded shows a dash, not a guess: {out}"
        );
        assert!(out.contains("Activity\n```text\n"), "three hours: {out}");
        assert!(out.ends_with("_Estimated at API prices: $1.00. Not a bill._"), "{out}");
    }

    #[test]
    fn chat_names_the_model_with_its_effort_and_flags_unpriced_models() {
        let _g = glyph_lock();
        let e = |effort: &str, replies| EffortUse { effort: effort.into(), replies };
        let mut dt = detail("x", "p", "scout");
        dt.row.main_model = "claude-opus-5-5".into();
        dt.row.efforts = vec![e("high", 9), e("medium", 1)];
        dt.by_model[0].efforts = vec![e("medium", 2)];
        dt.by_model[1].efforts = vec![e("high", 5)]; // the dated id: same row, mixes merge
        dt.by_model.push(ByModel { model: "claude-nova-9-1".into(), known: false, tokens: tok(50, 0), cost: Cost::default(), efforts: Vec::new() });
        dt.agents[0].efforts = vec![e("xhigh", 4)];
        let out = chat(&dt, None, 5);
        assert!(out.contains("\"x\" \u{00B7} p \u{00B7} Opus 5.5 \u{00B7} high 90%, medium 10% \u{00B7} "), "{out}");
        assert!(out.lines().any(|l| l.starts_with("Sonnet 4.5 \u{00B7} high ")), "merged mix picks high: {out}");
        assert!(out.lines().any(|l| l.starts_with("Opus 5.5 ") && !l.contains("\u{00B7} ")), "no effort, no suffix: {out}");
        assert!(out.lines().any(|l| l.starts_with("Nova 9.1 (not priced)")), "{out}");
        assert!(out.contains("| scout | Explore | Sonnet 4.5 | xhigh | 300 |"), "{out}");
    }

    #[test]
    fn a_known_model_with_an_unpriced_reply_keeps_its_name() {
        let _g = glyph_lock();
        let mut dt = detail("x", "p", "scout");
        // e.g. Opus 4.7 in fast mode: known to the price list, no rate for that speed.
        dt.by_model.push(ByModel { model: "claude-opus-4-7".into(), known: true, tokens: tok(50, 0), cost: Cost::default(), efforts: Vec::new() });
        let out = chat(&dt, None, 5);
        assert!(out.lines().any(|l| l.starts_with("Opus 4.7 ")), "{out}");
        assert!(!out.contains("Opus 4.7 (not priced)"), "{out}");
    }

    /// Switches ASCII mode on and puts it back even when an assert fails.
    struct AsciiOn;

    impl AsciiOn {
        fn new() -> Self {
            set_ascii(true);
            AsciiOn
        }
    }

    impl Drop for AsciiOn {
        fn drop(&mut self) {
            set_ascii(false);
        }
    }

    #[test]
    fn ascii_output_is_ascii() {
        let _g = glyph_lock();
        let _on = AsciiOn::new();
        let g = grid(&days("2026-10-30", &[0, 5, 9, 2, 0, 0, 7, 1, 3, 40]), d(TODAY)).unwrap();
        let b = bars(&[("Mon".into(), 3, String::new()), ("Tue".into(), 0, String::new()), ("Wed".into(), 9, String::new())], true);
        assert!(g.is_ascii(), "{g}");
        assert!(b.is_ascii(), "{b}");

        // Names that come from the user's own data: a title, a project, a model id.
        let (cafe, nihongo, odd_model) = ("caf\u{e9}", "\u{65e5}\u{672c}\u{8a9e}", "claude-fable-\u{e9}-1");
        let mut rep = report("day", points_to(TODAY, &[9; 20]), &[(odd_model, 600), (SONNET, 400)], vec![project_use(nihongo, 600, 2), project_use("b", 400, 1)], vec![row(cafe, nihongo, 700)]);
        rep.points[3].tokens.total = 90;
        let sp = span("2026-10-20", TODAY, "Last 20 days");
        let out = range(&range_of(&sp, &rep, None, 5));
        assert!(out.is_ascii(), "range: {out}");
        assert!(out.contains("| caf? | ???") && out.contains("claude-fable-?-1"), "non-ASCII became ?: {out}");
        let by_project = range(&range_of(&sp, &rep, Some(nihongo), 5));
        assert!(by_project.is_ascii() && by_project.contains("project **???**"), "{by_project}");

        let view = RangeView { compare: Some((&sp, &rep)), ..range_of(&sp, &rep, None, 5) };
        let versus = range(&view);
        assert!(versus.is_ascii() && versus.contains("claude-fable-?-1"), "compare: {versus}");

        let mut dt = detail(cafe, nihongo, "h\u{e9}lper");
        dt.by_model.push(by_model(odd_model, 100));
        dt.agents[0].agent_type = Some("\u{65e5}".into());
        dt.agents[0].model = odd_model.into();
        let note = format!("newest chat in {nihongo}.");
        let c = chat(&dt, Some(&note), 5);
        assert!(c.is_ascii(), "chat: {c}");
        assert!(c.contains("\"caf?\"") && c.contains("| h?lper | ? | claude-fable-?-1 |") && c.contains("_newest chat in ???._"), "{c}");
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
