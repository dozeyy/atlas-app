//! Grouping near-identical short texts, deterministically: no model, no network, no randomness.
//!
//! Shared by the review themes (`usage::reviews`, `docs/specs/agent-scorecard.md` D14) and the
//! repeated-request finder (`docs/specs/skill-library.md` D32-D35). The steps:
//!
//! 1. `normalize`: lower-case, URLs -> `url`, paths -> `path`, numbers -> `n`, quoted or
//!    backticked spans -> `q`, other punctuation -> space, leading fillers dropped.
//! 2. Shingles: character 5-grams of the normalized text (a text under 5 characters is one shingle).
//! 3. MinHash with 64 fixed-seed hashes, LSH with 16 bands of 4 rows to find candidates.
//! 4. Leader clustering: unique texts in descending count (tie: newest, then text) each join the
//!    first leader whose exact shingle Jaccard reaches the threshold, else become a leader. No chaining.
//!
//! A group id is the first 16 hex characters of the SHA-256 of the leader's normalized text, so it
//! is stable across runs as long as the same leader wins. The threshold is passed in by the caller.

use std::collections::{BTreeMap, HashMap};

use sha2::{Digest, Sha256};

const FILLERS: &[&str] = &["please", "pls", "hey", "ok", "okay", "now", "claude"];
const FILLER_PAIRS: &[(&str, &str)] = &[("can", "you"), ("could", "you")];
const BANDS: usize = 16;
const ROWS: usize = 4;
const HASHES: usize = BANDS * ROWS;
const SHINGLE: usize = 5;

/// Replace quoted (`"..."`, `'...'`) and backticked spans with ` q `.
fn blank_quotes(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let opens = match c {
            '`' | '"' => true,
            // An apostrophe opens a quote only at a word start ("don't" and "it's" do not).
            '\'' => i == 0 || matches!(chars[i - 1], ' ' | '\t' | '(' | '[' | '{' | '\n'),
            _ => false,
        };
        if opens {
            let limit = (i + 1 + 240).min(chars.len());
            let close = (i + 1..limit).find(|&j| {
                chars[j] == c && (c != '\'' || chars.get(j + 1).is_none_or(|n| !n.is_alphanumeric()))
            });
            if let Some(j) = close {
                out.push_str(" q ");
                i = j + 1;
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

fn is_url(tok: &str) -> bool {
    let l = tok.to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://") || l.starts_with("www.") || l.starts_with("file://")
}

fn is_path(tok: &str) -> bool {
    if tok.contains('\\') || tok.starts_with("~/") {
        return true;
    }
    tok.contains('/') && tok.split('/').filter(|p| !p.is_empty()).count() >= 2
}

/// D32 normalization.
pub fn normalize(text: &str) -> String {
    let blanked = blank_quotes(text);
    let mut words: Vec<String> = Vec::new();
    for tok in blanked.split_whitespace() {
        if is_url(tok) {
            words.push("url".into());
            continue;
        }
        if is_path(tok) {
            words.push("path".into());
            continue;
        }
        let mut cur = String::new();
        let flush = |cur: &mut String, words: &mut Vec<String>| {
            if cur.is_empty() {
                return;
            }
            if cur.chars().all(|c| c.is_ascii_digit()) {
                words.push("n".into());
            } else {
                words.push(std::mem::take(cur));
            }
            cur.clear();
        };
        for c in tok.chars() {
            if c.is_alphanumeric() {
                cur.extend(c.to_lowercase());
            } else {
                flush(&mut cur, &mut words);
            }
        }
        flush(&mut cur, &mut words);
    }
    // Leading fillers, repeatedly.
    let mut start = 0;
    loop {
        match words.get(start..) {
            Some([a, b, ..]) if FILLER_PAIRS.iter().any(|(x, y)| a == x && b == y) => start += 2,
            Some([a, ..]) if FILLERS.contains(&a.as_str()) => start += 1,
            _ => break,
        }
    }
    words[start..].join(" ")
}

fn fnv(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

fn mix(mut x: u64) -> u64 {
    x ^= x >> 30;
    x = x.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x ^= x >> 27;
    x = x.wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

fn seed(i: usize) -> u64 {
    mix((i as u64).wrapping_add(0x9e37_79b9_7f4a_7c15))
}

/// The distinct hashed character 5-grams of a normalized text, sorted.
fn shingles(norm: &str) -> Vec<u64> {
    let chars: Vec<char> = norm.chars().collect();
    let mut out: Vec<u64> = Vec::new();
    if chars.is_empty() {
        return out;
    }
    if chars.len() < SHINGLE {
        out.push(fnv(norm.as_bytes()));
        return out;
    }
    let mut buf = String::new();
    for w in chars.windows(SHINGLE) {
        buf.clear();
        buf.extend(w);
        out.push(fnv(buf.as_bytes()));
    }
    out.sort_unstable();
    out.dedup();
    out
}

fn jaccard(a: &[u64], b: &[u64]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut both) = (0, 0, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                both += 1;
                i += 1;
                j += 1;
            }
        }
    }
    both as f64 / (a.len() + b.len() - both) as f64
}

fn signature(sh: &[u64]) -> [u64; HASHES] {
    let mut sig = [u64::MAX; HASHES];
    for (i, s) in sig.iter_mut().enumerate() {
        let sd = seed(i);
        for h in sh {
            let v = mix(h ^ sd);
            if v < *s {
                *s = v;
            }
        }
    }
    sig
}

fn band_keys(sig: &[u64; HASHES]) -> [u64; BANDS] {
    let mut keys = [0u64; BANDS];
    for (b, key) in keys.iter_mut().enumerate() {
        let mut h = mix(b as u64 + 1);
        for v in &sig[b * ROWS..(b + 1) * ROWS] {
            h = mix(h ^ v);
        }
        *key = h;
    }
    keys
}

/// A group of texts and the leader that named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cluster {
    /// First 16 hex of the SHA-256 of the leader's normalized text.
    pub id: String,
    pub leader_norm: String,
    /// Indices into the input, ascending.
    pub members: Vec<usize>,
}

pub fn group_id(leader_norm: &str) -> String {
    let d = Sha256::digest(leader_norm.as_bytes());
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Cluster `(normalized text, time)` entries at an exact-Jaccard `threshold`. The result is in the
/// order the leaders were made (largest exact-duplicate count first) and does not depend on the
/// order of `entries` except through the time tie-break.
pub fn cluster(entries: &[(String, i64)], threshold: f64) -> Vec<Cluster> {
    // Unique strings: how many, newest, which entries.
    let mut uniq: BTreeMap<&str, (usize, i64, Vec<usize>)> = BTreeMap::new();
    for (i, (norm, ts)) in entries.iter().enumerate() {
        let e = uniq.entry(norm.as_str()).or_insert((0, i64::MIN, Vec::new()));
        e.0 += 1;
        e.1 = e.1.max(*ts);
        e.2.push(i);
    }
    let mut order: Vec<(&str, usize, i64, Vec<usize>)> =
        uniq.into_iter().map(|(k, (n, ts, idx))| (k, n, ts, idx)).collect();
    order.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(b.0)));

    struct Leader {
        norm: String,
        sh: Vec<u64>,
        members: Vec<usize>,
    }
    let mut leaders: Vec<Leader> = Vec::new();
    let mut buckets: HashMap<(usize, u64), Vec<usize>> = HashMap::new();
    for (norm, _, _, idx) in order {
        let sh = shingles(norm);
        let keys = if sh.is_empty() { None } else { Some(band_keys(&signature(&sh))) };
        let mut cands: Vec<usize> = Vec::new();
        if let Some(keys) = &keys {
            for (b, k) in keys.iter().enumerate() {
                if let Some(v) = buckets.get(&(b, *k)) {
                    cands.extend(v);
                }
            }
            cands.sort_unstable();
            cands.dedup();
        }
        let hit = cands.into_iter().find(|&l| jaccard(&leaders[l].sh, &sh) >= threshold);
        match hit {
            Some(l) => leaders[l].members.extend(idx),
            None => {
                let l = leaders.len();
                if let Some(keys) = &keys {
                    for (b, k) in keys.iter().enumerate() {
                        buckets.entry((b, *k)).or_default().push(l);
                    }
                }
                leaders.push(Leader { norm: norm.to_string(), sh, members: idx });
            }
        }
    }
    leaders
        .into_iter()
        .map(|mut l| {
            l.members.sort_unstable();
            Cluster { id: group_id(&l.norm), leader_norm: l.norm, members: l.members }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizing_follows_the_rules() {
        assert_eq!(normalize("Please check https://example.com/a?b=1 now"), "check url now");
        assert_eq!(normalize("Can you fix C:\\x\\y.rs and src/net.rs:41"), "fix path and path");
        assert_eq!(normalize("the retry loop retries 3 times, in `loop_body`"), "the retry loop retries n times in q");
        assert_eq!(normalize("he said \"hello there\" twice"), "he said q twice");
        assert_eq!(normalize("don't skip it's fine"), "don t skip it s fine");
        assert_eq!(normalize("hey ok please claude do it"), "do it");
        assert_eq!(normalize("   "), "");
    }

    #[test]
    fn rewordings_group_and_unrelated_texts_do_not() {
        let texts = [
            "the retry loop never backs off between attempts",
            "retry loop never backs off between attempts",
            "the retry loop never backs off between the attempts",
            "the retry loop never backs off between attempts (src/net.rs:41)",
            "error text is swallowed in the request handler",
            "a completely different thing about colors in the theme",
        ];
        let entries: Vec<(String, i64)> = texts.iter().enumerate().map(|(i, t)| (normalize(t), i as i64)).collect();
        let c = cluster(&entries, 0.55);
        assert_eq!(c.len(), 3, "{c:?}");
        // Every text is its own duplicate count of 1, so the newest leads; the four rewordings still
        // end up in one group, and the two unrelated texts in their own.
        let retry = c.iter().find(|g| g.members.contains(&0)).unwrap();
        assert_eq!(retry.members, vec![0, 1, 2, 3]);
        assert!(c.iter().any(|g| g.members == vec![4]) && c.iter().any(|g| g.members == vec![5]));
        let again = cluster(&entries, 0.55);
        assert_eq!(c, again);
        assert_eq!(retry.id.len(), 16);
        assert_eq!(retry.id, group_id(&retry.leader_norm));
    }

    #[test]
    fn exact_duplicates_make_the_leader_and_ties_go_to_the_newest() {
        let entries = vec![("beta thing here".to_string(), 5), ("alpha thing here".to_string(), 1), ("beta thing here".to_string(), 9)];
        let c = cluster(&entries, 0.99);
        assert_eq!(c[0].leader_norm, "beta thing here");
        assert_eq!(c[0].members, vec![0, 2]);
        assert_eq!(c[1].members, vec![1]);
    }

    #[test]
    fn short_and_empty_texts_are_safe() {
        let entries = vec![("ab".to_string(), 1), ("".to_string(), 2), ("ab".to_string(), 3)];
        let c = cluster(&entries, 0.55);
        assert_eq!(c.iter().map(|x| x.members.len()).sum::<usize>(), 3);
    }
}
