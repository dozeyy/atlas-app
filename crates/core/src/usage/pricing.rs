//! Price table and cost math (D20-D26). Pure: no file I/O here (the live file is
//! managed by `cache::pricing_file`).
//!
//! Prices are USD per million tokens. A model matches by exact id or an id in its
//! `aliases`, never by prefix or family (D22). Anything the table cannot price
//! exactly (unknown model, odd speed, geo or service tier) gives `None`: tokens
//! still count everywhere, the cost is "not priced", never guessed.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// The seed bundled in the binary: the last-resort table and the source of the
/// first `pricing.json`.
pub const SEED_JSON: &str = include_str!("../../pricing/pricing.default.json");
/// Prompt size above which a Haiku-style long-context request is repriced, when a
/// model lists no threshold of its own.
pub const DEFAULT_LONG_CONTEXT_TOKENS: u64 = 100_000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FastPrice {
    pub input: f64,
    pub output: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LongContext {
    pub threshold_tokens: u64,
    pub input: f64,
    pub output: f64,
    pub cache_write5m: f64,
    pub cache_write1h: f64,
    pub cache_read: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_write5m: f64,
    pub cache_write1h: f64,
    pub cache_read: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fast: Option<FastPrice>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub long_context: Option<LongContext>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PriceTable {
    pub schema_version: u32,
    pub updated: String,
    pub currency: String,
    pub unit: String,
    pub source: String,
    pub web_search_per_thousand: f64,
    pub web_fetch_per_thousand: f64,
    pub geo_multipliers: HashMap<String, f64>,
    pub service_tiers: Vec<String>,
    pub models: HashMap<String, ModelPrice>,
    #[serde(skip)]
    alias_index: HashMap<String, String>,
}

/// One row of token counts to price.
#[derive(Debug, Clone, Copy, Default)]
pub struct Counts {
    pub input: u64,
    pub output: u64,
    pub cw5m: u64,
    pub cw1h: u64,
    pub cr: u64,
    pub web_search: u64,
}

impl Counts {
    pub fn prompt(&self) -> u64 {
        self.input + self.cr + self.cw5m + self.cw1h
    }
}

/// How a row is billed. Strings are exactly what the transcript says.
#[derive(Debug, Clone, Copy)]
pub struct Basis<'a> {
    pub model: &'a str,
    pub speed: &'a str,
    pub geo: &'a str,
    pub service_tier: &'a str,
    /// 1 when the request used the long-context rates (decided at ingest, D24).
    pub price_tier: i64,
}

impl PriceTable {
    pub fn parse(json: &str) -> Result<PriceTable, String> {
        let mut t: PriceTable =
            serde_json::from_str(json).map_err(|e| format!("not a valid price list: {e}"))?;
        t.validate()?;
        t.reindex();
        Ok(t)
    }

    /// The table bundled in the app. It is part of the build, so it must parse.
    pub fn seed() -> PriceTable {
        PriceTable::parse(SEED_JSON).expect("bundled pricing.default.json is valid")
    }

    fn reindex(&mut self) {
        self.alias_index.clear();
        for (id, m) in &self.models {
            for a in &m.aliases {
                self.alias_index.insert(a.clone(), id.clone());
            }
        }
    }

    fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err(format!("unknown price list version {}", self.schema_version));
        }
        if self.models.is_empty() {
            return Err("the price list has no models".into());
        }
        let ok = |v: f64| v.is_finite() && v >= 0.0;
        if !ok(self.web_search_per_thousand) || !ok(self.web_fetch_per_thousand) {
            return Err("web search / fetch prices must be numbers of zero or more".into());
        }
        for (g, m) in &self.geo_multipliers {
            if !ok(*m) {
                return Err(format!("geo multiplier for \"{g}\" must be a number of zero or more"));
            }
        }
        for (id, m) in &self.models {
            let mut vals = vec![m.input, m.output, m.cache_write5m, m.cache_write1h, m.cache_read];
            if let Some(f) = &m.fast {
                vals.extend([f.input, f.output]);
            }
            if let Some(l) = &m.long_context {
                vals.extend([l.input, l.output, l.cache_write5m, l.cache_write1h, l.cache_read]);
            }
            if vals.iter().any(|v| !ok(*v)) {
                return Err(format!("prices for \"{id}\" must be numbers of zero or more"));
            }
        }
        Ok(())
    }

    /// Exact id, or an id listed as an alias (D22).
    pub fn model(&self, id: &str) -> Option<&ModelPrice> {
        self.models.get(id).or_else(|| self.alias_index.get(id).and_then(|c| self.models.get(c)))
    }

    pub fn is_known(&self, id: &str) -> bool {
        self.model(id).is_some()
    }

    /// Long-context flag for a request, decided from the prompt size (D24).
    pub fn price_tier(&self, model: &str, c: &Counts) -> i64 {
        let threshold = self
            .model(model)
            .and_then(|m| m.long_context.as_ref().map(|l| l.threshold_tokens))
            .unwrap_or(DEFAULT_LONG_CONTEXT_TOKENS);
        i64::from(c.prompt() > threshold)
    }

    /// Everything `price_tier` depends on. Equal signatures mean no stored tier can change.
    pub fn tier_signature(&self) -> Vec<(String, u64)> {
        let mut v: Vec<(String, u64)> = self
            .models
            .iter()
            .map(|(id, m)| (id.clone(), m.long_context.as_ref().map_or(0, |l| l.threshold_tokens)))
            .collect();
        v.extend(self.alias_index.iter().map(|(a, id)| (format!("{a}={id}"), 0)));
        v.sort();
        v
    }

    /// Dollars for the row, or `None` when it cannot be priced exactly.
    pub fn cost(&self, b: &Basis, c: &Counts) -> Option<f64> {
        let m = self.model(b.model)?;
        let tier = if b.service_tier.is_empty() { "standard" } else { b.service_tier };
        if !self.service_tiers.iter().any(|t| t == tier) {
            return None;
        }
        // "not_available" is what the API reports when the model has no geo control (28 % of the
        // rows on Will's PC): billed like global, as Claude Code does.
        let geo = if b.geo.is_empty() || b.geo == "not_available" { "global" } else { b.geo };
        let geo_mult = *self.geo_multipliers.get(geo)?;
        let (mut pin, mut pout, mut w5, mut w1, mut pr) = if b.price_tier == 1 {
            match &m.long_context {
                Some(l) => (l.input, l.output, l.cache_write5m, l.cache_write1h, l.cache_read),
                None => (m.input, m.output, m.cache_write5m, m.cache_write1h, m.cache_read),
            }
        } else {
            (m.input, m.output, m.cache_write5m, m.cache_write1h, m.cache_read)
        };
        match b.speed {
            "" | "standard" => {}
            "fast" => {
                let f = m.fast.as_ref()?;
                // Caching multipliers stack on fast mode: scale the cache rates by
                // the same ratio as the base rates.
                let ratio = if pin > 0.0 { f.input / pin } else { 1.0 };
                pin = f.input;
                pout = f.output;
                w5 *= ratio;
                w1 *= ratio;
                pr *= ratio;
            }
            _ => return None,
        }
        let tokens = (c.input as f64 * pin
            + c.output as f64 * pout
            + c.cw5m as f64 * w5
            + c.cw1h as f64 * w1
            + c.cr as f64 * pr)
            / 1_000_000.0
            * geo_mult;
        let web = c.web_search as f64 * self.web_search_per_thousand / 1000.0;
        Some(tokens + web)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basis<'a>(model: &'a str, speed: &'a str, geo: &'a str, tier: &'a str, pt: i64) -> Basis<'a> {
        Basis { model, speed, geo, service_tier: tier, price_tier: pt }
    }
    fn c(i: u64, o: u64) -> Counts {
        Counts { input: i, output: o, ..Default::default() }
    }

    #[test]
    fn seed_is_valid_and_sourced() {
        let t = PriceTable::seed();
        assert_eq!(t.updated, "2026-11-09", "prices as of");
        for (id, m) in &t.models {
            assert!(m.source.starts_with("https://"), "{id} has no source");
        }
    }

    /// Every row of the official table (platform.claude.com pricing page, read 2026-11-09):
    /// input, output, 5m write, 1h write, cache read, then fast input/output when it has one.
    #[test]
    fn seed_matches_the_official_table() {
        type Row = (&'static str, [f64; 5], Option<(f64, f64)>);
        let rows: [Row; 20] = [
            ("claude-fable-5-2", [8.0, 40.0, 10.0, 16.0, 0.2], Some((16.0, 80.0))),
            ("claude-mythos-5-2", [8.0, 40.0, 10.0, 16.0, 0.2], Some((16.0, 80.0))),
            ("claude-fable-5-1", [10.0, 50.0, 12.5, 20.0, 0.25], None),
            ("claude-mythos-5-1", [10.0, 50.0, 12.5, 20.0, 0.25], None),
            ("claude-fable-5", [10.0, 50.0, 12.5, 20.0, 1.0], None),
            ("claude-mythos-5", [10.0, 50.0, 12.5, 20.0, 1.0], None),
            ("claude-opus-5-5", [4.0, 20.0, 5.0, 8.0, 0.2], Some((8.0, 40.0))),
            ("claude-opus-5", [5.0, 25.0, 6.25, 10.0, 0.5], Some((10.0, 50.0))),
            ("claude-opus-4-8", [5.0, 25.0, 6.25, 10.0, 0.5], Some((10.0, 50.0))),
            ("claude-opus-4-7", [5.0, 25.0, 6.25, 10.0, 0.5], None),
            ("claude-opus-4-6", [5.0, 25.0, 6.25, 10.0, 0.5], None),
            ("claude-opus-4-5-20251101", [5.0, 25.0, 6.25, 10.0, 0.5], None),
            ("claude-opus-4-1-20250805", [15.0, 75.0, 18.75, 30.0, 1.5], None),
            ("claude-opus-4-20250514", [15.0, 75.0, 18.75, 30.0, 1.5], None),
            ("claude-sonnet-5-5", [2.0, 10.0, 2.5, 4.0, 0.1], None),
            ("claude-sonnet-5", [2.0, 10.0, 2.5, 4.0, 0.2], None),
            ("claude-sonnet-4-6", [3.0, 15.0, 3.75, 6.0, 0.3], None),
            ("claude-sonnet-4-5-20250929", [3.0, 15.0, 3.75, 6.0, 0.3], None),
            ("claude-haiku-5-5", [0.1, 0.5, 0.125, 0.2, 0.01], None),
            ("claude-haiku-4-5-20251001", [1.0, 5.0, 1.25, 2.0, 0.1], None),
        ];
        assert_eq!(t_len(), rows.len(), "a model was added or dropped without updating this table");
        let t = PriceTable::seed();
        for (id, p, fast) in rows {
            let b = basis(id, "standard", "global", "standard", 0);
            let one = |x: Counts| t.cost(&b, &x).unwrap_or_else(|| panic!("{id} is not priced"));
            let mtok = 1_000_000;
            let got = [
                one(Counts { input: mtok, ..Default::default() }),
                one(Counts { output: mtok, ..Default::default() }),
                one(Counts { cw5m: mtok, ..Default::default() }),
                one(Counts { cw1h: mtok, ..Default::default() }),
                one(Counts { cr: mtok, ..Default::default() }),
            ];
            for (g, w) in got.iter().zip(p) {
                assert!((g - w).abs() < 1e-9, "{id}: {got:?} != {p:?}");
            }
            let fb = basis(id, "fast", "global", "standard", 0);
            match fast {
                Some((fi, fo)) => {
                    assert!((t.cost(&fb, &c(mtok, 0)).unwrap() - fi).abs() < 1e-9, "{id} fast input");
                    assert!((t.cost(&fb, &c(0, mtok)).unwrap() - fo).abs() < 1e-9, "{id} fast output");
                }
                None => assert!(t.cost(&fb, &c(1, 1)).is_none(), "{id} has no fast mode"),
            }
        }
    }

    fn t_len() -> usize {
        PriceTable::seed().models.len()
    }

    #[test]
    fn fable_5_2_fast_stacks_with_us_and_cache() {
        let t = PriceTable::seed();
        let b = basis("claude-fable-5-2", "fast", "us", "standard", 0);
        // Fast doubles every category (16/80 over 8/40), then US adds 10 %.
        let x = Counts { input: 1_000_000, output: 1_000_000, cw5m: 1_000_000, cr: 1_000_000, ..Default::default() };
        let want = (16.0 + 80.0 + 20.0 + 0.4) * 1.1;
        assert!((t.cost(&b, &x).unwrap() - want).abs() < 1e-9, "{:?}", t.cost(&b, &x));
    }

    #[test]
    fn plain_and_modifiers() {
        let t = PriceTable::seed();
        let std = basis("claude-opus-5-5", "standard", "global", "standard", 0);
        assert!((t.cost(&std, &c(1000, 1000)).unwrap() - 0.024).abs() < 1e-12);
        let fast = basis("claude-opus-5-5", "fast", "global", "standard", 0);
        assert!((t.cost(&fast, &c(1000, 1000)).unwrap() - 0.048).abs() < 1e-12);
        let us = basis("claude-opus-5-5", "standard", "us", "standard", 0);
        assert!((t.cost(&us, &c(1000, 1000)).unwrap() - 0.0264).abs() < 1e-12);
        let mut ws = c(0, 0);
        ws.web_search = 3;
        assert!((t.cost(&std, &ws).unwrap() - 0.03).abs() < 1e-12);
        let prio = basis("claude-opus-5-5", "standard", "global", "priority", 0);
        assert!(t.cost(&prio, &c(1000, 1000)).is_none());
        let no_fast = basis("claude-sonnet-5-5", "fast", "global", "standard", 0);
        assert!(t.cost(&no_fast, &c(1, 1)).is_none());
    }

    #[test]
    fn model_match_is_exact() {
        let t = PriceTable::seed();
        assert!(t.is_known("claude-opus-5-5"));
        assert!(!t.is_known("claude-opus-5-5-20261001"));
        assert!(!t.is_known("claude-opus"));
        assert!(!t.is_known("claude-nova-9"));
    }

    #[test]
    fn haiku_long_context_boundary() {
        let t = PriceTable::seed();
        let mut x = Counts { input: 90_000, cr: 20_000, output: 1_000, ..Default::default() };
        let tier = t.price_tier("claude-haiku-5-5", &x);
        assert_eq!(tier, 1);
        let b = basis("claude-haiku-5-5", "standard", "global", "standard", tier);
        assert!((t.cost(&b, &x).unwrap() - 0.0485).abs() < 1e-12);
        x.input = 80_000; // prompt exactly 100,000
        let tier = t.price_tier("claude-haiku-5-5", &x);
        assert_eq!(tier, 0);
    }

    #[test]
    fn geo_not_available_bills_as_global() {
        let t = PriceTable::seed();
        let g = basis("claude-opus-5-5", "standard", "global", "standard", 0);
        let na = basis("claude-opus-5-5", "standard", "not_available", "standard", 0);
        let empty = basis("claude-opus-5-5", "standard", "", "standard", 0);
        let want = t.cost(&g, &c(1000, 1000)).unwrap();
        assert_eq!(t.cost(&na, &c(1000, 1000)), Some(want));
        assert_eq!(t.cost(&empty, &c(1000, 1000)), Some(want));
        let unknown = basis("claude-opus-5-5", "standard", "mars", "standard", 0);
        assert!(t.cost(&unknown, &c(1, 1)).is_none());
    }

    #[test]
    fn dated_haiku_4_5_alias_is_priced() {
        let t = PriceTable::seed();
        assert!(t.is_known("claude-haiku-4-5-20251001"));
        let a = basis("claude-haiku-4-5-20251001", "standard", "global", "standard", 0);
        let b = basis("claude-haiku-4-5", "standard", "global", "standard", 0);
        assert_eq!(t.cost(&a, &c(1000, 1000)), t.cost(&b, &c(1000, 1000)));
    }

    #[test]
    fn tier_signature_moves_with_the_threshold_only() {
        let a = PriceTable::seed();
        let mut b = a.clone();
        assert_eq!(a.tier_signature(), b.tier_signature());
        b.models.get_mut("claude-opus-5-5").unwrap().input = 9.0; // a price edit, not a tier edit
        assert_eq!(a.tier_signature(), b.tier_signature());
        b.models.get_mut("claude-haiku-5-5").unwrap().long_context.as_mut().unwrap().threshold_tokens = 50_000;
        assert_ne!(a.tier_signature(), b.tier_signature());
    }

    #[test]
    fn rejects_bad_tables() {
        assert!(PriceTable::parse("{").is_err());
        let mut v: serde_json::Value = serde_json::from_str(SEED_JSON).unwrap();
        v["models"]["claude-opus-5-5"]["input"] = serde_json::json!(-1);
        assert!(PriceTable::parse(&v.to_string()).is_err());
    }
}
