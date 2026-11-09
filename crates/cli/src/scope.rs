//! Scope words ("today", "last-week", "2026-11-02..2026-11-07") to local day ranges.
//! Pure date math: `today` and the week start come from the engine, so a range here is
//! the same days the app shows.

use chrono::{Datelike, Duration, NaiveDate};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Span {
    pub from: NaiveDate,
    pub to: NaiveDate,
    /// "This week", "Last week", "Nov 2 - Nov 7".
    pub label: String,
}

impl Span {
    pub fn days(&self) -> i64 {
        (self.to - self.from).num_days() + 1
    }
}

pub fn day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d").ok()
}

pub fn ymd(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// "Nov 2", or "Nov 2 2025" when not this year.
pub fn short(d: NaiveDate, today: NaiveDate) -> String {
    if d.year() == today.year() { d.format("%b %-d").to_string() } else { d.format("%b %-d %Y").to_string() }
}

fn week_start(d: NaiveDate, sunday: bool) -> NaiveDate {
    let back = if sunday { d.weekday().num_days_from_sunday() } else { d.weekday().num_days_from_monday() };
    d - Duration::days(i64::from(back))
}

fn month_start(d: NaiveDate) -> NaiveDate {
    d.with_day(1).unwrap_or(d)
}

/// Normalize free words to one scope word: "Last Week" -> "last-week", "past 7 days" -> "7d".
pub fn normalize(word: &str) -> String {
    let w = word.trim().to_lowercase().replace(['_', ' '], "-");
    let w = w.trim_matches('-').to_string();
    for p in ["past-", "last-"] {
        if let Some(n) = w.strip_prefix(p).and_then(|r| r.strip_suffix("-days")).and_then(|n| n.parse::<u32>().ok()) {
            return format!("{n}d");
        }
    }
    match w.as_str() {
        "this-week" | "current-week" | "wtd" => "week".into(),
        "previous-week" | "prev-week" | "past-week" => "last-week".into(),
        "this-month" | "current-month" | "mtd" => "month".into(),
        "previous-month" | "prev-month" | "past-month" => "last-month".into(),
        "all-time" | "everything" | "total" | "lifetime" | "ever" => "all".into(),
        "this-day" => "today".into(),
        _ => w,
    }
}

/// One scope word to a day range. `first` is the first day with any usage (for "all").
pub fn parse(word: &str, today: NaiveDate, sunday: bool, first: Option<NaiveDate>) -> Result<Span, String> {
    let w = normalize(word);
    let span = |from: NaiveDate, to: NaiveDate, label: &str| Span { from, to, label: label.to_string() };
    let ranged = |from: NaiveDate, to: NaiveDate| {
        let label = if from == to { short(from, today) } else { format!("{} - {}", short(from, today), short(to, today)) };
        Span { from, to, label }
    };
    Ok(match w.as_str() {
        "today" => span(today, today, "Today"),
        "yesterday" => {
            let y = today - Duration::days(1);
            span(y, y, "Yesterday")
        }
        "week" => span(week_start(today, sunday), today, "This week"),
        "last-week" => {
            let this = week_start(today, sunday);
            span(this - Duration::days(7), this - Duration::days(1), "Last week")
        }
        "month" => span(month_start(today), today, "This month"),
        "last-month" => {
            let end = month_start(today) - Duration::days(1);
            span(month_start(end), end, "Last month")
        }
        "all" => span(first.unwrap_or(today).min(today), today, "All time"),
        _ => {
            if let Some(n) = w.strip_suffix('d').and_then(|n| n.parse::<i64>().ok()).filter(|n| (1..=3650).contains(n)) {
                return Ok(span(today - Duration::days(n - 1), today, &format!("Last {n} days")));
            }
            if let Some((a, b)) = w.split_once("..") {
                let (Some(a), Some(b)) = (day(a), day(b)) else {
                    return Err(format!("could not read the range \"{word}\" (use YYYY-MM-DD..YYYY-MM-DD)"));
                };
                return Ok(ranged(a.min(b), a.max(b)));
            }
            if let Some(d) = day(&w) {
                return Ok(ranged(d, d));
            }
            return Err(format!(
                "unknown scope \"{word}\". Use: chat, today, yesterday, week, last-week, 7d, 30d, month, last-month, all, project, YYYY-MM-DD or YYYY-MM-DD..YYYY-MM-DD"
            ));
        }
    })
}

/// Bucket for a range: days up to a month, then weeks, then months.
pub fn bucket_for(days: i64) -> &'static str {
    if days <= 31 {
        "day"
    } else if days <= 26 * 7 {
        "week"
    } else {
        "month"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        day(s).unwrap()
    }

    #[test]
    fn weeks_follow_the_week_start() {
        let sun = d("2026-11-08");
        assert_eq!(parse("week", sun, false, None).unwrap(), Span { from: d("2026-11-02"), to: sun, label: "This week".into() });
        let last = parse("last week", sun, false, None).unwrap();
        assert_eq!((last.from, last.to), (d("2026-10-26"), d("2026-11-01")));
        let sunday_week = parse("this week", sun, true, None).unwrap();
        assert_eq!((sunday_week.from, sunday_week.to), (sun, sun));
        let sunday_last = parse("last-week", sun, true, None).unwrap();
        assert_eq!((sunday_last.from, sunday_last.to), (d("2026-11-01"), d("2026-11-07")));
    }

    #[test]
    fn days_months_ranges() {
        let t = d("2026-11-08");
        assert_eq!(parse("7d", t, false, None).unwrap().from, d("2026-11-02"));
        assert_eq!(parse("past 30 days", t, false, None).unwrap().from, d("2026-10-10"));
        let lm = parse("last-month", t, false, None).unwrap();
        assert_eq!((lm.from, lm.to), (d("2026-10-01"), d("2026-10-31")));
        assert_eq!(parse("month", t, false, None).unwrap().from, d("2026-11-01"));
        let r = parse("2026-11-07..2026-11-02", t, false, None).unwrap();
        assert_eq!((r.from, r.to, r.days()), (d("2026-11-02"), d("2026-11-07"), 6));
        assert_eq!(r.label, "Nov 2 - Nov 7");
        assert_eq!(parse("yesterday", t, false, None).unwrap().from, d("2026-11-07"));
        assert_eq!(parse("all", t, false, Some(d("2026-01-15"))).unwrap().from, d("2026-01-15"));
        assert!(parse("fortnight", t, false, None).is_err());
    }

    #[test]
    fn buckets() {
        assert_eq!(bucket_for(7), "day");
        assert_eq!(bucket_for(31), "day");
        assert_eq!(bucket_for(90), "week");
        assert_eq!(bucket_for(400), "month");
    }
}
