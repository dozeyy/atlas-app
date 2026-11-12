//! How many people installed each plugin, and the order the Library lists them in.
//!
//! The counts are Claude Code's own: it keeps `plugins/plugin-catalog-cache.json` in the config
//! folder (a copy of the official catalog with token costs), and each plugin in it carries
//! `unique_installs`, keyed by plugin id (`name@claude-plugins-official`). Only that marketplace
//! has them. Atlas reads the file, never asks the network, and never writes it. A plugin with no
//! count (every other marketplace, the built-in directory) simply has none.
//!
//! The order is decided once per load, here, so the first rows sent are the rows the page keeps:
//! the catalog's own order (the built-in directory before the marketplaces the user added), then,
//! when counts exist, a stable sort on top of it: most installs first, plugins with no count after
//! them in catalog order, ties in catalog order.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use serde::Deserialize;
use serde_json::Value;

use super::catalog::{Entry, DIRECTORY};

/// Plugin id -> unique installs.
pub type Installs = HashMap<String, u64>;

/// The real file is about half a megabyte; anything past this is not Claude Code's cache.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// A count above this is not a count (a float that big has lost whole numbers anyway); it is
/// dropped, integer or float alike, so no sort or label ever sees an absurd figure.
const MAX_COUNT: u64 = 9_000_000_000_000_000;

#[derive(Deserialize)]
struct CacheFile {
    catalog: Option<Catalog>,
}

#[derive(Deserialize)]
struct Catalog {
    #[serde(default)]
    plugins: HashMap<String, PluginCount>,
}

#[derive(Deserialize)]
struct PluginCount {
    /// Read as a loose value: one plugin with a count in some other shape must not cost the rest.
    #[serde(default)]
    unique_installs: Option<Value>,
}

/// A count out of whatever the file holds: a whole non-negative number up to `MAX_COUNT` (a float
/// is rounded), nothing else.
fn count_of(v: &Value) -> Option<u64> {
    let n = match v.as_u64() {
        Some(n) => n,
        None => v.as_f64().filter(|f| f.is_finite() && *f >= 0.0 && *f < MAX_COUNT as f64).map(|f| f.round() as u64)?,
    };
    (n <= MAX_COUNT).then_some(n)
}

/// The parse of a cache file, kept while the file's modified time and size stay the same:
/// the Library asks on every catalog call (the first rows, then the whole list), and the file is
/// not worth parsing twice.
struct Parsed {
    modified: Option<SystemTime>,
    len: u64,
    installs: Arc<Installs>,
}

/// One entry per config folder the app has read (one in practice; a few in tests).
static LAST: Mutex<Option<HashMap<PathBuf, Parsed>>> = Mutex::new(None);

/// The counts Claude Code keeps in `<config_dir>/plugins/plugin-catalog-cache.json`. Empty when
/// the file is missing, too big, or not in the shape Atlas knows: the Library then lists in
/// catalog order, as it always did.
pub fn read(config_dir: &Path) -> Arc<Installs> {
    let file = config_dir.join("plugins").join("plugin-catalog-cache.json");
    let Ok(md) = fs::metadata(&file) else { return Arc::default() };
    if !md.is_file() || md.len() > MAX_BYTES {
        return Arc::default();
    }
    let modified = md.modified().ok();
    if let Some(last) = LAST.lock().ok().and_then(|g| g.as_ref().and_then(|m| m.get(&file)).filter(|p| p.modified == modified && p.len == md.len()).map(|p| p.installs.clone())) {
        return last;
    }
    let Ok(bytes) = fs::read(&file) else { return Arc::default() };
    let installs = Arc::new(parse(&bytes));
    if let Ok(mut g) = LAST.lock() {
        let m = g.get_or_insert_with(HashMap::new);
        if m.len() >= 8 {
            m.clear();
        }
        m.insert(file, Parsed { modified, len: md.len(), installs: installs.clone() });
    }
    installs
}

fn parse(bytes: &[u8]) -> Installs {
    let bytes = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
    let Ok(f) = serde_json::from_slice::<CacheFile>(bytes) else { return Installs::new() };
    f.catalog
        .map(|c| c.plugins.into_iter().filter_map(|(id, p)| p.unique_installs.as_ref().and_then(count_of).map(|n| (id, n))).collect())
        .unwrap_or_default()
}

/// One catalog row with its place in the catalog and its count.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub entry: Entry,
    pub installs: Option<u64>,
    /// Where the catalog itself lists it (0 first): "Catalog order" sorts on this.
    pub pos: u32,
}

/// The catalog's own order: the built-in directory (its own ranking) before the marketplaces the
/// user added, each keeping the order it was listed in.
pub fn catalog_order(entries: Vec<Entry>) -> Vec<Entry> {
    let (first, rest): (Vec<Entry>, Vec<Entry>) = entries.into_iter().partition(|e| e.marketplace == DIRECTORY);
    first.into_iter().chain(rest).collect()
}

/// More installs first; a plugin with no count after every plugin that has one; equal otherwise.
pub fn by_installs(a: Option<u64>, b: Option<u64>) -> std::cmp::Ordering {
    match (a, b) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    }
}

/// The catalog with counts attached, in the order the Library opens in: most installs first when
/// any plugin has a count, else catalog order. The sort is stable, so equal counts and every
/// plugin without one keep the catalog's order.
pub fn listing(entries: Vec<Entry>, installs: &Installs) -> Vec<Listed> {
    let mut out: Vec<Listed> =
        catalog_order(entries).into_iter().enumerate().map(|(i, entry)| Listed { installs: installs.get(&entry.plugin_id).copied(), entry, pos: i as u32 }).collect();
    if out.iter().any(|l| l.installs.is_some()) {
        out.sort_by(|a, b| by_installs(a.installs, b.installs));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::catalog::Source;

    fn e(name: &str, mp: &str) -> Entry {
        Entry { plugin_id: format!("{name}@{mp}"), name: name.into(), description: String::new(), marketplace: mp.into(), version: String::new(), source: Source::Command }
    }

    fn names(l: &[Listed]) -> Vec<&str> {
        l.iter().map(|x| x.entry.name.as_str()).collect()
    }

    fn counts(pairs: &[(&str, u64)]) -> Installs {
        pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect()
    }

    #[test]
    fn the_counts_come_from_unique_installs_by_plugin_id() {
        let json = r#"{"version":1,"fetchedAt":"x","catalog":{"installs_generated_at":"2026-10-16","plugins":{
            "a@claude-plugins-official":{"plugin":"a","unique_installs":12000,"tokens":{"m":{"always_on":1}},"components":{"skills":[]}},
            "b@claude-plugins-official":{"plugin":"b","unique_installs":0},
            "c@claude-plugins-official":{"plugin":"c","unique_installs":null},
            "d@claude-plugins-official":{"plugin":"d"},
            "e@claude-plugins-official":{"plugin":"e","unique_installs":"lots"},
            "f@claude-plugins-official":{"plugin":"f","unique_installs":-4},
            "g@claude-plugins-official":{"plugin":"g","unique_installs":1500.6}}}}"#;
        let got = parse(json.as_bytes());
        assert_eq!(got.len(), 3, "{got:?}");
        assert_eq!(got["a@claude-plugins-official"], 12000);
        assert_eq!(got["b@claude-plugins-official"], 0);
        assert_eq!(got["g@claude-plugins-official"], 1501);
        // A byte order mark is skipped; a file in another shape is no counts, never an error.
        assert_eq!(parse(&[b"\xef\xbb\xbf".as_slice(), json.as_bytes()].concat()).len(), 3);
        for bad in ["", "not json", "[]", r#"{"catalog":{"plugins":[]}}"#, r#"{"catalog":null}"#, r#"{"version":2}"#] {
            assert!(parse(bad.as_bytes()).is_empty(), "{bad}");
        }
    }

    #[test]
    fn the_file_is_read_from_the_config_folders_plugins() {
        let t = tempfile::tempdir().unwrap();
        assert!(read(t.path()).is_empty(), "no file, no counts");
        fs::create_dir_all(t.path().join("plugins")).unwrap();
        fs::write(t.path().join("plugins/plugin-catalog-cache.json"), r#"{"catalog":{"plugins":{"a@m":{"unique_installs":7}}}}"#).unwrap();
        assert_eq!(read(t.path())["a@m"], 7);
    }

    #[test]
    fn a_file_that_is_too_big_or_not_a_file_is_no_counts() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("plugins")).unwrap();
        let cache = t.path().join("plugins/plugin-catalog-cache.json");
        // A folder at the cache path.
        fs::create_dir(&cache).unwrap();
        assert!(read(t.path()).is_empty());
        fs::remove_dir(&cache).unwrap();
        // A real cache, padded past the ceiling.
        let mut big = br#"{"catalog":{"plugins":{"a@m":{"unique_installs":7}}}}"#.to_vec();
        big.resize(MAX_BYTES as usize + 1, b' ');
        fs::write(&cache, &big).unwrap();
        assert!(read(t.path()).is_empty(), "over the ceiling");
        big.truncate(MAX_BYTES as usize);
        fs::write(&cache, &big).unwrap();
        assert_eq!(read(t.path())["a@m"], 7, "at the ceiling it is still read");
    }

    #[test]
    fn a_count_past_the_ceiling_is_dropped_whatever_its_type() {
        let json = format!(
            r#"{{"catalog":{{"plugins":{{"max@m":{{"unique_installs":{}}},"big@m":{{"unique_installs":{}}},"edge@m":{{"unique_installs":{MAX_COUNT}}},"float@m":{{"unique_installs":1e300}},"ok@m":{{"unique_installs":3}}}}}}}}"#,
            u64::MAX,
            MAX_COUNT + 1
        );
        let got = parse(json.as_bytes());
        assert_eq!(got.len(), 2, "{got:?}");
        assert_eq!((got["edge@m"], got["ok@m"]), (MAX_COUNT, 3));
    }

    #[test]
    fn the_parse_is_kept_until_the_file_changes() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("plugins")).unwrap();
        let cache = t.path().join("plugins/plugin-catalog-cache.json");
        fs::write(&cache, r#"{"catalog":{"plugins":{"a@m":{"unique_installs":7}}}}"#).unwrap();
        let (a, b) = (read(t.path()), read(t.path()));
        assert!(Arc::ptr_eq(&a, &b), "the second ask reuses the first parse");
        // A rewrite with a different size is read again.
        fs::write(&cache, r#"{"catalog":{"plugins":{"a@m":{"unique_installs":7},"b@m":{"unique_installs":9}}}}"#).unwrap();
        let c = read(t.path());
        assert_eq!((c.len(), c["b@m"]), (2, 9));
    }

    #[test]
    fn most_installs_first_then_no_count_in_catalog_order() {
        let entries = vec![e("dir-1", DIRECTORY), e("low", "official"), e("dir-2", DIRECTORY), e("high", "official"), e("none-added", "mine"), e("mid", "official")];
        let l = listing(entries, &counts(&[("low@official", 10), ("high@official", 9000), ("mid@official", 500)]));
        // Counted plugins by count; then the directory, then the marketplaces the user added, each in its own order.
        assert_eq!(names(&l), ["high", "mid", "low", "dir-1", "dir-2", "none-added"]);
        assert_eq!(l[0].installs, Some(9000));
        assert_eq!(l[3].installs, None);
        // The catalog position survives: "Catalog order" can put everything back.
        let mut by_pos = l.clone();
        by_pos.sort_by_key(|x| x.pos);
        assert_eq!(names(&by_pos), ["dir-1", "dir-2", "low", "high", "none-added", "mid"]);
    }

    #[test]
    fn ties_and_missing_counts_keep_the_catalog_order_and_the_sort_is_stable() {
        let entries = vec![e("t1", "o"), e("n1", "o"), e("t2", "o"), e("zero", "o"), e("t3", "o"), e("n2", "o")];
        let c = counts(&[("t1@o", 5), ("t2@o", 5), ("t3@o", 5), ("zero@o", 0)]);
        let once = listing(entries.clone(), &c);
        assert_eq!(names(&once), ["t1", "t2", "t3", "zero", "n1", "n2"], "equal counts in catalog order, a zero count still before no count");
        // The same input always gives the same rows (the page may ask twice: first page, then all).
        for _ in 0..5 {
            assert_eq!(listing(entries.clone(), &c), once);
        }
    }

    #[test]
    fn with_no_counts_the_order_is_the_catalog_order() {
        let entries = vec![e("m1", "mine"), e("d1", DIRECTORY), e("m2", "mine"), e("d2", DIRECTORY)];
        let l = listing(entries, &Installs::new());
        assert_eq!(names(&l), ["d1", "d2", "m1", "m2"]);
        assert_eq!(l.iter().map(|x| x.pos).collect::<Vec<_>>(), [0, 1, 2, 3]);
        // Counts for plugins that are not in the catalog change nothing.
        let l = listing(vec![e("a", "o")], &counts(&[("ghost@o", 99)]));
        assert_eq!((names(&l), l[0].installs), (vec!["a"], None));
    }

    #[test]
    fn a_big_catalog_sorts_in_a_few_milliseconds() {
        let entries: Vec<Entry> = (0..4000).map(|i| e(&format!("p{i}"), if i % 10 == 0 { "official" } else { DIRECTORY })).collect();
        let c: Installs = (0..4000).step_by(10).map(|i| (format!("p{i}@official"), (i * 7 % 1000) as u64)).collect();
        let t = std::time::Instant::now();
        let l = listing(entries, &c);
        let ms = t.elapsed().as_millis();
        // Roughly a millisecond in practice; the bound only catches a sort gone quadratic.
        assert!(ms < 1000, "{ms} ms");
        assert_eq!(l.len(), 4000);
        assert!(l[..400].iter().all(|x| x.installs.is_some()) && l[400..].iter().all(|x| x.installs.is_none()));
    }
}
