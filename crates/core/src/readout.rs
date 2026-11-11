//! The one-line "today" readout used by the tray tooltip and menu.
//!
//! Tokens are the headline number (input + output; cache writes and reads join in only when
//! the Settings switch "Count cache in token totals" is on, the same as everywhere else in
//! Atlas: `TokenCount`) and the only figure the tray menu shows
//! (Will, 2026-11-08: tokens everywhere, money only on hover). The tooltip is the hover,
//! so it alone adds the money, and money is always an estimate: it carries "~" and "est.",
//! and a "+" when some tokens could not be priced.

use crate::usage::query::Period;

/// "840", "12.3k", "123k", "1.2M", "3.4B": never more than three digits before the unit
/// (the same shape as `compact()` in the front end).
pub fn compact_tokens(n: u64) -> String {
    fn one(v: f64, unit: &str) -> String {
        // One decimal below 10 of the unit, none above; never "1.0k". Round half up like the
        // front end's Math.round (format! rounds 9.95 to "9.9", the app shows "10k").
        let s = if v < 10.0 {
            let r = (v * 10.0).round() / 10.0;
            if r < 10.0 { format!("{r:.1}") } else { format!("{r:.0}") }
        } else {
            format!("{:.0}", v.round())
        };
        format!("{}{unit}", s.strip_suffix(".0").unwrap_or(&s))
    }
    match n {
        0..=999 => n.to_string(),
        1_000..=999_499 => one(n as f64 / 1e3, "k"),
        999_500..=999_499_999 => one(n as f64 / 1e6, "M"),
        _ => one(n as f64 / 1e9, "B"),
    }
}

/// "$0.42", "$12.30", "$1,234".
pub fn dollars(usd: f64) -> String {
    let usd = if usd.is_finite() && usd > 0.0 { usd } else { 0.0 };
    if usd < 1000.0 {
        return format!("${usd:.2}");
    }
    let whole = format!("{usd:.0}");
    let mut out = String::new();
    for (i, c) in whole.chars().enumerate() {
        if i > 0 && (whole.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    format!("${out}")
}

/// "Today: 1.2M tokens": the tray menu line. No money here.
pub fn today_line(p: &Period) -> String {
    format!("Today: {} tokens", compact_tokens(p.tokens.total))
}

/// "Today: 1.2M tokens \u{b7} ~$3.40 est.": the tray tooltip, the hover, where the estimate lives.
pub fn today_hover(p: &Period) -> String {
    let tokens = compact_tokens(p.tokens.total);
    match p.cost.usd {
        Some(usd) => {
            let plus = if p.cost.complete { "" } else { "+" };
            format!("Today: {tokens} tokens \u{b7} ~{}{plus} est.", dollars(usd))
        }
        // Nothing could be priced (or nothing was used): say so rather than "$0".
        None if p.tokens.total == 0 => format!("Today: {tokens} tokens"),
        None => format!("Today: {tokens} tokens \u{b7} cost unknown"),
    }
}

/// Shown until the first numbers exist.
pub const WAITING: &str = "Atlas: reading your Claude folder...";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::query::{Cost, Tokens};

    fn period(total: u64, usd: Option<f64>, complete: bool) -> Period {
        Period { tokens: Tokens { total, ..Tokens::default() }, cost: Cost { usd, complete, unpriced_tokens: 0 }, sessions: 1 }
    }

    #[test]
    fn tokens_are_compact_and_never_say_one_point_zero() {
        assert_eq!(compact_tokens(0), "0");
        assert_eq!(compact_tokens(999), "999");
        assert_eq!(compact_tokens(1_000), "1k");
        assert_eq!(compact_tokens(1_234), "1.2k");
        assert_eq!(compact_tokens(7_300), "7.3k");
        assert_eq!(compact_tokens(9_950), "10k"); // same as the app's Math.round, not "9.9k"
        assert_eq!(compact_tokens(1_250), "1.3k");
        assert_eq!(compact_tokens(98_765), "99k");
        assert_eq!(compact_tokens(123_456), "123k");
        assert_eq!(compact_tokens(999_499), "999k");
        assert_eq!(compact_tokens(999_500), "1M");
        assert_eq!(compact_tokens(1_234_567), "1.2M");
        assert_eq!(compact_tokens(27_000_000), "27M");
        assert_eq!(compact_tokens(289_400_000), "289M");
        assert_eq!(compact_tokens(2_500_000_000), "2.5B");
    }

    #[test]
    fn dollars_group_thousands() {
        assert_eq!(dollars(0.0), "$0.00");
        assert_eq!(dollars(0.426), "$0.43");
        assert_eq!(dollars(12.3), "$12.30");
        assert_eq!(dollars(999.99), "$999.99");
        assert_eq!(dollars(1234.4), "$1,234");
        assert_eq!(dollars(1_234_567.0), "$1,234,567");
        assert_eq!(dollars(f64::NAN), "$0.00");
    }

    #[test]
    fn the_menu_line_is_tokens_only() {
        assert_eq!(today_line(&period(1_234_567, Some(3.4), true)), "Today: 1.2M tokens");
        assert_eq!(today_line(&period(900, None, false)), "Today: 900 tokens");
        assert_eq!(today_line(&period(0, None, true)), "Today: 0 tokens");
        assert!(!today_line(&period(1_234_567, Some(3.4), false)).contains('$'));
    }

    #[test]
    fn the_hover_money_is_always_an_estimate() {
        assert_eq!(today_hover(&period(1_234_567, Some(3.4), true)), "Today: 1.2M tokens \u{b7} ~$3.40 est.");
        assert_eq!(today_hover(&period(500, Some(0.0), true)), "Today: 500 tokens \u{b7} ~$0.00 est.");
        assert_eq!(today_hover(&period(1_234_567, Some(3.4), false)), "Today: 1.2M tokens \u{b7} ~$3.40+ est.");
        assert_eq!(today_hover(&period(0, None, true)), "Today: 0 tokens");
        assert_eq!(today_hover(&period(900, None, false)), "Today: 900 tokens \u{b7} cost unknown");
        // The Windows tooltip holds 127 characters.
        assert!(today_hover(&period(u64::MAX, Some(1e12), false)).chars().count() < 100);
    }
}
