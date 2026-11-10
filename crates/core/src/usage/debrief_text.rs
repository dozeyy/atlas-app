//! The after-run debrief as text (`docs/specs/agent-scorecard.md` D60-D62): the facts of one chat's
//! helpers ([`RunDebrief`]) as short `Label: facts` lines. Atlas supplies facts, never a format:
//! no headings, tables, emoji or box drawing, so the model can fold them into whatever report
//! the user's own style asks for.
//!
//! One renderer for every reader: the `atlas-usage debrief` command and the MCP tool
//! `get_run_debrief` both call [`render`], so they print the same bytes for the same facts.
//!
//! Default (low) is at most [`LOW_LINES`] lines and [`LOW_CHARS`] characters; high adds one line
//! per helper and stays within [`HIGH_LINES`] / [`HIGH_CHARS`]. Both limits hold by construction
//! (every list and every piece of text is capped) and are enforced at the end by dropping the
//! least important lines first. Dollars are left out unless asked for.

use std::collections::BTreeMap;

use super::scorecard::{DebriefHelper, RunDebrief};

pub const LOW_LINES: usize = 10;
pub const LOW_CHARS: usize = 900;
pub const HIGH_LINES: usize = 40;
pub const HIGH_CHARS: usize = 3000;

/// Room kept for the "- and N more helpers" line.
const MORE_LINE_CHARS: usize = 32;

#[derive(Debug, Clone, Copy, Default)]
pub struct Options {
    /// One line per helper too.
    pub high: bool,
    /// Add "about $X at API prices, an estimate" to the Tokens line.
    pub cost: bool,
}

/// `--since` / `since`: an ISO time (`2026-11-09T14:00:00Z`, any RFC 3339 offset), or epoch
/// milliseconds (epoch seconds are accepted too), or a day (`2026-11-09`, midnight UTC).
pub fn parse_since(s: &str) -> Result<i64, String> {
    let t = s.trim();
    if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) {
        let n: i64 = t.parse().map_err(|_| "since: that number is too large".to_string())?;
        return Ok(if n < 100_000_000_000 { n.saturating_mul(1000) } else { n });
    }
    if let Some(ms) = super::time::parse_iso_ms(t) {
        return Ok(ms);
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(t, "%Y-%m-%d") {
        return Ok(d.and_hms_opt(0, 0, 0).map_or(0, |dt| dt.and_utc().timestamp_millis()));
    }
    Err("since: use an ISO time such as 2026-11-09T14:00:00Z, a day such as 2026-11-09, or epoch milliseconds".into())
}

/// The whole text, no trailing newline.
pub fn render(d: &RunDebrief, o: &Options) -> String {
    // (name, text); the name decides what is dropped first when the text is too long.
    let mut lines: Vec<(&'static str, String)> = vec![("Ran", format!("Ran: {}", duration(d.wall_ms))), ("Helpers", helpers_line(d))];
    if !d.helpers.is_empty() {
        lines.extend(models_line(&d.helpers).map(|t| ("Models", t)));
        lines.extend(reviews_line(d).map(|t| ("Reviews", t)));
    }
    lines.push(("Tokens", tokens_line(d, o.cost)));
    if !d.helpers.is_empty() {
        lines.extend(biggest_line(d).map(|t| ("Biggest", t)));
        lines.extend(open_line(d).map(|t| ("Open", t)));
        lines.extend(changed_line(d).map(|t| ("Changed", t)));
    }
    lines.extend(caught_line(d).map(|t| ("Caught", t)));

    let (max_lines, max_chars) = if o.high { (HIGH_LINES, HIGH_CHARS) } else { (LOW_LINES, LOW_CHARS) };
    let mut extra: Vec<String> = Vec::new();
    if o.high {
        extra = d.helpers.iter().map(helper_line).collect();
        let base_chars: usize = lines.iter().map(|(_, t)| t.chars().count() + 1).sum();
        // How many helper lines fit beside the base lines, with room for "and N more" when some do not.
        let fits = |k: usize, more: bool| {
            let n = lines.len() + k + usize::from(more);
            let chars = base_chars + extra[..k].iter().map(|l| l.chars().count() + 1).sum::<usize>() + if more { MORE_LINE_CHARS } else { 0 };
            n <= max_lines && chars <= max_chars
        };
        let keep = if fits(extra.len(), false) { extra.len() } else { (0..extra.len()).rev().find(|k| fits(*k, true)).unwrap_or(0) };
        if keep < extra.len() {
            let left = extra.len() - keep;
            extra.truncate(keep);
            extra.push(format!("- and {left} more {}", plural(left, "helper", "helpers")));
        }
    }

    let size = |lines: &[(&'static str, String)], extra: &[String]| {
        let chars: usize = lines.iter().map(|(_, t)| t.chars().count()).chain(extra.iter().map(|t| t.chars().count())).sum();
        (lines.len() + extra.len(), chars + lines.len() + extra.len() - 1)
    };
    // Least important first. Ran, Helpers and Tokens are never dropped.
    for drop in ["Changed", "Caught", "Open", "Biggest", "Models", "Reviews"] {
        let (n, c) = size(&lines, &extra);
        if n <= max_lines && c <= max_chars {
            break;
        }
        lines.retain(|(name, _)| *name != drop);
    }

    let mut out: Vec<String> = lines.into_iter().map(|(_, t)| t).collect();
    out.extend(extra);
    let mut text = out.join("\n");
    if text.chars().count() > max_chars {
        text = text.chars().take(max_chars - 3).collect::<String>() + "...";
    }
    text
}

// ---------------------------------------------------------------- lines

/// Types by helper count, most first, then by name.
fn count_types<'a>(helpers: impl Iterator<Item = &'a DebriefHelper>) -> Vec<(&'a str, usize)> {
    let mut by_type: BTreeMap<&str, usize> = BTreeMap::new();
    for h in helpers {
        *by_type.entry(h.agent_type.as_str()).or_default() += 1;
    }
    let mut types: Vec<(&str, usize)> = by_type.into_iter().collect();
    types.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
    types
}

fn helpers_line(d: &RunDebrief) -> String {
    if d.helpers.is_empty() {
        return "Helpers: none".into();
    }
    let types = count_types(d.helpers.iter());
    let mut parts: Vec<String> = types.iter().take(3).map(|(t, n)| format!("{} {n}", clean(t, 24))).collect();
    if types.len() > 3 {
        parts.push(format!("{} more types", types.len() - 3));
    }
    let mut ends: Vec<String> = Vec::new();
    for (count, word) in [(d.ends.finished, "finished"), (d.ends.errored, "errored"), (d.ends.stopped, "stopped"), (d.ends.unknown, "no end seen")] {
        if count > 0 {
            ends.push(format!("{count} {word}"));
        }
    }
    format!("Helpers: {} ({}): {}.", d.helpers.len(), parts.join(", "), ends.join(", "))
}

fn models_line(helpers: &[DebriefHelper]) -> Option<String> {
    let mut by: BTreeMap<(String, String), usize> = BTreeMap::new();
    for h in helpers {
        if let Some(m) = &h.model {
            *by.entry((m.model_name.clone(), m.effort.clone().unwrap_or_default())).or_default() += 1;
        }
    }
    if by.is_empty() {
        return None;
    }
    let mut v: Vec<((String, String), usize)> = by.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let name = |(m, e): &(String, String)| if e.is_empty() { clean(m, 24) } else { format!("{} {}", clean(m, 24), clean(e, 12)) };
    let mut parts: Vec<String> = v.iter().take(3).map(|(k, n)| format!("{} ({n})", name(k))).collect();
    if v.len() > 3 {
        parts.push(format!("and {} more", v.len() - 3));
    }
    Some(format!("Models: {}", parts.join(", ")))
}

fn reviews_line(d: &RunDebrief) -> Option<String> {
    let r = &d.reviews;
    let mut parts: Vec<String> = Vec::new();
    if r.passed > 0 {
        parts.push(format!("{} passed", r.passed));
    }
    if r.findings > 0 {
        parts.push(format!("{} asked for changes", r.findings));
    }
    if r.sent_back > 0 {
        parts.push(format!("{} {} sent back", r.sent_back, plural(r.sent_back as usize, "worker", "workers")));
    }
    if r.other > 0 {
        parts.push(format!("{} partial or other", r.other));
    }
    if r.no_verdict > 0 {
        parts.push(format!("{} no verdict", r.no_verdict));
    }
    (!parts.is_empty()).then(|| format!("Reviews: {}", parts.join(", ")))
}

fn tokens_line(d: &RunDebrief, cost: bool) -> String {
    let mut s = format!("Tokens: {}", compact(d.tokens.total));
    if cost && let Some(usd) = d.cost.usd {
        s.push_str(&format!(", about {}{} at API prices (an estimate)", money(usd), if d.cost.complete { "" } else { "+" }));
    }
    s
}

fn biggest_line(d: &RunDebrief) -> Option<String> {
    let b = d.biggest.as_ref()?;
    let who = if b.agent_id.is_empty() {
        "the chat itself".to_string()
    } else {
        let h = d.helpers.iter().find(|h| h.agent_id == b.agent_id);
        let kind = b.agent_type.as_deref().or(h.map(|h| h.agent_type.as_str())).map_or("a helper".to_string(), |t| clean(t, 24));
        match h.and_then(|h| h.goal.as_deref()) {
            Some(g) => format!("{kind} \"{}\"", clean(g, 40)),
            None => kind,
        }
    };
    let pct = b.share * 100.0;
    let share = if pct < 0.5 { "under 1%".to_string() } else { format!("{}%", pct.round() as u64) };
    Some(format!("Biggest: {who}, {share} of the tokens ({})", compact(b.tokens)))
}

fn open_line(d: &RunDebrief) -> Option<String> {
    if d.open.is_empty() {
        return None;
    }
    let types = count_types(d.open.iter());
    let mut names: Vec<String> = types.iter().take(3).map(|(t, c)| if *c > 1 { format!("{} {c}", clean(t, 24)) } else { clean(t, 24) }).collect();
    if types.len() > 3 {
        names.push(format!("{} more types", types.len() - 3));
    }
    Some(format!("Open: {} with no end seen (still running, or it stopped writing): {}", d.open.len(), names.join(", ")))
}

fn changed_line(d: &RunDebrief) -> Option<String> {
    let mut branches: Vec<&str> = d.helpers.iter().filter_map(|h| h.worktree_branch.as_deref()).collect();
    branches.sort_unstable();
    branches.dedup();
    if branches.is_empty() {
        return None;
    }
    let mut names: Vec<String> = branches.iter().take(3).map(|b| clean(b, 36)).collect();
    if branches.len() > 3 {
        names.push(format!("{} more", branches.len() - 3));
    }
    Some(format!("Changed: {} worktree {}: {}", branches.len(), plural(branches.len(), "branch", "branches"), names.join(", ")))
}

fn caught_line(d: &RunDebrief) -> Option<String> {
    if d.caught.is_empty() {
        return None;
    }
    let parts: Vec<String> = d
        .caught
        .iter()
        .take(2)
        .map(|t| format!("\"{}\" ({} findings, {} runs)", clean(&t.label, 70).replace('"', "'"), t.count, t.runs))
        .collect();
    Some(format!("Caught: {}", parts.join("; ")))
}

/// High detail: one helper.
fn helper_line(h: &DebriefHelper) -> String {
    let mut s = format!("- {}", clean(&h.agent_type, 24));
    if let Some(g) = &h.goal {
        s.push_str(&format!(" \"{}\"", clean(g, 48).replace('"', "'")));
    }
    s.push_str(match h.end_status.as_deref() {
        Some("finished") => ": finished",
        Some("errored") => ": errored",
        Some("stopped") => ": stopped",
        _ => ": no end seen",
    });
    let word = h.verdict_word.as_deref().map(|w| clean(w, 16));
    match (h.verdict.as_deref(), word) {
        (Some("pass"), _) => s.push_str(", passed"),
        (Some("findings"), Some(w)) => s.push_str(&format!(", asked for changes ({w})")),
        (Some("findings"), None) => s.push_str(", asked for changes"),
        (Some("partial"), _) => s.push_str(", partial"),
        (Some(_), Some(w)) => s.push_str(&format!(", verdict {w}")),
        _ => {}
    }
    s.push_str(&format!(", {} tokens, {}", compact(h.tokens), duration(h.duration_ms)));
    if let Some(m) = &h.model {
        s.push_str(", ");
        s.push_str(&clean(&m.model_name, 24));
        if let Some(e) = &m.effort {
            s.push(' ');
            s.push_str(&clean(e, 12));
        }
    }
    s
}

// ---------------------------------------------------------------- small formats

fn plural<'a>(n: usize, one: &'a str, many: &'a str) -> &'a str {
    if n == 1 { one } else { many }
}

/// One line, no pipes or control characters, at most `max` characters.
fn clean(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '|' || c.is_control() { ' ' } else { c }).collect();
    let flat = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        flat.chars().take(max.saturating_sub(3)).collect::<String>() + "..."
    }
}

/// 3 significant digits with a unit: 950, 7.3k, 56.1M, 108M.
fn compact(n: u64) -> String {
    if n < 1000 {
        return n.to_string();
    }
    const UNITS: [(&str, f64); 4] = [("k", 1e3), ("M", 1e6), ("B", 1e9), ("T", 1e12)];
    let mut i = 0;
    while i + 1 < UNITS.len() && n as f64 >= UNITS[i + 1].1 {
        i += 1;
    }
    loop {
        let v = n as f64 / UNITS[i].1;
        let decimals = if v < 10.0 { 2 } else if v < 100.0 { 1 } else { 0 };
        let s = format!("{v:.decimals$}");
        let rounded: f64 = s.parse().unwrap_or(v);
        if rounded >= 1000.0 && i + 1 < UNITS.len() {
            i += 1;
            continue;
        }
        let s = if s.contains('.') { s.trim_end_matches('0').trim_end_matches('.').to_string() } else { s };
        return format!("{s}{}", UNITS[i].0);
    }
}

fn duration(ms: i64) -> String {
    let s = (ms.max(0) / 1000) as u64;
    let (d, h, m) = (s / 86_400, (s / 3600) % 24, (s / 60) % 60);
    if d > 0 {
        format!("{d}d {h}h")
    } else if h > 0 {
        format!("{h}h {m}m")
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{s}s")
    }
}

fn money(v: f64) -> String {
    if v <= 0.0 {
        "$0.00".into()
    } else if v < 0.005 {
        "<$0.01".into()
    } else if v < 100.0 {
        format!("${v:.2}")
    } else {
        let whole = format!("{v:.0}");
        let mut out = String::new();
        for (i, c) in whole.chars().enumerate() {
            if i > 0 && (whole.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        format!("${out}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::query::{Cost, Tokens};
    use crate::usage::scorecard::{Biggest, DebriefReviews, EndCounts, ModelUse, Theme};

    fn helper(n: usize, t: &str) -> DebriefHelper {
        DebriefHelper {
            agent_id: format!("a{n:016x}"),
            agent_type: t.into(),
            started: 1_000 * n as i64,
            duration_ms: 125_000,
            tool_calls: 10,
            end_status: Some("finished".into()),
            verdict: None,
            verdict_word: None,
            tokens: 12_345,
            model: Some(ModelUse { model: "claude-sonnet-5-5".into(), model_name: "Sonnet 5.5".into(), effort: Some("high".into()), messages: 3, runs: 1 }),
            goal: Some(format!("goal number {n}")),
            worktree_branch: None,
        }
    }

    fn debrief(helpers: Vec<DebriefHelper>) -> RunDebrief {
        RunDebrief {
            session_id: "s".into(),
            from_ts: 0,
            to_ts: 4_320_000,
            wall_ms: 4_320_000,
            ends: EndCounts { finished: helpers.len() as u32, ..Default::default() },
            helpers,
            reviews: DebriefReviews::default(),
            tokens: Tokens { total: 8_400_000, ..Default::default() },
            cost: Cost { usd: Some(12.4), complete: true, unpriced_tokens: 0 },
            biggest: None,
            open: Vec::new(),
            caught: Vec::new(),
        }
    }

    #[test]
    fn a_chat_without_helpers_is_a_valid_short_debrief() {
        let t = render(&debrief(Vec::new()), &Options::default());
        assert_eq!(t, "Ran: 1h 12m\nHelpers: none\nTokens: 8.4M");
    }

    #[test]
    fn dollars_only_when_asked() {
        let d = debrief(vec![helper(1, "coder")]);
        assert!(!render(&d, &Options::default()).contains('$'));
        let t = render(&d, &Options { cost: true, ..Default::default() });
        assert!(t.contains("Tokens: 8.4M, about $12.40 at API prices (an estimate)"), "{t}");
    }

    #[test]
    fn limits_hold_for_a_huge_run_with_long_names() {
        let long = "x".repeat(200);
        let mut hs: Vec<DebriefHelper> = (0..60).map(|i| helper(i, &format!("{long}{i}"))).collect();
        for h in hs.iter_mut() {
            h.goal = Some(long.clone());
            h.worktree_branch = Some(format!("{long}-{}", h.agent_id));
            h.end_status = None;
        }
        let mut d = debrief(hs.clone());
        d.open = hs.clone();
        d.biggest = Some(Biggest { agent_id: hs[0].agent_id.clone(), agent_type: Some(long.clone()), tokens: 5_000_000, share: 0.6 });
        d.reviews = DebriefReviews { passed: 12, findings: 9, sent_back: 4, other: 2, no_verdict: 3 };
        for _ in 0..2 {
            d.caught.push(Theme {
                id: "g".into(),
                label: long.clone(),
                count: 99,
                runs: 12,
                severities: Vec::new(),
                found_in_work_by: Vec::new(),
                not_tied: 0,
                reviewers: Vec::new(),
                projects: Vec::new(),
                last_seen: 0,
                examples: Vec::new(),
            });
        }
        let low = render(&d, &Options { cost: true, ..Default::default() });
        assert!(low.chars().count() <= LOW_CHARS && low.lines().count() <= LOW_LINES, "{} chars, {} lines\n{low}", low.chars().count(), low.lines().count());
        let high = render(&d, &Options { high: true, cost: true });
        assert!(high.chars().count() <= HIGH_CHARS && high.lines().count() <= HIGH_LINES, "{} chars, {} lines\n{high}", high.chars().count(), high.lines().count());
        assert!(high.contains("more helpers"), "{high}");
    }

    #[test]
    fn high_has_one_line_per_helper_and_low_has_none() {
        let mut hs: Vec<DebriefHelper> = (1..=3).map(|i| helper(i, "code-reviewer")).collect();
        hs[0].verdict = Some("findings".into());
        hs[0].verdict_word = Some("FIX-REQUIRED".into());
        hs[1].verdict = Some("pass".into());
        let d = debrief(hs);
        let low = render(&d, &Options::default());
        assert!(!low.contains("goal number"), "{low}");
        let high = render(&d, &Options { high: true, ..Default::default() });
        assert_eq!(high.lines().filter(|l| l.starts_with("- ")).count(), 3, "{high}");
        assert!(high.contains("- code-reviewer \"goal number 1\": finished, asked for changes (FIX-REQUIRED), 12.3k tokens, 2m, Sonnet 5.5 high"), "{high}");
        assert!(high.contains(", passed, "), "{high}");
    }

    #[test]
    fn since_takes_iso_millis_seconds_and_days() {
        assert_eq!(parse_since("1793956800000"), Ok(1_793_956_800_000));
        assert_eq!(parse_since("1793956800"), Ok(1_793_956_800_000));
        assert_eq!(parse_since("2026-11-06T09:00:00Z"), Ok(1_793_955_600_000));
        assert_eq!(parse_since("2026-11-06T10:00:00+01:00"), Ok(1_793_955_600_000));
        assert_eq!(parse_since("2026-11-06"), Ok(1_793_923_200_000));
        assert!(parse_since("yesterday").is_err());
        assert!(parse_since("").is_err());
    }

    #[test]
    fn numbers_read_like_the_cli() {
        assert_eq!(compact(950), "950");
        assert_eq!(compact(7_300), "7.3k");
        assert_eq!(compact(56_100_000), "56.1M");
        assert_eq!(compact(999_950), "1M");
        assert_eq!(duration(45_000), "45s");
        assert_eq!(duration(3_900_000), "1h 5m");
        assert_eq!(money(1234.0), "$1,234");
    }
}
