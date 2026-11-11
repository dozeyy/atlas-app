//! How a "tokens" headline is counted: the one formula behind every total in Atlas.
//!
//! Claude Code reports four kinds of tokens per reply: input, output, cache writes (what it
//! saves of the conversation) and cache reads (what it re-reads on the next reply). The
//! Settings switch "Count cache in token totals" picks what a total means:
//!
//! * off (default): input + output;
//! * on: input + output + cache writes + cache reads.
//!
//! Nothing else about usage depends on it: dollars always price every kind, and the per-kind
//! breakdown is always sent in full. Every Rust total goes through [`TokenCount::total`] (or
//! [`TokenCount::sql`] where SQLite adds the rows up, so sorting and ranking follow the same
//! rule). The front end only reads the `total` it is sent; it never re-adds the kinds.

use serde::{Deserialize, Serialize};

use super::pricing::Counts;

/// The headline rule (see the module docs).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TokenCount {
    /// Cache writes and cache reads count toward a total.
    pub cache: bool,
}

impl TokenCount {
    /// Input + output only (the default).
    pub const PLAIN: TokenCount = TokenCount { cache: false };
    /// Every kind, cache included.
    pub const WITH_CACHE: TokenCount = TokenCount { cache: true };

    pub fn new(cache: bool) -> TokenCount {
        TokenCount { cache }
    }

    /// The headline total of the four kinds. `cache_write` is the 5-minute and 1-hour writes together.
    pub fn total(self, input: u64, output: u64, cache_write: u64, cache_read: u64) -> u64 {
        let base = input.saturating_add(output);
        if self.cache {
            base.saturating_add(cache_write).saturating_add(cache_read)
        } else {
            base
        }
    }

    /// The same total as a SQL expression over a table with the ledger's columns
    /// (`input`, `output`, `cw5m`, `cw1h`, `cr`). `alias` is the table's alias with its dot
    /// ("m."), or "" for none. Wrap it in `SUM(...)` to total rows.
    pub fn sql(self, alias: &str) -> String {
        let a = alias;
        if self.cache {
            format!("{a}input + {a}output + {a}cw5m + {a}cw1h + {a}cr")
        } else {
            format!("{a}input + {a}output")
        }
    }
}

/// Every kind added up, whatever the setting: the "All together" line of a token hover.
pub fn all_kinds(input: u64, output: u64, cache_write: u64, cache_read: u64) -> u64 {
    input.saturating_add(output).saturating_add(cache_write).saturating_add(cache_read)
}

/// Tokens by what they were: the breakdown behind every total, sent whole so a hover can list
/// the kinds and add them all together. `cache_write` is the 5-minute and 1-hour writes together.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Kinds {
    pub output: u64,
    pub cache_write: u64,
    pub input: u64,
    pub cache_read: u64,
}

impl Kinds {
    pub fn add_counts(&mut self, c: &Counts) {
        self.output += c.output;
        self.cache_write += c.cw5m + c.cw1h;
        self.input += c.input;
        self.cache_read += c.cr;
    }
    pub fn add(&mut self, o: &Kinds) {
        self.output += o.output;
        self.cache_write += o.cache_write;
        self.input += o.input;
        self.cache_read += o.cache_read;
    }
    /// Take `o` away again (a reply counted twice, a run's start); never below zero.
    pub fn sub(&mut self, o: &Kinds) {
        self.output = self.output.saturating_sub(o.output);
        self.cache_write = self.cache_write.saturating_sub(o.cache_write);
        self.input = self.input.saturating_sub(o.input);
        self.cache_read = self.cache_read.saturating_sub(o.cache_read);
    }
    /// The figure the app headlines, counted the way the setting says.
    pub fn total(&self, count: TokenCount) -> u64 {
        count.total(self.input, self.output, self.cache_write, self.cache_read)
    }
    /// Every kind added up: the "All together" line of a hover.
    pub fn all(&self) -> u64 {
        all_kinds(self.input, self.output, self.cache_write, self.cache_read)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_counts_input_and_output_only() {
        assert_eq!(TokenCount::PLAIN.total(10, 20, 300, 4000), 30);
        assert_eq!(TokenCount::default(), TokenCount::PLAIN);
    }

    #[test]
    fn with_cache_adds_writes_and_reads() {
        assert_eq!(TokenCount::WITH_CACHE.total(10, 20, 300, 4000), 4330);
        assert_eq!(all_kinds(10, 20, 300, 4000), 4330);
    }

    #[test]
    fn the_sql_expression_matches_the_function() {
        assert_eq!(TokenCount::PLAIN.sql(""), "input + output");
        assert_eq!(TokenCount::WITH_CACHE.sql("m."), "m.input + m.output + m.cw5m + m.cw1h + m.cr");
        let c = rusqlite::Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE m(input,output,cw5m,cw1h,cr); INSERT INTO m VALUES (10,20,100,200,4000),(1,2,3,4,5);").unwrap();
        for mode in [TokenCount::PLAIN, TokenCount::WITH_CACHE] {
            let sql = format!("SELECT SUM({}) FROM m", mode.sql("m."));
            let got: i64 = c.query_row(&sql, [], |r| r.get(0)).unwrap();
            assert_eq!(got as u64, mode.total(11, 22, 307, 4005));
        }
    }

    #[test]
    fn kinds_follow_the_same_rule_and_add_all_together() {
        let k = Kinds { input: 10, output: 20, cache_write: 300, cache_read: 4000 };
        assert_eq!(k.total(TokenCount::PLAIN), 30);
        assert_eq!(k.total(TokenCount::WITH_CACHE), 4330);
        assert_eq!(k.all(), 4330);
        let mut sum = Kinds::default();
        sum.add(&k);
        sum.add(&k);
        sum.sub(&k);
        assert_eq!(sum, k);
        sum.sub(&Kinds { input: 99, output: 99, cache_write: 99, cache_read: 99_999 });
        assert_eq!(sum.cache_read, 0, "never below zero");
        let mut c = Kinds::default();
        c.add_counts(&Counts { input: 1, output: 2, cw5m: 3, cw1h: 4, cr: 5, web_search: 6 });
        assert_eq!(c, Kinds { input: 1, output: 2, cache_write: 7, cache_read: 5 });
    }

    #[test]
    fn totals_do_not_overflow() {
        assert_eq!(TokenCount::WITH_CACHE.total(u64::MAX, 1, 1, 1), u64::MAX);
    }
}
