//! Group typed requests that are the same ask in different words (D33-D35).
//!
//! Deterministic, no model, no network: normalized strings -> character 5-gram shingles ->
//! 64 fixed-seed MinHash values -> 16 bands x 4 rows of LSH to find candidates -> leader
//! clustering on the exact shingle Jaccard. The input order never matters: every ordering
//! below is fully tie-broken on the data itself.

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};

use super::normalize::normalize;
use crate::usage::time::Tz;

pub const SHINGLE: usize = 5;
pub const HASHES: usize = 64;
pub const BANDS: usize = 16;
pub const ROWS: usize = 4;
/// Two strings are the same ask when their shingle sets overlap at least this much (percent).
pub const JACCARD_PCT: usize = 55;
/// Other wordings returned with a group's representative.
pub const EXAMPLES: usize = 5;
/// Wordings kept per project in a group (the commonest first), for `Group::wordings_for`.
pub const WORDINGS_PER_PROJECT: usize = EXAMPLES + 1;
/// How many member ids a group carries, so a recorded answer survives a change of leader.
pub const MEMBER_IDS: usize = 100;
pub const TEXT_CAP: usize = 400;
const DAY_MS: i64 = 86_400_000;

/// When a repeated request is worth an offer. One place, easy to tune (D34, D52).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Thresholds {
    /// Asks in all past chats.
    pub count: usize,
    /// ...spread over this many chats.
    pub sessions: usize,
    /// ...on this many different days.
    pub days: usize,
    /// The group was last asked within this many days (the default of the `days` argument).
    pub window_days: i64,
    /// `like` may match a smaller group than the bar, so "have I asked this before?" has an
    /// answer. This is the smallest group it may match.
    pub like_count: usize,
    /// Asks of the same kind in one chat that are enough by themselves (the skill's rule).
    pub this_chat: usize,
}

impl Thresholds {
    pub const OFFER: Thresholds = Thresholds { count: 5, sessions: 3, days: 2, window_days: 90, like_count: 2, this_chat: 3 };
}

/// One typed prompt: the masked text from the index and where and when it was typed.
#[derive(Debug, Clone)]
pub struct Prompt {
    pub text: String,
    pub session: String,
    pub ts: i64,
    /// The folder the chat ran in.
    pub project: Option<String>,
}

/// One wording of a request and the folder name of the project it was typed in ("" when unknown).
#[derive(Debug, Clone, PartialEq)]
pub struct Wording {
    pub project: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Group {
    /// First 16 hex of sha256(leader's normalized text).
    pub id: String,
    pub leader: String,
    pub count: usize,
    pub sessions: usize,
    pub days: usize,
    /// Project folder names, most asked first.
    pub projects: Vec<String>,
    pub first_ms: i64,
    pub last_ms: i64,
    /// The most frequent original wording (tie: newest).
    pub representative: String,
    /// Other distinct wordings, newest first.
    pub examples: Vec<String>,
    /// The commonest wordings of each project, so text can be limited to one project.
    pub wordings: Vec<Wording>,
    /// `id16` of each distinct normalized member (leader included), commonest first.
    pub member_ids: Vec<String>,
    pub(crate) shingles: Vec<u64>,
}

impl Group {
    pub fn meets(&self, th: &Thresholds) -> bool {
        self.count >= th.count && self.sessions >= th.sessions && self.days >= th.days
    }

    /// The representative wording and other wordings to show, limited to what was typed in
    /// `project` (matched by folder name), or from every project when `all` is set. With neither,
    /// no text is returned: counts may span all projects, wordings never leave their project
    /// unless the person asks.
    pub fn wordings_for(&self, project: Option<&str>, all: bool) -> (Option<String>, Vec<String>) {
        let want = project.map(project_name).filter(|p| !p.is_empty());
        let mut seen: Vec<&str> = Vec::new();
        for w in &self.wordings {
            let ok = all || want.as_deref().is_some_and(|p| !w.project.is_empty() && w.project.eq_ignore_ascii_case(p));
            if ok && !seen.contains(&w.text.as_str()) {
                seen.push(w.text.as_str());
            }
        }
        let mut it = seen.into_iter().map(str::to_string);
        let representative = it.next();
        (representative, it.take(EXAMPLES).collect())
    }

    /// Every id a recorded answer may be filed under for this group.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.id.as_str()).chain(self.member_ids.iter().map(String::as_str))
    }
}

#[derive(Debug, Clone, Default)]
pub struct Grouping {
    /// Every group, biggest first (count, then last seen, then id).
    pub groups: Vec<Group>,
    pub prompts: usize,
}

impl Grouping {
    /// Groups at or above the bar, last asked within `window_days`, optionally of one project.
    pub fn qualifying<'a>(&'a self, th: &Thresholds, now_ms: i64, window_days: i64, project: Option<&str>) -> Vec<&'a Group> {
        let since = now_ms.saturating_sub(window_days.saturating_mul(DAY_MS));
        let wanted = project.map(project_name).map(|p| p.to_lowercase()).filter(|p| !p.is_empty());
        self.groups
            .iter()
            .filter(|g| g.meets(th) && g.last_ms >= since)
            .filter(|g| wanted.as_ref().is_none_or(|w| g.projects.iter().any(|p| p.to_lowercase().contains(w.as_str()))))
            .collect()
    }

    /// The group a request belongs to: the most similar leader at or above the overlap bar,
    /// among groups of at least `min_count` asks. Returns the similarity (0..1).
    ///
    /// This compares against every leader (exact overlap), while `group` only compares against
    /// the leaders that share an LSH band, which finds a pair at the bar about 8 times in 10 and
    /// a closer pair almost always. So a request can match a group here that it did not join
    /// when the groups were made: `like` is the more generous of the two, never the stricter.
    pub fn like(&self, text: &str, min_count: usize) -> Option<(&Group, f64)> {
        let norm = normalize(text);
        if norm.is_empty() {
            return None;
        }
        let sh = shingles(&norm);
        let mut best: Option<(&Group, usize, usize)> = None; // group, inter, union
        for g in self.groups.iter().filter(|g| g.count >= min_count) {
            let (inter, union) = overlap(&sh, &g.shingles);
            if inter * 100 < JACCARD_PCT * union {
                continue;
            }
            // Higher ratio wins; equal ratio keeps the earlier (bigger) group.
            if best.is_none_or(|(_, bi, bu)| inter * bu > bi * union) {
                best = Some((g, inter, union));
            }
        }
        best.map(|(g, i, u)| (g, ((i as f64 / u as f64) * 100.0).round() / 100.0))
    }

    pub fn by_id(&self, id: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }
}

/// First 16 hex characters of the sha256 of `s`.
pub fn id16(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// A project's folder name from its path (`C:\work\alpha` and `/work/alpha` are both `alpha`).
pub fn project_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

// ---------------------------------------------------------------- hashing

fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9E37_79B9_7F4A_7C15);
    x = (x ^ (x >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    x ^ (x >> 31)
}

fn hash_window(w: &[char]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for c in w {
        for b in (*c as u32).to_le_bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    mix(h)
}

/// The sorted, de-duplicated character 5-grams of `s`, hashed. A string shorter than five
/// characters is one shingle.
pub(crate) fn shingles(s: &str) -> Vec<u64> {
    let cs: Vec<char> = s.chars().collect();
    let mut v: Vec<u64> = if cs.len() < SHINGLE { vec![hash_window(&cs)] } else { cs.windows(SHINGLE).map(hash_window).collect() };
    v.sort_unstable();
    v.dedup();
    v
}

/// (intersection, union) sizes of two sorted shingle sets.
pub(crate) fn overlap(a: &[u64], b: &[u64]) -> (usize, usize) {
    let (mut i, mut j, mut inter) = (0, 0, 0);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
            std::cmp::Ordering::Equal => {
                inter += 1;
                i += 1;
                j += 1;
            }
        }
    }
    (inter, a.len() + b.len() - inter)
}

pub(crate) fn seeds() -> [u64; HASHES] {
    let mut s = [0u64; HASHES];
    for (i, v) in s.iter_mut().enumerate() {
        *v = mix((i as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15));
    }
    s
}

/// One LSH key per band from the MinHash signature of `sh`.
pub(crate) fn band_keys(sh: &[u64], seeds: &[u64; HASHES]) -> [u64; BANDS] {
    let mut sig = [u64::MAX; HASHES];
    for &x in sh {
        for (s, seed) in sig.iter_mut().zip(seeds) {
            let h = mix(x ^ seed);
            if h < *s {
                *s = h;
            }
        }
    }
    let mut keys = [0u64; BANDS];
    for (b, key) in keys.iter_mut().enumerate() {
        let mut h = mix(b as u64 + 1);
        for r in 0..ROWS {
            h = mix(h ^ sig[b * ROWS + r]);
        }
        *key = h;
    }
    keys
}

// ---------------------------------------------------------------- grouping

struct Uniq {
    norm: String,
    count: usize,
    newest: i64,
}

#[derive(Default)]
struct Acc<'a> {
    count: usize,
    sessions: HashSet<&'a str>,
    days: HashSet<String>,
    projects: HashMap<String, usize>,
    first: i64,
    last: i64,
    originals: HashMap<&'a str, (usize, i64)>,
    by_project: HashMap<(String, &'a str), (usize, i64)>,
    /// Unique normalized strings of the group, commonest first.
    members: Vec<usize>,
}

pub fn group(prompts: &[Prompt], tz: Tz) -> Grouping {
    // 1. Unique normalized strings with their counts.
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut uniq: Vec<Uniq> = Vec::new();
    let mut of_prompt: Vec<Option<usize>> = Vec::with_capacity(prompts.len());
    for p in prompts {
        let norm = normalize(&p.text);
        if norm.is_empty() {
            of_prompt.push(None);
            continue;
        }
        let u = *index.entry(norm.clone()).or_insert_with(|| {
            uniq.push(Uniq { norm, count: 0, newest: i64::MIN });
            uniq.len() - 1
        });
        uniq[u].count += 1;
        uniq[u].newest = uniq[u].newest.max(p.ts);
        of_prompt.push(Some(u));
    }

    // 2. Leader clustering: commonest first (tie: newest, then the text itself).
    let mut order: Vec<usize> = (0..uniq.len()).collect();
    order.sort_by(|&a, &b| uniq[b].count.cmp(&uniq[a].count).then(uniq[b].newest.cmp(&uniq[a].newest)).then_with(|| uniq[a].norm.cmp(&uniq[b].norm)));
    let seeds = seeds();
    let mut leader_shingles: Vec<Vec<u64>> = Vec::new();
    let mut leader_uniq: Vec<usize> = Vec::new();
    let mut buckets: HashMap<(usize, u64), Vec<usize>> = HashMap::new();
    let mut leader_of: Vec<usize> = vec![0; uniq.len()];
    let mut members: Vec<Vec<usize>> = Vec::new();
    for &u in &order {
        let sh = shingles(&uniq[u].norm);
        let keys = band_keys(&sh, &seeds);
        let mut cand: Vec<usize> = keys.iter().enumerate().filter_map(|(b, k)| buckets.get(&(b, *k))).flatten().copied().collect();
        cand.sort_unstable();
        cand.dedup();
        let joined = cand.into_iter().find(|&l| {
            let (inter, union) = overlap(&sh, &leader_shingles[l]);
            inter * 100 >= JACCARD_PCT * union
        });
        let l = match joined {
            Some(l) => l,
            None => {
                let l = leader_shingles.len();
                for (b, k) in keys.iter().enumerate() {
                    buckets.entry((b, *k)).or_default().push(l);
                }
                leader_shingles.push(sh);
                leader_uniq.push(u);
                members.push(Vec::new());
                l
            }
        };
        leader_of[u] = l;
        members[l].push(u);
    }

    // 3. Per-group facts.
    let mut accs: Vec<Acc> = (0..leader_shingles.len()).map(|_| Acc { first: i64::MAX, last: i64::MIN, ..Default::default() }).collect();
    for (l, m) in members.into_iter().enumerate() {
        accs[l].members = m;
    }
    let mut counted = 0usize;
    for (p, u) in prompts.iter().zip(&of_prompt) {
        let Some(u) = *u else { continue };
        counted += 1;
        let a = &mut accs[leader_of[u]];
        a.count += 1;
        a.sessions.insert(p.session.as_str());
        a.days.insert(tz.day(p.ts));
        if let Some(name) = p.project.as_deref().map(project_name).filter(|n| !n.is_empty()) {
            *a.projects.entry(name).or_insert(0) += 1;
        }
        a.first = a.first.min(p.ts);
        a.last = a.last.max(p.ts);
        let e = a.originals.entry(p.text.trim()).or_insert((0, i64::MIN));
        e.0 += 1;
        e.1 = e.1.max(p.ts);
        let proj = p.project.as_deref().map(project_name).unwrap_or_default();
        let e = a.by_project.entry((proj, p.text.trim())).or_insert((0, i64::MIN));
        e.0 += 1;
        e.1 = e.1.max(p.ts);
    }

    let mut groups: Vec<Group> = Vec::with_capacity(accs.len());
    for (l, a) in accs.into_iter().enumerate() {
        let leader = uniq[leader_uniq[l]].norm.clone();
        let mut originals: Vec<(&str, usize, i64)> = a.originals.iter().map(|(t, (c, n))| (*t, *c, *n)).collect();
        // Most frequent first, then newest, then the text: the order is the data's own.
        originals.sort_by(|x, y| y.1.cmp(&x.1).then(y.2.cmp(&x.2)).then_with(|| x.0.cmp(y.0)));
        let representative = cut(originals[0].0);
        let mut rest: Vec<(&str, i64)> = originals.iter().skip(1).map(|o| (o.0, o.2)).collect();
        rest.sort_by(|x, y| y.1.cmp(&x.1).then_with(|| x.0.cmp(y.0)));
        let mut per: Vec<(&str, &str, usize, i64)> = a.by_project.iter().map(|((pr, t), (c, n))| (pr.as_str(), *t, *c, *n)).collect();
        per.sort_by(|x, y| y.2.cmp(&x.2).then(y.3.cmp(&x.3)).then_with(|| x.0.cmp(y.0)).then_with(|| x.1.cmp(y.1)));
        let mut taken: HashMap<&str, usize> = HashMap::new();
        let wordings: Vec<Wording> = per
            .into_iter()
            .filter(|(pr, ..)| {
                let n = taken.entry(*pr).or_insert(0);
                *n += 1;
                *n <= WORDINGS_PER_PROJECT
            })
            .map(|(pr, t, ..)| Wording { project: pr.to_string(), text: cut(t) })
            .collect();
        let mut projects: Vec<(String, usize)> = a.projects.into_iter().collect();
        projects.sort_by(|x, y| y.1.cmp(&x.1).then_with(|| x.0.cmp(&y.0)));
        groups.push(Group {
            id: id16(&leader),
            leader,
            count: a.count,
            sessions: a.sessions.len(),
            days: a.days.len(),
            projects: projects.into_iter().map(|p| p.0).collect(),
            first_ms: a.first,
            last_ms: a.last,
            representative,
            examples: rest.into_iter().take(EXAMPLES).map(|r| cut(r.0)).collect(),
            wordings,
            member_ids: a.members.iter().take(MEMBER_IDS).map(|&u| id16(&uniq[u].norm)).collect(),
            shingles: std::mem::take(&mut leader_shingles[l]),
        });
    }
    groups.sort_by(|a, b| b.count.cmp(&a.count).then(b.last_ms.cmp(&a.last_ms)).then_with(|| a.id.cmp(&b.id)));
    Grouping { groups, prompts: counted }
}

fn cut(s: &str) -> String {
    s.chars().take(TEXT_CAP).collect()
}
