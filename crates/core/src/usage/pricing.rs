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

    /// Dollars for the row, or `None` when it cannot be priced exactly.
    pub fn cost(&self, b: &Basis, c: &Counts) -> Option<f64> {
        let m = self.model(b.model)?;
        let tier = if b.service_tier.is_empty() { "standard" } else { b.service_tier };
        if !self.service_tiers.iter().any(|t| t == tier) {
            return None;
        }
        let geo = if b.geo.is_empty() { "global" } else { b.geo };
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
        assert_eq!(t.updated, "2026-11-08");
        for (id, m) in &t.models {
            assert!(m.source.starts_with("https://"), "{id} has no source");
        }
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
    fn rejects_bad_tables() {
        assert!(PriceTable::parse("{").is_err());
        let mut v: serde_json::Value = serde_json::from_str(SEED_JSON).unwrap();
        v["models"]["claude-opus-5-5"]["input"] = serde_json::json!(-1);
        assert!(PriceTable::parse(&v.to_string()).is_err());
    }
}
