//! Dev probe: for every (session, model) where the transcript tokens equal Claude Code's own
//! `cost-state.modelUsage` tokens, price the cached `session_model` rows with Atlas's table and
//! compare with the `costUSD` Claude Code wrote. Same tokens in, so any gap is the price table
//! or the formula, not the data.
//! Usage: cost_probe <rows.json> <cache.sqlite>
use atlas_core::usage::pricing::{Basis, Counts, PriceTable};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::BTreeMap;

fn main() {
    let mut a = std::env::args().skip(1);
    let rows: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(a.next().unwrap()).unwrap()).unwrap();
    let conn = Connection::open_with_flags(a.next().unwrap(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let published = PriceTable::seed();
    // Claude Code's own table as observed in its costUSD: Haiku 5.5 at Opus 5.5 rates, Sonnet 5.5 cache reads at 0.1x.
    let mut observed = published.clone();
    let opus = observed.models["claude-opus-5-5"].clone();
    observed.models.insert("claude-haiku-5-5".into(), opus);
    observed.models.get_mut("claude-sonnet-5-5").unwrap().cache_read = 0.2;
    for (label, t) in [("published prices", &published), ("Claude Code's observed prices", &observed)] {
    println!("== {label}");
    let mut q = conn
        .prepare(
            "SELECT speed, geo, service_tier, price_tier, SUM(input), SUM(output), SUM(cw5m), SUM(cw1h), SUM(cr), SUM(web_search) \
             FROM session_model WHERE session_id=?1 AND model=?2 GROUP BY speed, geo, service_tier, price_tier",
        )
        .unwrap();
    // model -> (rows, atlas, cc, rows over 2 %, unpriced)
    let mut by_model: BTreeMap<String, (usize, f64, f64, usize, usize)> = BTreeMap::new();
    let mut bad = Vec::new();
    for r in rows.iter().filter(|r| r["eq"].as_bool() == Some(true)) {
        let sid = r["sid"].as_str().unwrap();
        let model = r["model"].as_str().unwrap();
        let cc = r["cost"].as_f64().unwrap_or(0.0);
        let parts: Vec<(String, String, String, i64, [u64; 6])> = q
            .query_map([sid, model], |x| {
                let g = |i: usize| x.get::<_, Option<i64>>(i).map(|v| v.unwrap_or(0) as u64);
                Ok((x.get(0)?, x.get(1)?, x.get(2)?, x.get(3)?, [g(4)?, g(5)?, g(6)?, g(7)?, g(8)?, g(9)?]))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let e = by_model.entry(model.to_string()).or_default();
        e.0 += 1;
        e.2 += cc;
        let mut est = 0.0;
        let mut ok = true;
        let mut tiers = String::new();
        for (speed, geo, tier, pt, v) in &parts {
            let c = Counts { input: v[0], output: v[1], cw5m: v[2], cw1h: v[3], cr: v[4], web_search: v[5] };
            let b = Basis { model, speed, geo, service_tier: tier, price_tier: *pt };
            match t.cost(&b, &c) {
                Some(x) => est += x,
                None => ok = false,
            }
            tiers.push_str(&format!("[speed={speed} geo={geo} tier={tier} pt={pt} in={} out={} cw5={} cw1={} cr={}]", v[0], v[1], v[2], v[3], v[4]));
        }
        if !ok || parts.is_empty() {
            e.4 += 1;
            bad.push((model.to_string(), sid.to_string(), f64::NAN, cc, tiers));
            continue;
        }
        e.1 += est;
        if cc > 0.0 && ((est - cc) / cc).abs() > 0.02 {
            e.3 += 1;
            bad.push((model.to_string(), sid.to_string(), est, cc, tiers));
        }
    }
    println!("{:<30} {:>5} {:>10} {:>10} {:>8} {:>6} {:>8}", "model", "rows", "atlas $", "cc $", "ratio", ">2%", "unpriced");
    for (m, (n, a, c, over, unp)) in &by_model {
        println!("{m:<30} {n:>5} {a:>10.2} {c:>10.2} {:>8.4} {over:>6} {unp:>8}", if *c > 0.0 { a / c } else { 0.0 });
    }
    bad.sort_by(|a, b| {
        let da = if a.2.is_nan() { f64::MAX } else { (a.2 - a.3).abs() };
        let db = if b.2.is_nan() { f64::MAX } else { (b.2 - b.3).abs() };
        db.partial_cmp(&da).unwrap()
    });
    for (m, sid, x, cc, tiers) in bad.iter().filter(|b| !b.0.contains("haiku")).take(14) {
        println!("{m} {} atlas {x:.4} cc {cc:.4} {tiers}", &sid[..8]);
    }
    }
}
