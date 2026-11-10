//! Chat-ready replies in Atlas's voice, the short answer: a few plain sentences and at most
//! one small chart. A chart sits in a ```text block so its columns line up in any monospace
//! font, and no chart line is much wider than 40 columns, so nothing scrolls sideways in a
//! chat window.
//!
//! Names follow the app (sessions, helpers, "today"). Tokens are the figure; the one dollar
//! number is the closing line, an estimate at API prices. No filler: every sentence carries a
//! number or a name.

use std::collections::BTreeMap;
use std::fmt::Write as _;

use atlas_core::usage::query::{EffortUse, ScopeReport, SessionDetail, SessionRow, TimelinePoint};
use atlas_core::usage::time::Tz;
use chrono::{Duration, NaiveDate, NaiveDateTime, Timelike};

use crate::fmt::{bar, cell, change, compact, duration, heat, heat_band, heat_cuts, model, plain, summit, usd};
use crate::scope::{BARS_DAYS, Span, short};

/// Bar cells at full scale.
const BAR: usize = 16;
/// Chart labels are cut to this many characters, so label + bar + value stays near 40 columns.
const LABEL: usize = 13;
/// Most names one sentence lists before "and N more".
const NAMED: usize = 3;
/// Most rows one chart draws.
const ROWS: usize = 14;

const MODEL_WORDS: (&str, &str, &str) = ("All on", "Mostly", "Spread over");
const PROJECT_WORDS: (&str, &str, &str) = ("All in", "Most went to", "Spread over");

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

/// Rows of `label  bar  value` inside a ```text block. Labels are cut at LABEL characters and
/// the bar is BAR cells, so a line stays near 40 columns. With `mark_peak` the busiest row
/// carries the summit mark, the app's spark planted on the peak.
fn bars(rows: &[(String, u64)], mark_peak: bool) -> String {
    let rows: Vec<(String, u64)> = rows.iter().map(|(l, v)| (cell(l, LABEL), *v)).collect();
    let max = rows.iter().map(|r| r.1).max().unwrap_or(0);
    let lw = rows.iter().map(|r| r.0.chars().count()).max().unwrap_or(0);
    let vw = rows.iter().map(|r| compact(r.1).len()).max().unwrap_or(0);
    let top = if mark_peak { peak(&rows.iter().map(|r| r.1).collect::<Vec<_>>()) } else { None };
    let mut s = String::from("```text\n");
    for (i, (label, v)) in rows.iter().enumerate() {
        let mut line = format!("{label:<lw$}  {}  {:>vw$}", bar(*v, max, BAR), compact(*v));
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
    let ramp: String = (1..=5).map(heat).collect();
    let mut legend = format!("{} idle  {ramp} busy", heat(0));
    if top.is_some() {
        let _ = write!(legend, "  {} peak", summit());
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

/// "a", "a and b", "a, b and c".
fn and_list(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [a] => a.clone(),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    }
}

/// One named share of a whole: a model or a project, with short notes for its parentheses
/// ("mostly high", "not priced").
struct Share {
    name: String,
    tokens: u64,
    notes: Vec<String>,
}

fn phrase(it: &Share, total: u64, with_pct: bool) -> String {
    let mut parts = Vec::new();
    if with_pct {
        parts.push(pct(it.tokens, total));
    }
    parts.extend(it.notes.iter().cloned());
    if parts.is_empty() { it.name.clone() } else { format!("{} ({})", it.name, parts.join(", ")) }
}

/// One sentence naming the biggest shares, biggest first: "All on X." when there is one,
/// "Mostly X (71%), then Y (29%)." when the first is half or more, else "Spread over X (45%),
/// Y (30%) and Z (25%).". At most `named` names, then "and N more".
fn ranked(words: (&str, &str, &str), items: &[Share], total: u64, named: usize) -> Option<String> {
    let (all, mostly, spread) = words;
    let items: Vec<&Share> = items.iter().filter(|i| i.tokens > 0).collect();
    let first = *items.first()?;
    if items.len() == 1 {
        return Some(format!("{all} {}.", phrase(first, total, false)));
    }
    let named = named.max(1);
    let mut listed: Vec<String> = items.iter().take(named).map(|i| phrase(i, total, true)).collect();
    if items.len() > named {
        listed.push(format!("{} more", items.len() - named));
    }
    if first.tokens.saturating_mul(2) >= total {
        let head = listed.remove(0);
        Some(format!("{mostly} {head}, then {}.", and_list(&listed)))
    } else {
        Some(format!("{spread} {}.", and_list(&listed)))
    }
}

/// The effort as one word or two: a single effort is its name ("high"); a mix is "mostly
/// high" when one effort has half the replies or more, else "mixed effort".
fn effort_word(uses: &[EffortUse]) -> Option<String> {
    let used: Vec<&EffortUse> = uses.iter().filter(|e| e.replies > 0).collect();
    let all: u64 = used.iter().map(|e| e.replies).sum();
    let top = *used.iter().max_by(|a, b| a.replies.cmp(&b.replies).then_with(|| b.effort.cmp(&a.effort)))?;
    Some(if used.len() == 1 {
        plain(&top.effort)
    } else if top.replies * 2 >= all {
        format!("mostly {}", plain(&top.effort))
    } else {
        "mixed effort".into()
    })
}

/// Models under the names the app shows, biggest first. Ids that share a name (a dated and an
/// undated id of the same model) are one share with their tokens and efforts added; a model
/// the price list does not know says "not priced".
fn models<'a>(items: impl Iterator<Item = (&'a str, u64, &'a [EffortUse], bool)>) -> Vec<Share> {
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
    let mut out: Vec<Share> = m
        .into_iter()
        .map(|(name, r)| {
            let uses: Vec<EffortUse> = r.efforts.into_iter().map(|(effort, replies)| EffortUse { effort, replies }).collect();
            let mut notes: Vec<String> = effort_word(&uses).into_iter().collect();
            if r.unpriced {
                notes.push("not priced".into());
            }
            Share { name, tokens: r.tokens, notes }
        })
        .collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.tokens));
    out
}

/// A models chart, only when there are two or more to compare.
fn models_chart(models: &[Share]) -> Option<String> {
    let rows: Vec<(String, u64)> = models.iter().filter(|m| m.tokens > 0).take(5).map(|m| (m.name.clone(), m.tokens)).collect();
    (rows.len() >= 2).then(|| bars(&rows, false))
}

fn bucket_label(start: &str, bucket: &str, today: NaiveDate) -> String {
    let Some(d) = NaiveDate::parse_from_str(start, "%Y-%m-%d").ok() else { return plain(start) };
    match bucket {
        "week" => short(d, today),
        "month" => d.format("%b %Y").to_string(),
        _ if d == today => "Today".to_string(),
        _ => d.format("%a %b %-d").to_string(),
    }
}

fn series(points: &[TimelinePoint], bucket: &str, today: NaiveDate) -> Vec<(String, u64)> {
    points.iter().map(|p| (bucket_label(&p.start, bucket, today), p.tokens.total)).collect()
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

/// A range's name in bold, with its dates unless the name already is them ("Today" gets
/// "(Nov 8)", "Nov 2 - Nov 7" stays as it is).
fn side(s: &Span, today: NaiveDate) -> String {
    let when = dates(s, today);
    if when == s.label { format!("**{}**", plain(&s.label)) } else { format!("**{}** ({when})", plain(&s.label)) }
}

/// The closing line: the one dollar figure, an estimate at API prices.
fn estimate(parts: &[(&str, Option<f64>, bool)]) -> String {
    let priced: Vec<&(&str, Option<f64>, bool)> = parts.iter().filter(|p| p.1.is_some()).collect();
    if priced.is_empty() {
        return "_No API price known for these models._".into();
    }
    if parts.len() == 1 {
        return format!("_Estimated {} at API prices._", usd(parts[0].1, parts[0].2));
    }
    let each: Vec<String> = priced.iter().map(|p| format!("{} for {}", usd(p.1, p.2), cell(p.0, 40))).collect();
    format!("_Estimated {} at API prices._", and_list(&each))
}

/// The range's chart, its busiest-bucket sentence, and a sentence when the chart had to drop
/// older rows. Up to 14 days are bars, 15 to 84 consecutive days the terrain grid, weeks and
/// months bars of the last 14.
fn activity(r: &ScopeReport, today: NaiveDate) -> (Option<String>, Option<String>, Option<String>) {
    if r.points.len() < 2 {
        return (None, None, None);
    }
    let vals: Vec<u64> = r.points.iter().map(|p| p.tokens.total).collect();
    let busiest = peak(&vals).map(|i| {
        let p = &r.points[i];
        let v = compact(p.tokens.total);
        match (r.bucket.as_str(), NaiveDate::parse_from_str(&p.start, "%Y-%m-%d").ok()) {
            ("week", Some(d)) => format!("Busiest week started {} with {v}.", short(d, today)),
            ("month", Some(d)) => format!("Busiest month was {} with {v}.", d.format("%b %Y")),
            (_, Some(d)) if d == today => format!("Busiest day was today with {v}."),
            (_, Some(d)) => format!("Busiest day was {} with {v}.", d.format("%a %b %-d")),
            _ => format!("Busiest was {} with {v}.", plain(&p.start)),
        }
    });
    let dated: Vec<(NaiveDate, u64)> =
        r.points.iter().filter_map(|p| NaiveDate::parse_from_str(&p.start, "%Y-%m-%d").ok().map(|d| (d, p.tokens.total))).collect();
    if r.bucket == "day"
        && r.points.len() as i64 > BARS_DAYS
        && dated.len() == r.points.len()
        && let Some(g) = grid(&dated, today)
    {
        return (Some(g), busiest, None);
    }
    let rows = series(&r.points, &r.bucket, today);
    let skip = rows.len().saturating_sub(ROWS);
    let unit = match r.bucket.as_str() {
        "week" => "weeks",
        "month" => "months",
        _ => "days",
    };
    let cut = (skip > 0).then(|| format!("The chart shows the last {ROWS} {unit}."));
    // A cut chart marks no summit: the busiest bucket may be one it left out.
    (Some(bars(&rows[skip..], skip == 0)), busiest, cut)
}

pub fn range(v: &RangeView) -> String {
    if let Some((cs, cr)) = v.compare {
        return compare(v.span, v.report, cs, cr, v.today, v.project);
    }
    let r = v.report;
    let t = &r.total;
    let mut head = side(v.span, v.today);
    if let Some(p) = v.project {
        let _ = write!(head, " in **{}**", cell(p, 40));
    }
    if t.tokens.total == 0 {
        return format!("{head}\n\nNo Claude Code usage recorded in this range.\n");
    }
    let mut s = format!("{head}: **{} tokens** over {}.", compact(t.tokens.total), sessions(t.sessions));
    let (chart, busiest, cut) = activity(r, v.today);
    if let Some(b) = busiest {
        s.push(' ');
        s.push_str(&b);
    }
    s.push('\n');
    let ms = models(r.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total, m.efforts.as_slice(), m.known)));
    if let Some(c) = chart.or_else(|| models_chart(&ms)) {
        s.push_str(&c);
    }

    let named = v.top.min(NAMED);
    let mut tail: Vec<String> = cut.into_iter().collect();
    tail.extend(ranked(MODEL_WORDS, &ms, t.tokens.total, named));
    if v.project.is_none() && r.projects.len() > 1 {
        // Two folders with the same name are one name in a sentence, never "X, then X".
        let mut by_name: BTreeMap<String, u64> = BTreeMap::new();
        for p in &r.projects {
            *by_name.entry(cell(&p.name, 40)).or_default() += p.tokens.total;
        }
        let mut ps: Vec<Share> = by_name.into_iter().map(|(name, tokens)| Share { name, tokens, notes: Vec::new() }).collect();
        ps.sort_by_key(|p| std::cmp::Reverse(p.tokens));
        tail.extend(ranked(PROJECT_WORDS, &ps, t.tokens.total, named));
    }
    if t.sessions > 1
        && let Some(c) = v.top_chats.first()
    {
        let name = cell(c.name.as_deref().unwrap_or("(untitled)"), 48);
        tail.push(match v.project {
            Some(_) => format!("Biggest session: \"{name}\", {}.", compact(c.tokens.total)),
            None => format!("Biggest session: \"{name}\" in {}, {}.", cell(&c.project_name, 28), compact(c.tokens.total)),
        });
    }
    if !tail.is_empty() {
        s.push_str(&tail.join(" "));
        s.push('\n');
    }
    s.push('\n');
    s.push_str(&estimate(&[("", t.cost.usd, t.cost.complete)]));
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

/// "Biggest model change: Sonnet 4.5, 1k to 500 (-50%)." for the row that moved the most;
/// nothing when nothing moved.
fn biggest_change(kind: &str, rows: &[(String, u64, u64)]) -> Option<String> {
    let (name, x, y) = rows.iter().filter(|r| r.1 != r.2).max_by_key(|r| r.1.abs_diff(r.2))?;
    Some(format!("Biggest {kind} change: {name}, {} to {} ({}).", compact(*x), compact(*y), change(*x, *y)))
}

/// The later range against the earlier one: how it moved in words, two bars (earlier first),
/// then sessions and the biggest changes.
fn compare(a: &Span, ar: &ScopeReport, b: &Span, br: &ScopeReport, today: NaiveDate, project: Option<&str>) -> String {
    let ((e, er), (l, lr)) = if (b.from, b.to) < (a.from, a.to) { ((b, br), (a, ar)) } else { ((a, ar), (b, br)) };
    let (x, y) = (er.total.tokens.total, lr.total.tokens.total);
    let mut s = side(l, today);
    if let Some(p) = project {
        let _ = write!(s, " in **{}**", cell(p, 40));
    }
    let earlier = side(e, today);
    let versus = if x == 0 && y == 0 {
        format!("the same as {earlier}")
    } else if x == 0 {
        format!("against none in {earlier}")
    } else {
        let p = (y as f64 - x as f64) / x as f64 * 100.0;
        let words = if p.abs() < 0.5 {
            "about the same as".to_string()
        } else if p > 0.0 {
            format!("{}% more than", p.round())
        } else {
            format!("{}% less than", (-p).round())
        };
        format!("{words} {earlier} at {}", compact(x))
    };
    let _ = writeln!(s, ": **{} tokens**, {versus}.", compact(y));
    s.push_str(&bars(&[(plain(&e.label), x), (plain(&l.label), y)], false));

    let (sx, sy) = (er.total.sessions, lr.total.sessions);
    let mut tail = vec![if sx == sy { format!("Sessions held at {sy}.") } else { format!("Sessions went from {sx} to {sy}.") }];
    let ms = merged(
        er.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total)),
        lr.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total)),
        model,
    );
    tail.extend(biggest_change("model", &ms));
    if project.is_none() {
        let ps = merged(
            er.projects.iter().map(|p| (p.name.as_str(), p.tokens.total)),
            lr.projects.iter().map(|p| (p.name.as_str(), p.tokens.total)),
            |n| cell(n, 40),
        );
        if ps.len() > 1 {
            tail.extend(biggest_change("project", &ps));
        }
    }
    let _ = writeln!(s, "{}\n", tail.join(" "));
    s.push_str(&estimate(&[(&e.label, er.total.cost.usd, er.total.cost.complete), (&l.label, lr.total.cost.usd, lr.total.cost.complete)]));
    s
}

fn local(ts: i64) -> Option<NaiveDateTime> {
    Tz::Local.local(ts)
}

pub fn chat(d: &SessionDetail, note: Option<&str>, top: usize) -> String {
    let r = &d.row;
    let total = r.tokens.total;
    let mut s = String::new();
    if let Some(n) = note {
        let _ = writeln!(s, "_{}_", plain(n));
    }
    // The chat's name only when the program had to pick the chat itself.
    let who = match (note, r.name.as_deref()) {
        (Some(_), Some(n)) => format!("This chat, \"{}\",", cell(n, 60)),
        _ => "This chat".to_string(),
    };
    let _ = write!(s, "{who} has used **{} tokens** over {}.", compact(total), duration(r.duration_ms));

    let helpers = d.agents.len();
    let helper_total: u64 = d.agents.iter().map(|a| a.tokens.total).sum();
    let main = d.main.tokens.total;
    if helpers > 0 {
        let n = if helpers == 1 { "1 helper".to_string() } else { format!("{helpers} helpers") };
        if helper_total.saturating_mul(2) >= total {
            let _ = write!(s, " {n} did {} of it; the main chat only {}.", pct(helper_total, total), compact(main));
        } else {
            let _ = write!(s, " The main chat did {} of it; {n} used {}.", pct(main, total), compact(helper_total));
        }
    }
    s.push('\n');

    let ms = models(d.by_model.iter().map(|m| (m.model.as_str(), m.tokens.total, m.efforts.as_slice(), m.known)));
    let (act, hourly) = activity_rows(d);
    let chart = if helpers > 0 {
        Some(bars(&[("Main chat".into(), main), ("Helpers".into(), helper_total)], false))
    } else if (2..=ROWS).contains(&act.len()) {
        Some(bars(&act, true))
    } else {
        models_chart(&ms)
    };
    if let Some(c) = chart {
        s.push_str(&c);
    }

    let mut tail: Vec<String> = ranked(MODEL_WORDS, &ms, total, top.min(NAMED)).into_iter().collect();
    if let Some(i) = peak(&act.iter().map(|a| a.1).collect::<Vec<_>>()) {
        tail.push(format!("Busiest {} was {} with {}.", if hourly { "hour" } else { "day" }, act[i].0, compact(act[i].1)));
    }
    if helpers >= 2
        && let Some(big) = d.agents.iter().max_by_key(|a| a.tokens.total)
    {
        tail.push(format!("Biggest helper: {}, {}.", cell(&big.name, 48), compact(big.tokens.total)));
    }
    if !tail.is_empty() {
        s.push_str(&tail.join(" "));
        s.push('\n');
    }
    s.push('\n');
    s.push_str(&estimate(&[("", r.cost.usd, r.cost.complete)]));
    s
}

/// Tokens per local hour (a chat within a day) or per local day (longer), zero-filled, and
/// whether the rows are hours. Hours read "2 pm" ("Mon 2 pm" across midnight), days "Mon Nov 3".
fn activity_rows(d: &SessionDetail) -> (Vec<(String, u64)>, bool) {
    let pts: Vec<(NaiveDateTime, u64)> = d.timeline.iter().filter_map(|p| local(p.ts).map(|t| (t, p.tokens.total))).collect();
    let (Some(lo), Some(hi)) = (pts.iter().map(|p| p.0).min(), pts.iter().map(|p| p.0).max()) else { return (Vec::new(), true) };
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
                (true, false) => k.format("%-I %P").to_string(),
                (true, true) => k.format("%a %-I %P").to_string(),
                _ => k.format("%a %b %-d").to_string(),
            };
            (label, v)
        })
        .collect();
    // Keep the most recent month when a chat ran for longer.
    let skip = rows.len().saturating_sub(31);
    (rows.into_iter().skip(skip).collect(), hourly)
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
        let rows: Vec<_> = [("Mon", 10u64), ("Tue", 0), ("Today", 40)].iter().map(|(l, v)| (l.to_string(), *v)).collect();
        let out = bars(&rows, true);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "```text");
        // label (padded to the widest, 5), two spaces, a BAR-cell bar, two spaces, the value.
        let blank = |n: usize| " ".repeat(n);
        assert_eq!(lines[1], format!("Mon    {}{}  10", "\u{2588}".repeat(4), blank(BAR - 4)), "a quarter of the busiest: {out}");
        assert_eq!(lines[2], format!("Tue    \u{00B7}{}   0", blank(BAR - 1)), "idle day keeps its nub: {out}");
        assert_eq!(lines[3], format!("Today  {}  40  \u{25B2}", "\u{2588}".repeat(BAR)), "the peak fills the bar and carries the summit: {out}");
        assert_eq!(out.matches('\u{25B2}').count(), 1);
    }

    #[test]
    fn a_long_chart_label_is_cut_so_the_line_stays_narrow() {
        let _g = glyph_lock();
        let out = bars(&[("A very long project name indeed".into(), 5), ("b".into(), 1)], false);
        let first = out.lines().nth(1).unwrap();
        assert!(first.starts_with("A very long \u{2026}  "), "{out}");
        assert!(first.chars().count() <= 41, "{out}");
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
        let first: Vec<&str> = lines[1].split_whitespace().skip(2).collect();
        assert_eq!(first.len(), 3, "{g}");
        // The busiest day (40, today) is the summit, once in the grid and once in the legend.
        assert_eq!(g.matches('\u{25B2}').count(), 2, "{g}");
        assert!(lines[2].contains('\u{25B2}'), "{g}");
        assert_eq!(lines[3], "\u{00B7} idle  \u{2582}\u{2583}\u{2585}\u{2586}\u{2588} busy  \u{25B2} peak", "{g}");
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
        assert!(!g.contains("peak"), "{g}");
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
    fn range_is_sentences_one_chart_and_one_estimate() {
        let _g = glyph_lock();
        let (sp, rep) = (span("2026-11-02", TODAY, "This week"), week_report());
        let out = range(&range_of(&sp, &rep, None, 2));
        assert!(
            out.starts_with("**This week** (Nov 2 - Nov 8): **1.4k tokens** over 4 sessions. Busiest day was today with 40.\n```text\n"),
            "{out}"
        );
        assert!(out.lines().any(|l| l.starts_with("Today ") && l.ends_with("40  \u{25B2}")), "a week is bars, today last: {out}");
        // Two Sonnet 4.5 ids are one share (800 of 1400), counted before the limit of 2 names.
        assert!(out.contains("Mostly Sonnet 4.5 (57%), then Opus 5.5 (36%) and 1 more."), "{out}");
        assert!(!out.contains("Haiku"), "{out}");
        assert!(out.contains("Most went to atlas (64%), then other (36%)."), "{out}");
        assert!(out.contains("Biggest session: \"Fix the grid\" in atlas, 700."), "{out}");

        // Two folders that share a name are one name in the sentence.
        let mut twin = week_report();
        twin.projects = vec![project_use("atlas", 700, 2), project_use("other", 500, 1), project_use("atlas", 200, 1)];
        let out = range(&range_of(&sp, &twin, None, 5));
        assert!(out.contains("Most went to atlas (64%), then other (36%)."), "{out}");
        assert!(out.ends_with("\n\n_Estimated $1.23 at API prices._"), "{out}");
        assert_eq!(out.matches('$').count(), 1, "one dollar figure: {out}");
        assert!(!out.contains('|') && !out.contains("cache") && !out.contains('!') && !out.contains("Live"), "{out}");
    }

    #[test]
    fn a_project_range_names_the_project_and_skips_the_project_sentence() {
        let _g = glyph_lock();
        let (sp, rep) = (span("2026-11-02", TODAY, "This week"), week_report());
        let out = range(&range_of(&sp, &rep, Some("atlas"), 5));
        assert!(out.starts_with("**This week** (Nov 2 - Nov 8) in **atlas**: **1.4k tokens** over 4 sessions."), "{out}");
        assert!(!out.contains("Most went to"), "{out}");
        assert!(out.contains("Biggest session: \"Fix the grid\", 700."), "{out}");
        assert!(out.contains("Mostly Sonnet 4.5 (57%), then Opus 5.5 (36%) and Haiku 5.5 (7%)."), "top 5 still names at most 3: {out}");
    }

    #[test]
    fn an_empty_range_says_so() {
        let _g = glyph_lock();
        let sp = span("2026-11-02", TODAY, "This week");
        let mut rep = week_report();
        rep.total.tokens.total = 0; // cache reads stay (5.2M): they are not usage
        let out = range(&range_of(&sp, &rep, None, 5));
        assert_eq!(out, "**This week** (Nov 2 - Nov 8)\n\nNo Claude Code usage recorded in this range.\n");
    }

    #[test]
    fn a_single_day_gets_a_models_chart() {
        let _g = glyph_lock();
        let rep = report("day", points_to(TODAY, &[1400]), &[(SONNET, 800), ("claude-opus-5-5", 600)], vec![], vec![]);
        let sp = span(TODAY, TODAY, "Today");
        let out = range(&range_of(&sp, &rep, None, 5));
        assert!(out.starts_with("**Today** (Nov 8): **1.4k tokens** over 4 sessions.\n```text\nSonnet 4.5  "), "{out}");
        assert!(!out.contains("Busiest"), "{out}");
    }

    /// The rows of the first ```text block, up to the grid legend when there is one.
    fn chart_rows(out: &str) -> Vec<&str> {
        let after = out.split("```text\n").nth(1).expect("a chart");
        after.lines().take_while(|l| !l.starts_with("```") && !l.contains("idle")).collect()
    }

    #[test]
    fn bars_up_to_14_days_and_the_grid_from_15_to_84() {
        let _g = glyph_lock();
        let today = d(TODAY);
        for (n, expect_grid) in [(14usize, false), (15, true), (84, true)] {
            let rep = report("day", points_to(TODAY, &vec![7; n]), &[(SONNET, 700)], vec![], vec![]);
            let sp = span("2026-01-01", TODAY, "A range");
            let out = range(&range_of(&sp, &rep, None, 5));
            assert_eq!(out.contains(" idle "), expect_grid, "{n} days: {out}");
            let rows = chart_rows(&out);
            if expect_grid {
                assert_eq!(rows.len(), n.div_ceil(7), "{n} days: {out}");
                assert!(rows.last().unwrap().ends_with("Today"), "{n} days: today is bottom-right: {out}");
                // Whole weeks have no empty slot; 15 days leaves 6 empty slots in row one.
                let first_cells = rows[0].split_whitespace().skip(2).count();
                assert_eq!(first_cells, if n == 84 { 7 } else { 1 }, "{n} days: {out}");
            } else {
                assert_eq!(rows.len(), n, "{n} bars, a row per day: {out}");
            }
        }
        for n in [15usize, 84] {
            let g = grid(&days("2026-08-01", &vec![3; n]), today).unwrap();
            assert_eq!(g.lines().count(), 2 + n.div_ceil(7) + 1, "fence, rows, legend, fence: {g}");
        }
    }

    #[test]
    fn days_that_are_not_consecutive_get_the_last_14_as_bars() {
        let _g = glyph_lock();
        let mut pts = points_to(TODAY, &[5; 16]);
        pts.remove(6); // 15 points but a missing day: every later cell would sit under the wrong date
        assert_eq!(pts.len(), 15);
        let dated: Vec<(NaiveDate, u64)> = pts.iter().map(|p| (d(&p.start), p.tokens.total)).collect();
        assert!(grid(&dated, d(TODAY)).is_none());
        assert!(grid(&[], d(TODAY)).is_none());
        let rep = report("day", pts, &[(SONNET, 70)], vec![], vec![]);
        let out = range(&range_of(&span("2026-10-25", TODAY, "A range"), &rep, None, 5));
        assert!(!out.contains(" idle "), "{out}");
        assert_eq!(chart_rows(&out).len(), 14, "{out}");
        assert!(out.contains("The chart shows the last 14 days."), "{out}");
    }

    #[test]
    fn weeks_say_when_the_busiest_started() {
        let _g = glyph_lock();
        let pts = vec![point("2026-08-03", 5), point("2026-08-10", 90), point("2026-08-17", 7)];
        let rep = report("week", pts, &[(SONNET, 102)], vec![], vec![]);
        let out = range(&range_of(&span("2026-08-03", "2026-08-23", "A range"), &rep, None, 5));
        assert!(out.contains("Busiest week started Aug 10 with 90."), "{out}");
        assert!(out.lines().any(|l| l.starts_with("Aug 10 ")), "{out}");
    }

    #[test]
    fn compare_says_how_it_moved_then_two_bars_earlier_first() {
        let _g = glyph_lock();
        let yesterday = report("day", points_to("2026-11-07", &[1000]), &[(SONNET, 700), (SONNET_DATED, 300)], vec![], vec![]);
        let mut today = report("day", points_to(TODAY, &[500]), &[(SONNET, 500)], vec![], vec![]);
        today.total.sessions = 2;
        let (a, b) = (span("2026-11-08", TODAY, "Today"), span("2026-11-07", "2026-11-07", "Yesterday"));
        let view = RangeView { compare: Some((&b, &yesterday)), ..range_of(&a, &today, None, 5) };
        let out = range(&view);
        assert!(out.starts_with("**Today** (Nov 8): **500 tokens**, 50% less than **Yesterday** (Nov 7) at 1k.\n```text\n"), "{out}");
        let rows = chart_rows(&out);
        assert!(rows[0].starts_with("Yesterday  ") && rows[0].ends_with("1k"), "{out}");
        assert!(rows[1].starts_with("Today      ") && rows[1].ends_with("500"), "{out}");
        assert!(out.contains("Sessions went from 4 to 2."), "{out}");
        assert!(out.contains("Biggest model change: Sonnet 4.5, 1k to 500 (-50%)."), "ids merged: {out}");
        assert!(out.ends_with("_Estimated $1.23 for Yesterday and $1.23 for Today at API prices._"), "{out}");

        // A range whose label already is its dates is not named twice.
        let (c, e) = (span("2026-11-04", "2026-11-04", "Nov 4"), span("2026-11-03", "2026-11-03", "Nov 3"));
        let view = RangeView { compare: Some((&e, &yesterday)), ..range_of(&c, &today, None, 5) };
        assert!(range(&view).starts_with("**Nov 4**: **500 tokens**, 50% less than **Nov 3** at 1k."), "{}", range(&view));

        // Against an empty range.
        let mut none = report("day", points_to("2026-11-07", &[0]), &[], vec![], vec![]);
        none.total.cost = Cost::default();
        let view = RangeView { compare: Some((&b, &none)), ..range_of(&a, &today, None, 5) };
        let out = range(&view);
        assert!(out.starts_with("**Today** (Nov 8): **500 tokens**, against none in **Yesterday** (Nov 7).\n"), "{out}");
        assert!(out.ends_with("_Estimated $1.23 for Today at API prices._"), "{out}");
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
    fn chat_is_two_short_paragraphs_around_the_main_and_helpers_chart() {
        let _g = glyph_lock();
        let out = chat(&detail("caf\u{e9}", "\u{65e5}\u{672c}\u{8a9e}", "scout|x"), None, 5);
        assert!(out.starts_with("This chat has used **1k tokens** over 1m. The main chat did 70% of it; 1 helper used 300.\n```text\n"), "{out}");
        let rows = chart_rows(&out);
        assert!(rows[0].starts_with("Main chat  ") && rows[0].ends_with("700"), "{out}");
        assert!(rows[1].starts_with("Helpers    ") && rows[1].ends_with("300"), "{out}");
        assert!(out.contains("Mostly Sonnet 4.5 (80%), then Opus 5.5 (20%)."), "ids merged: {out}");
        assert!(out.contains("Busiest hour was ") && out.contains(" with 600."), "{out}");
        assert!(!out.contains("Biggest helper"), "one helper is already named by the sentence: {out}");
        assert!(!out.contains("caf") && !out.contains('|'), "no name without a note, no table: {out}");
        assert!(out.ends_with("\n\n_Estimated $1.00 at API prices._"), "{out}");
    }

    #[test]
    fn helpers_doing_most_of_it_lead_and_the_biggest_is_named() {
        let _g = glyph_lock();
        let mut dt = detail("x", "p", "scout");
        dt.main.tokens = tok(100, 0);
        dt.agents = vec![agent("Build the library tab", 600), agent("Review it", 300)];
        let out = chat(&dt, None, 5);
        assert!(out.contains("2 helpers did 90% of it; the main chat only 100."), "{out}");
        assert!(out.contains("Biggest helper: Build the library tab, 600."), "{out}");
    }

    #[test]
    fn a_chat_without_helpers_charts_its_hours() {
        let _g = glyph_lock();
        let mut dt = detail("x", "p", "scout");
        dt.agents.clear();
        let out = chat(&dt, None, 5);
        assert!(out.starts_with("This chat has used **1k tokens** over 1m.\n```text\n"), "{out}");
        let rows = chart_rows(&out);
        assert_eq!(rows.len(), 3, "three hours: {out}");
        assert!(rows.iter().all(|r| r.contains(" am ") || r.contains(" pm ")), "hours read like 2 pm: {out}");
        assert!(rows.iter().any(|r| r.ends_with("600  \u{25B2}")), "{out}");
    }

    #[test]
    fn a_fallback_chat_keeps_the_note_first_and_names_the_chat() {
        let _g = glyph_lock();
        let out = chat(&detail("Fix the grid", "atlas", "scout"), Some("No session id was given, so this is the newest chat in atlas."), 5);
        assert!(out.starts_with("_No session id was given, so this is the newest chat in atlas._\nThis chat, \"Fix the grid\", has used **1k tokens**"), "{out}");
    }

    #[test]
    fn the_models_sentence_names_effort_and_unpriced_models() {
        let _g = glyph_lock();
        let e = |effort: &str, replies| EffortUse { effort: effort.into(), replies };
        let mut dt = detail("x", "p", "scout");
        dt.by_model[0].efforts = vec![e("medium", 2)];
        dt.by_model[1].efforts = vec![e("high", 5)]; // the dated id: same model, mixes merge
        dt.by_model.push(ByModel { model: "claude-nova-9-1".into(), known: false, tokens: tok(50, 0), cost: Cost::default(), efforts: Vec::new() });
        let out = chat(&dt, None, 5);
        assert!(out.contains("Mostly Sonnet 4.5 (80%, mostly high), then Opus 5.5 (20%) and Nova 9.1 (5%, not priced)."), "{out}");

        dt.by_model = vec![ByModel { efforts: vec![e("high", 3)], ..by_model("claude-opus-5-5", 1000) }];
        assert!(chat(&dt, None, 5).contains("All on Opus 5.5 (high)."), "{}", chat(&dt, None, 5));
        dt.by_model[0].efforts = vec![e("low", 1), e("medium", 1), e("high", 1)];
        assert!(chat(&dt, None, 5).contains("All on Opus 5.5 (mixed effort)."), "{}", chat(&dt, None, 5));

        dt.by_model = vec![by_model("claude-opus-5-5", 400), by_model(SONNET, 350), by_model("claude-haiku-5-5", 250)];
        assert!(chat(&dt, None, 5).contains("Spread over Opus 5.5 (40%), Sonnet 4.5 (35%) and Haiku 5.5 (25%)."), "{}", chat(&dt, None, 5));
    }

    #[test]
    fn a_known_model_with_an_unpriced_reply_keeps_its_name() {
        let _g = glyph_lock();
        let mut dt = detail("x", "p", "scout");
        // e.g. Opus 4.7 in fast mode: known to the price list, no rate for that speed.
        dt.by_model.push(ByModel { model: "claude-opus-4-7".into(), known: true, tokens: tok(50, 0), cost: Cost::default(), efforts: Vec::new() });
        let out = chat(&dt, None, 5);
        assert!(out.contains("Opus 4.7 (5%)"), "{out}");
        assert!(!out.contains("not priced"), "{out}");
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
        let b = bars(&[("Mon".into(), 3), ("Tue".into(), 0), ("A label far too long".into(), 9)], true);
        assert!(g.is_ascii(), "{g}");
        assert!(b.is_ascii() && b.contains("..."), "{b}");

        // Names that come from the user's own data: a title, a project, a model id.
        let (cafe, nihongo, odd_model) = ("caf\u{e9}", "\u{65e5}\u{672c}\u{8a9e}", "claude-fable-\u{e9}-1");
        let mut rep = report("day", points_to(TODAY, &[9; 20]), &[(odd_model, 600), (SONNET, 400)], vec![project_use(nihongo, 600, 2), project_use("b", 400, 1)], vec![row(cafe, nihongo, 700)]);
        rep.points[3].tokens.total = 90;
        let sp = span("2026-10-20", TODAY, "Last 20 days");
        let out = range(&range_of(&sp, &rep, None, 5));
        assert!(out.is_ascii(), "range: {out}");
        assert!(out.contains("\"caf?\" in ???") && out.contains("claude-fable-?-1"), "non-ASCII became ?: {out}");
        let by_project = range(&range_of(&sp, &rep, Some(nihongo), 5));
        assert!(by_project.is_ascii() && by_project.contains(" in **???**"), "{by_project}");

        let view = RangeView { compare: Some((&sp, &rep)), ..range_of(&sp, &rep, None, 5) };
        let versus = range(&view);
        assert!(versus.is_ascii(), "compare: {versus}");

        let mut dt = detail(cafe, nihongo, "h\u{e9}lper");
        dt.by_model.push(by_model(odd_model, 100));
        dt.agents.push(agent("other", 10));
        let note = format!("newest chat in {nihongo}.");
        let c = chat(&dt, Some(&note), 5);
        assert!(c.is_ascii(), "chat: {c}");
        assert!(c.contains("\"caf?\"") && c.contains("claude-fable-?-1") && c.contains("Biggest helper: h?lper") && c.contains("_newest chat in ???._"), "{c}");
    }

    #[test]
    fn the_estimate_line_is_an_estimate_at_api_prices() {
        assert_eq!(estimate(&[("", Some(2.02), true)]), "_Estimated $2.02 at API prices._");
        assert_eq!(estimate(&[("", Some(2.02), false)]), "_Estimated $2.02+ at API prices._");
        assert_eq!(estimate(&[("", None, true)]), "_No API price known for these models._");
        assert_eq!(
            estimate(&[("Last week", Some(9.0), true), ("This week", Some(2.02), false)]),
            "_Estimated $9.00 for Last week and $2.02+ for This week at API prices._"
        );
    }

    #[test]
    fn every_chart_line_fits_a_chat_window_and_nothing_says_bill() {
        let _g = glyph_lock();
        let today = report("day", points_to(TODAY, &[500]), &[(SONNET, 500)], vec![], vec![]);
        let long = report("day", points_to(TODAY, &[9; 30]), &[(SONNET, 600), ("claude-opus-5-5", 400)], vec![project_use("atlas", 600, 2), project_use("b", 400, 1)], vec![row("x", "atlas", 700)]);
        let (wk, mo) = (span("2026-11-02", TODAY, "Last 30 days with a long name"), span("2026-10-10", TODAY, "Last 30 days"));
        let (sp_wk, rep_wk) = (span("2026-11-02", TODAY, "This week"), week_report());
        let mut no_helpers = detail("x", "p", "scout");
        no_helpers.agents.clear();
        let outs = [
            range(&range_of(&sp_wk, &rep_wk, None, 5)),
            range(&range_of(&mo, &long, None, 5)),
            range(&RangeView { compare: Some((&wk, &today)), ..range_of(&mo, &long, None, 5) }),
            chat(&detail("x", "p", "scout"), None, 5),
            chat(&no_helpers, None, 5),
        ];
        for out in &outs {
            let mut inside = false;
            for line in out.lines() {
                if line.starts_with("```") {
                    inside = !inside;
                } else if inside {
                    assert!(line.chars().count() <= 41, "{} columns: {line}\n{out}", line.chars().count());
                }
            }
            assert!(!out.to_lowercase().contains("bill"), "{out}");
            assert_eq!(out.matches("```text").count(), 1, "one chart: {out}");
        }
    }

    #[test]
    fn labels_say_today_and_skip_the_year_when_it_is_this_one() {
        let t = d("2026-11-08");
        assert_eq!(bucket_label("2026-11-08", "day", t), "Today");
        assert_eq!(bucket_label("2026-11-07", "day", t), "Sat Nov 7");
        assert_eq!(bucket_label("2026-08-09", "week", t), "Aug 9");
        assert_eq!(bucket_label("2025-12-28", "week", t), "Dec 28 2025");
        assert_eq!(bucket_label("2026-03-01", "month", t), "Mar 2026");
        assert_eq!(t.year(), 2026);
    }
}
