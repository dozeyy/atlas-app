//! Grouping near-identical short texts for the review themes (`usage::scorecard`,
//! `docs/specs/agent-scorecard.md` D14). It reuses the repeated-request finder's pieces
//! (`habits::normalize`, and the shingles, MinHash bands and overlap bar of `habits::cluster`), so
//! "the same text in other words" means one thing across Atlas. Deterministic: no model, no network.
//!
//! The one difference from the finder is `normalize_finding`: a finding names code in backticks
//! (`winframe.rs:699`, `remove_made`), and that is what tells two findings apart, so the code spans
//! are kept instead of being replaced by one placeholder word.

use std::collections::{BTreeMap, HashMap};

use crate::habits::cluster::{band_keys, id16, overlap, seeds, shingles, JACCARD_PCT};
use crate::habits::normalize::normalize;

/// A finding's text as a comparable string: the finder's normalization with code spans kept.
pub fn normalize_finding(text: &str) -> String {
    normalize(&text.replace('`', " "))
}

/// A group of texts and the leader that named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Cluster {
    /// First 16 hex of the SHA-256 of the leader's normalized text (the finder's group id).
    pub id: String,
    pub leader_norm: String,
    /// Indices into the input, ascending.
    pub members: Vec<usize>,
}

/// Cluster `(normalized text, time)` entries at the finder's overlap bar. Leaders are made in order
/// of exact-duplicate count, then newest, then text (the finder's order), and a text joins the first
/// leader it overlaps with; no chaining. The result does not depend on the order of `entries`
/// except through the time tie-break.
pub fn cluster(entries: &[(String, i64)]) -> Vec<Cluster> {
    let mut uniq: BTreeMap<&str, (usize, i64, Vec<usize>)> = BTreeMap::new();
    for (i, (norm, ts)) in entries.iter().enumerate() {
        let e = uniq.entry(norm.as_str()).or_insert((0, i64::MIN, Vec::new()));
        e.0 += 1;
        e.1 = e.1.max(*ts);
        e.2.push(i);
    }
    let mut order: Vec<(&str, usize, i64, Vec<usize>)> = uniq.into_iter().map(|(k, (n, ts, idx))| (k, n, ts, idx)).collect();
    order.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.cmp(&a.2)).then(a.0.cmp(b.0)));

    struct Leader {
        norm: String,
        sh: Vec<u64>,
        members: Vec<usize>,
    }
    let seeds = seeds();
    let mut leaders: Vec<Leader> = Vec::new();
    let mut buckets: HashMap<(usize, u64), Vec<usize>> = HashMap::new();
    for (norm, _, _, idx) in order {
        let sh = shingles(norm);
        let keys = band_keys(&sh, &seeds);
        let mut cands: Vec<usize> = keys.iter().enumerate().filter_map(|(b, k)| buckets.get(&(b, *k))).flatten().copied().collect();
        cands.sort_unstable();
        cands.dedup();
        let hit = cands.into_iter().find(|&l| {
            let (inter, union) = overlap(&sh, &leaders[l].sh);
            inter * 100 >= JACCARD_PCT * union
        });
        match hit {
            Some(l) => leaders[l].members.extend(idx),
            None => {
                let l = leaders.len();
                for (b, k) in keys.iter().enumerate() {
                    buckets.entry((b, *k)).or_default().push(l);
                }
                leaders.push(Leader { norm: norm.to_string(), sh, members: idx });
            }
        }
    }
    leaders
        .into_iter()
        .map(|mut l| {
            l.members.sort_unstable();
            Cluster { id: id16(&l.norm), leader_norm: l.norm, members: l.members }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_spans_stay_in_a_finding_and_numbers_do_not() {
        assert_eq!(normalize_finding("The loop in `remove_made` retries 3 times"), "the loop in remove made retries n times");
        assert_ne!(normalize_finding("`a_one` is wrong"), normalize_finding("`b_two` is wrong"));
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
        let entries: Vec<(String, i64)> = texts.iter().enumerate().map(|(i, t)| (normalize_finding(t), i as i64)).collect();
        let c = cluster(&entries);
        assert_eq!(c.len(), 3, "{c:?}");
        let retry = c.iter().find(|g| g.members.contains(&0)).unwrap();
        assert_eq!(retry.members, vec![0, 1, 2, 3]);
        assert!(c.iter().any(|g| g.members == vec![4]) && c.iter().any(|g| g.members == vec![5]));
        assert_eq!(c, cluster(&entries));
        assert_eq!(retry.id.len(), 16);
        assert_eq!(retry.id, id16(&retry.leader_norm));
    }

    #[test]
    fn exact_duplicates_make_the_leader_and_ties_go_to_the_newest() {
        let entries = vec![("beta thing here".to_string(), 5), ("alpha thing here".to_string(), 1), ("beta thing here".to_string(), 9)];
        let c = cluster(&entries);
        assert_eq!(c[0].leader_norm, "beta thing here");
        assert_eq!(c[0].members, vec![0, 2]);
    }

    #[test]
    fn short_and_empty_texts_are_safe() {
        let entries = vec![("ab".to_string(), 1), ("".to_string(), 2), ("ab".to_string(), 3)];
        let c = cluster(&entries);
        assert_eq!(c.iter().map(|x| x.members.len()).sum::<usize>(), 3);
    }
}
