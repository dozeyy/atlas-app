//! The one-line "today" readout used by the tray tooltip and menu.
//!
//! Tokens are the headline number (input + output + cache writes; cache reads are not
//! counted, same as everywhere else in Atlas). Money is always an estimate: it carries
//! "~" and "est.", and a "+" when some tokens could not be priced.

use crate::usage::query::Period;

/// "840", "12.3K", "1.2M", "3.4B".
pub fn compact_tokens(n: u64) -> String {
    fn one(v: f64, unit: &str) -> String {
        // One decimal below 100 of the unit, none above; never "1.0K".
        let s = if v < 100.0 { format!("{v:.1}") } else { format!("{v:.0}") };
        format!("{}{unit}", s.strip_suffix(".0").unwrap_or(&s))
    }
    match n {
        0..=999 => n.to_string(),
        1_000..=999_499 => one(n as f64 / 1e3, "K"),
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

/// "Today: 1.2M tokens \u{b7} ~$3.40 est."
pub fn today_line(p: &Period) -> String {
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
        assert_eq!(compact_tokens(1_000), "1K");
        assert_eq!(compact_tokens(1_234), "1.2K");
        assert_eq!(compact_tokens(98_765), "98.8K");
        assert_eq!(compact_tokens(123_456), "123K");
        assert_eq!(compact_tokens(999_499), "999K");
        assert_eq!(compact_tokens(999_500), "1M");
        assert_eq!(compact_tokens(1_234_567), "1.2M");
        assert_eq!(compact_tokens(45_600_000), "45.6M");
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
    fn the_line_is_always_an_estimate() {
        assert_eq!(today_line(&period(1_234_567, Some(3.4), true)), "Today: 1.2M tokens \u{b7} ~$3.40 est.");
        assert_eq!(today_line(&period(500, Some(0.0), true)), "Today: 500 tokens \u{b7} ~$0.00 est.");
        assert_eq!(today_line(&period(1_234_567, Some(3.4), false)), "Today: 1.2M tokens \u{b7} ~$3.40+ est.");
        assert_eq!(today_line(&period(0, None, true)), "Today: 0 tokens");
        assert_eq!(today_line(&period(900, None, false)), "Today: 900 tokens \u{b7} cost unknown");
        // The Windows tooltip holds 127 characters.
        assert!(today_line(&period(u64::MAX, Some(1e12), false)).chars().count() < 100);
    }
}
