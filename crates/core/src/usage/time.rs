//! Time: ISO timestamps to epoch milliseconds, and local-hour buckets (D36).

use chrono::{Datelike, FixedOffset, Local, NaiveDate, NaiveDateTime, Offset, TimeZone, Timelike};

/// The time zone used for buckets. Tests inject a fixed offset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tz {
    /// The operating system's local time zone (the default).
    Local,
    /// A fixed offset east of UTC, in seconds (tests).
    Fixed(i32),
}

impl Tz {
    /// UTC offset in seconds at the instant `ts_ms`.
    pub fn offset_secs(self, ts_ms: i64) -> i32 {
        match self {
            Tz::Fixed(s) => s,
            Tz::Local => {
                let Some(utc) = chrono::DateTime::from_timestamp_millis(ts_ms) else { return 0 };
                Local.offset_from_utc_datetime(&utc.naive_utc()).fix().local_minus_utc()
            }
        }
    }

    /// The local wall clock at `ts_ms`.
    pub fn local(self, ts_ms: i64) -> Option<NaiveDateTime> {
        let utc = chrono::DateTime::from_timestamp_millis(ts_ms)?;
        let off = FixedOffset::east_opt(self.offset_secs(ts_ms))?;
        Some(utc.with_timezone(&off).naive_local())
    }

    /// `YYYY-MM-DDTHH` of the local hour containing `ts_ms`.
    pub fn hour_bucket(self, ts_ms: i64) -> String {
        match self.local(ts_ms) {
            Some(l) => format!("{:04}-{:02}-{:02}T{:02}", l.year(), l.month(), l.day(), l.hour()),
            None => "1970-01-01T00".into(),
        }
    }

    /// A string that changes when the zone (or its current offset) changes (D36).
    pub fn fingerprint(self, now_ms: i64) -> String {
        match self {
            Tz::Fixed(s) => format!("fixed:{s}"),
            Tz::Local => format!("local:{}", self.offset_secs(now_ms)),
        }
    }

    /// Local calendar day (`YYYY-MM-DD`) of `ts_ms`.
    pub fn day(self, ts_ms: i64) -> String {
        self.hour_bucket(ts_ms)[..10].to_string()
    }
}

/// `2026-11-02T09:00:01.000Z` -> epoch ms. Falls back to chrono for other RFC 3339 shapes.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() >= 20 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' && b[13] == b':' && b[16] == b':' {
        let num = |from: usize, to: usize| -> Option<i64> {
            let mut v = 0i64;
            for &c in b.get(from..to)? {
                if !c.is_ascii_digit() {
                    return None;
                }
                v = v * 10 + i64::from(c - b'0');
            }
            Some(v)
        };
        let (y, mo, d, h, mi, se) =
            (num(0, 4)?, num(5, 7)?, num(8, 10)?, num(11, 13)?, num(14, 16)?, num(17, 19)?);
        let mut idx = 19;
        let mut ms = 0i64;
        if b.get(idx) == Some(&b'.') {
            idx += 1;
            let mut digits = 0;
            while let Some(&c) = b.get(idx) {
                if !c.is_ascii_digit() {
                    break;
                }
                if digits < 3 {
                    ms = ms * 10 + i64::from(c - b'0');
                    digits += 1;
                }
                idx += 1;
            }
            while digits < 3 {
                ms *= 10;
                digits += 1;
            }
        }
        if b.get(idx) == Some(&b'Z') && idx + 1 == b.len() {
            let date = NaiveDate::from_ymd_opt(y as i32, mo as u32, d as u32)?;
            let days = i64::from(date.num_days_from_ce()) - 719_163; // 1970-01-01
            return Some(((days * 24 + h) * 60 + mi) * 60_000 + se * 1000 + ms);
        }
    }
    chrono::DateTime::parse_from_rfc3339(s).ok().map(|d| d.timestamp_millis())
}

/// `YYYY-MM-DD` shifted by `delta` days. Invalid input is returned unchanged.
pub fn add_days(day: &str, delta: i64) -> String {
    match NaiveDate::parse_from_str(day, "%Y-%m-%d") {
        Ok(d) => (d + chrono::Duration::days(delta)).format("%Y-%m-%d").to_string(),
        Err(_) => day.to_string(),
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Q9: the week starts where the operating system's locale says. Windows asks the
/// user's locale; elsewhere Monday. Shared by the app and the `atlas-usage` CLI so a
/// "week" means the same days in both.
pub fn week_starts_sunday() -> bool {
    #[cfg(windows)]
    {
        unsafe extern "system" {
            fn GetLocaleInfoEx(name: *const u16, lc_type: u32, data: *mut u16, len: i32) -> i32;
        }
        const LOCALE_IFIRSTDAYOFWEEK: u32 = 0x0000_100C;
        const LOCALE_RETURN_NUMBER: u32 = 0x2000_0000;
        let mut out = [0u16; 2];
        // SAFETY: a null name means the user's default locale; `out` holds the DWORD
        // that LOCALE_RETURN_NUMBER asks for.
        let n = unsafe { GetLocaleInfoEx(std::ptr::null(), LOCALE_IFIRSTDAYOFWEEK | LOCALE_RETURN_NUMBER, out.as_mut_ptr(), 2) };
        // 0 = Monday ... 6 = Sunday.
        n != 0 && (u32::from(out[0]) | (u32::from(out[1]) << 16)) == 6
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_z_timestamps_exactly() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("2026-11-02T09:00:01.500Z"), Some(1_793_610_001_500));
        assert_eq!(parse_iso_ms("2026-11-02T09:00:01Z"), Some(1_793_610_001_000));
        assert_eq!(parse_iso_ms("2026-11-02T09:00:01.5Z"), Some(1_793_610_001_500));
        assert_eq!(parse_iso_ms("2026-11-02T10:00:01+01:00"), Some(1_793_610_001_000));
        assert_eq!(parse_iso_ms("garbage"), None);
    }

    #[test]
    fn fixed_zone_buckets_cross_midnight() {
        let tz = Tz::Fixed(-7 * 3600);
        let before = parse_iso_ms("2026-11-03T06:59:59.000Z").unwrap();
        let after = parse_iso_ms("2026-11-03T07:00:00.000Z").unwrap();
        assert_eq!(tz.hour_bucket(before), "2026-11-02T23");
        assert_eq!(tz.hour_bucket(after), "2026-11-03T00");
    }

    #[test]
    fn day_math() {
        assert_eq!(add_days("2026-03-01", -1), "2026-02-28");
        assert_eq!(add_days("2026-12-31", 1), "2027-01-01");
    }
}
