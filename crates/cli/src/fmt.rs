//! Number, money and bar formatting for the chat output.

/// Tokens in 3 significant digits with a unit: 950, 7.3k, 27M, 56.1M, 9.11M, 108M.
/// Trailing zeros are dropped; 999,950 rolls over to "1M", never "1000k".
pub fn compact(n: u64) -> String {
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
        let decimals = if v < 10.0 {
            2
        } else if v < 100.0 {
            1
        } else {
            0
        };
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

/// The app's money rule (`formatUsd`): "$0.00", "<$0.01", "$4.20", "$1,234"; a `+` when
/// some tokens had no price; "no price" when nothing did.
pub fn usd(usd: Option<f64>, complete: bool) -> String {
    let Some(v) = usd else { return "no price".to_string() };
    let s = if v <= 0.0 {
        "$0.00".to_string()
    } else if v < 0.005 {
        "<$0.01".to_string()
    } else if v < 100.0 {
        format!("${v:.2}")
    } else {
        let whole = format!("{:.0}", v);
        let mut out = String::new();
        for (i, c) in whole.chars().enumerate() {
            if i > 0 && (whole.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(c);
        }
        format!("${out}")
    };
    if complete { s } else { format!("{s}+") }
}

/// Percent change from `old` to `new`, "+13%", "-4%", "new" when old was zero.
pub fn change(old: u64, new: u64) -> String {
    if old == 0 {
        return if new == 0 { "0%".to_string() } else { "new".to_string() };
    }
    let p = (new as f64 - old as f64) / old as f64 * 100.0;
    if p.abs() < 0.5 { "0%".to_string() } else { format!("{:+.0}%", p) }
}

/// A horizontal bar `width` cells wide at full scale, in eighth blocks. Any non-zero
/// value gets at least a sliver. Padded with spaces to `width`.
pub fn bar(v: u64, max: u64, width: usize) -> String {
    const PARTS: [char; 8] = [' ', '\u{258F}', '\u{258E}', '\u{258D}', '\u{258C}', '\u{258B}', '\u{258A}', '\u{2589}'];
    let mut s = String::new();
    if max > 0 && v > 0 {
        let eighths = ((v as f64 / max as f64) * (width * 8) as f64).round().max(1.0) as usize;
        let eighths = eighths.min(width * 8);
        s.extend(std::iter::repeat_n('\u{2588}', eighths / 8));
        if !eighths.is_multiple_of(8) {
            s.push(PARTS[eighths % 8]);
        }
    }
    let used = s.chars().count();
    s.extend(std::iter::repeat_n(' ', width.saturating_sub(used)));
    s
}

/// Duration as "45s", "12m", "1h 12m", "2d 3h".
pub fn duration(ms: i64) -> String {
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

/// A model id without the vendor prefix: "claude-opus-5-5" -> "opus-5-5".
pub fn model(m: &str) -> String {
    m.strip_prefix("claude-").unwrap_or(m).to_string()
}

/// One table cell: no pipes or newlines, at most `max` characters.
pub fn cell(s: &str, max: usize) -> String {
    let flat: String = s.chars().map(|c| if c == '|' || c.is_control() { ' ' } else { c }).collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        let mut t: String = flat.chars().take(max.saturating_sub(1)).collect();
        t.push('\u{2026}');
        t
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_is_three_significant_digits() {
        assert_eq!(compact(0), "0");
        assert_eq!(compact(950), "950");
        assert_eq!(compact(7_300), "7.3k");
        assert_eq!(compact(27_000_000), "27M");
        assert_eq!(compact(56_123_456), "56.1M");
        assert_eq!(compact(9_114_000), "9.11M");
        assert_eq!(compact(1_820_000), "1.82M");
        assert_eq!(compact(41_249_999), "41.2M");
        assert_eq!(compact(108_400_000), "108M");
        assert_eq!(compact(1_000), "1k");
        assert_eq!(compact(999_950), "1M");
        assert_eq!(compact(999_499), "999k");
        assert_eq!(compact(2_500_000_000), "2.5B");
    }

    #[test]
    fn usd_matches_the_app_rule() {
        assert_eq!(usd(None, true), "no price");
        assert_eq!(usd(Some(0.0), true), "$0.00");
        assert_eq!(usd(Some(0.004), true), "<$0.01");
        assert_eq!(usd(Some(4.2), false), "$4.20+");
        assert_eq!(usd(Some(1234.4), true), "$1,234");
        assert_eq!(usd(Some(123.0), true), "$123");
    }

    #[test]
    fn bars_scale_and_pad() {
        assert_eq!(bar(0, 10, 4), "    ");
        assert_eq!(bar(10, 10, 4), "\u{2588}\u{2588}\u{2588}\u{2588}");
        assert_eq!(bar(5, 10, 4), "\u{2588}\u{2588}  ");
        assert_eq!(bar(1, 1000, 4).chars().next(), Some('\u{258F}'));
        assert_eq!(bar(7, 10, 4).chars().count(), 4);
    }

    #[test]
    fn change_and_cells() {
        assert_eq!(change(100, 113), "+13%");
        assert_eq!(change(100, 96), "-4%");
        assert_eq!(change(0, 5), "new");
        assert_eq!(cell("a|b\nc", 10), "a b c");
        assert_eq!(cell("abcdefghij", 5), "abcd\u{2026}");
        assert_eq!(duration(72 * 60_000), "1h 12m");
    }
}
