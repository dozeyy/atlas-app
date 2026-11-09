//! Number, money and bar formatting for the chat output.
//!
//! Glyphs come in two sets: the default (block elements, middle dot, a triangle for the
//! busiest day) and `--ascii` for terminals or fonts that draw boxes instead.

use std::sync::atomic::{AtomicBool, Ordering};

static ASCII: AtomicBool = AtomicBool::new(false);

pub fn set_ascii(on: bool) {
    ASCII.store(on, Ordering::Relaxed);
}

pub fn ascii() -> bool {
    ASCII.load(Ordering::Relaxed)
}

/// Separator between the facts of a headline.
pub fn dot() -> &'static str {
    if ascii() { " | " } else { " \u{00B7} " }
}

/// The mark planted on the busiest day: the app's summit spark.
pub fn summit() -> char {
    if ascii() { '^' } else { '\u{25B2}' }
}

/// The glyph of a heat-grid cell by band: 0 is an idle day, 1..=5 climb like terrain.
pub fn heat(band: usize) -> char {
    const UNI: [char; 6] = ['\u{00B7}', '\u{2582}', '\u{2583}', '\u{2585}', '\u{2586}', '\u{2588}'];
    const ASC: [char; 6] = ['.', ':', '-', '=', '+', '#'];
    (if ascii() { ASC } else { UNI })[band.min(5)]
}

/// Quantile cut points (20 / 45 / 70 / 90 % of the active days) that split activity into
/// bands 1-5. Same rule as the app's `heatCuts`.
pub fn heat_cuts(values: &[u64]) -> Vec<u64> {
    let mut v: Vec<u64> = values.iter().copied().filter(|x| *x > 0).collect();
    if v.is_empty() {
        return Vec::new();
    }
    v.sort_unstable();
    let q = |p: f64| v[(p * (v.len() - 1) as f64).floor() as usize];
    vec![q(0.2), q(0.45), q(0.7), q(0.9)]
}

pub fn heat_band(v: u64, cuts: &[u64]) -> usize {
    if v == 0 { 0 } else { 1 + cuts.iter().filter(|c| v > **c).count() }
}

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
/// value gets at least a sliver; a zero is a one-cell nub, so an idle day never looks like
/// a missing row. Padded with spaces to `width`.
pub fn bar(v: u64, max: u64, width: usize) -> String {
    const PARTS: [char; 8] = [' ', '\u{258F}', '\u{258E}', '\u{258D}', '\u{258C}', '\u{258B}', '\u{258A}', '\u{2589}'];
    let mut s = String::new();
    if v == 0 {
        s.push(heat(0));
    } else if max > 0 && ascii() {
        let cells = ((v as f64 / max as f64) * width as f64).round().clamp(1.0, width as f64) as usize;
        s.extend(std::iter::repeat_n('#', cells));
    } else if max > 0 {
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

/// A model id the way the app names it (`modelLabel` in `src/lib/usage.ts`):
/// "claude-opus-5-5" -> "Opus 5.5", "claude-3-5-sonnet-20241022" -> "Sonnet 3.5". Anything
/// else is left as it is, exactly as the app leaves it.
pub fn model(m: &str) -> String {
    cell(&model_label(m), 40)
}

fn model_label(m: &str) -> String {
    let family = |s: &str| matches!(s, "opus" | "sonnet" | "haiku");
    let digits = |s: &str, max: usize| !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_digit());
    let cap = |s: &str| {
        let mut c = s.chars();
        c.next().map(|f| f.to_uppercase().collect::<String>() + c.as_str()).unwrap_or_default()
    };
    let Some(rest) = m.strip_prefix("claude-") else { return m.to_string() };
    let mut parts: Vec<&str> = rest.split('-').collect();
    if parts.len() > 2 && parts.last().is_some_and(|p| p.len() == 8 && digits(p, 8)) {
        parts.pop();
    }
    let version = |major: &str, minor: Option<&&str>| match minor {
        Some(n) => format!("{major}.{n}"),
        None => major.to_string(),
    };
    match parts.as_slice() {
        [f, maj, rest @ ..] if family(f) && digits(maj, 20) && rest.len() <= 1 && rest.first().is_none_or(|n| digits(n, 2)) => {
            format!("{} {}", cap(f), version(maj, rest.first()))
        }
        [maj, rest @ .., f] if family(f) && digits(maj, 20) && rest.len() <= 1 && rest.first().is_none_or(|n| digits(n, 2)) => {
            format!("{} {}", cap(f), version(maj, rest.first()))
        }
        _ => m.to_string(),
    }
}

/// Text from the user's own data (chat titles, project names, model ids) for output: in ASCII
/// mode every non-ASCII character becomes `?`, so `--ascii` really is ASCII-only.
pub fn plain(s: &str) -> String {
    if ascii() && !s.is_ascii() { s.chars().map(|c| if c.is_ascii() { c } else { '?' }).collect() } else { s.to_string() }
}

/// One table cell: no pipes or newlines, at most `max` characters, ASCII-only in ASCII mode.
pub fn cell(s: &str, max: usize) -> String {
    let flat: String = plain(s).chars().map(|c| if c == '|' || c.is_control() { ' ' } else { c }).collect();
    let flat = flat.trim();
    if flat.chars().count() <= max {
        flat.to_string()
    } else {
        let ell = if ascii() { "..." } else { "\u{2026}" };
        let mut t: String = flat.chars().take(max.saturating_sub(ell.chars().count())).collect();
        t.push_str(ell);
        t
    }
}

/// Tests that read or flip the glyph set take this, so they never see each other's mode.
#[cfg(test)]
pub fn glyph_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
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
        let _g = glyph_lock();
        // An idle day is a one-cell nub, never an empty row.
        assert_eq!(bar(0, 10, 4), "\u{00B7}   ");
        assert_eq!(bar(10, 10, 4), "\u{2588}\u{2588}\u{2588}\u{2588}");
        assert_eq!(bar(5, 10, 4), "\u{2588}\u{2588}  ");
        assert_eq!(bar(1, 1000, 4).chars().next(), Some('\u{258F}'));
        assert_eq!(bar(7, 10, 4).chars().count(), 4);
        // A bar starts at the baseline and never passes its width.
        for v in 0..=10 {
            assert_eq!(bar(v, 10, 6).chars().count(), 6);
        }
    }

    #[test]
    fn models_are_named_like_the_app() {
        let _g = glyph_lock();
        assert_eq!(model("claude-opus-5-5"), "Opus 5.5");
        assert_eq!(model("claude-sonnet-5-5"), "Sonnet 5.5");
        assert_eq!(model("claude-haiku-5-5"), "Haiku 5.5");
        assert_eq!(model("claude-opus-4-20250514"), "Opus 4");
        assert_eq!(model("claude-sonnet-4-5-20250929"), "Sonnet 4.5");
        assert_eq!(model("claude-3-5-sonnet-20241022"), "Sonnet 3.5");
        assert_eq!(model("claude-3-haiku-20240307"), "Haiku 3");
        // Not a family the app names: shown as it is.
        assert_eq!(model("claude-fable-5-1"), "claude-fable-5-1");
        assert_eq!(model("<synthetic>"), "<synthetic>");
    }

    #[test]
    fn user_text_is_ascii_in_ascii_mode_only() {
        let _g = glyph_lock();
        assert_eq!(cell("caf\u{e9}|x", 40), "caf\u{e9} x");
        assert_eq!(model("claude-\u{e9}"), "claude-\u{e9}");
        set_ascii(true);
        let (c, m, long) = (cell("caf\u{e9}|x", 40), model("claude-\u{e9}"), cell(&"\u{65e5}".repeat(50), 10));
        set_ascii(false);
        assert_eq!(c, "caf? x");
        assert_eq!(m, "claude-?");
        assert_eq!(long, "???????...");
    }

    #[test]
    fn heat_bands_follow_the_apps_quantiles() {
        let _g = glyph_lock();
        assert!(heat_cuts(&[0, 0]).is_empty());
        let cuts = heat_cuts(&[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
        // Ten active days: index floor(p * 9) of the sorted values, as the app's heatCuts.
        assert_eq!(cuts, vec![20, 50, 70, 90]);
        assert_eq!(heat_band(0, &cuts), 0);
        assert_eq!(heat_band(10, &cuts), 1);
        assert_eq!(heat_band(100, &cuts), 5);
        // Five bands climb from low to high, one glyph each.
        let glyphs: String = (0..=5).map(heat).collect();
        assert_eq!(glyphs.chars().count(), 6);
    }

    #[test]
    fn ascii_mode_has_no_unicode() {
        let _g = glyph_lock();
        set_ascii(true);
        let all = format!("{}{}{}{}{}", bar(3, 10, 8), bar(0, 10, 8), dot(), summit(), (0..=5).map(heat).collect::<String>());
        let cut = cell("abcdefghij", 6);
        set_ascii(false);
        assert!(all.is_ascii(), "{all:?}");
        assert_eq!(cut, "abc...");
    }

    #[test]
    fn change_and_cells() {
        let _g = glyph_lock();
        assert_eq!(change(100, 113), "+13%");
        assert_eq!(change(100, 96), "-4%");
        assert_eq!(change(0, 5), "new");
        assert_eq!(cell("a|b\nc", 10), "a b c");
        assert_eq!(cell("abcdefghij", 5), "abcd\u{2026}");
        assert_eq!(duration(72 * 60_000), "1h 12m");
    }
}
