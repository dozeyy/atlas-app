//! Reading a reviewer's own words, and tying a review to the work it was about
//! (`docs/specs/agent-scorecard.md` D6-D11).
//!
//! Everything here is deterministic text and id handling: no model, no network. Atlas reports what
//! a reviewer wrote (a verdict word, finding lines) and which helper the review plausibly
//! concerned; it never grades the work, and a review it cannot tie to one helper stays "not tied".
//!
//! What is kept from a reviewer's output is the verdict word and the masked finding lines
//! (`review_findings`, a cache that is safe to drop). Prompts are matched in memory and dropped.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use crate::search::mask::mask_secrets;

// ---------------------------------------------------------------- thresholds (one place)

/// Every number the scorecard and the themes lean on, in one place.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds;

impl Thresholds {
    /// A theme needs at least this many findings...
    pub const THEME_MIN_FINDINGS: usize = 3;
    /// ...from at least this many different runs.
    pub const THEME_MIN_RUNS: usize = 2;
    // The overlap at which two finding texts are one theme is the repeated-request finder's
    // (`habits::cluster::JACCARD_PCT`, 55 %): one bar for "the same text in other words".
    /// A median (tool calls, duration) is shown only from this many runs; fewer = "Too few runs yet".
    pub const MEDIAN_MIN_RUNS: usize = 3;
    /// A run with no end source whose last line is newer than this is still running (no duration yet);
    /// an older one stopped writing and has a duration, first line to last.
    pub const RUNNING_MS: i64 = 10 * 60_000;
    /// A rate sentence ("Passed 9 of 12 reviews") needs at least this many tied reviews.
    pub const RATE_MIN_REVIEWS: u32 = 5;
    /// A type with at least this many runs and a verdict on at least half of them is a reviewer.
    pub const REVIEWER_MIN_RUNS: u64 = 3;
    /// Reviewers dispatched within this long of the first one are one round (parallel reviewers).
    pub const ROUND_MS: i64 = 120_000;
    /// Findings kept per run, and the length bounds of one (characters after trimming).
    pub const MAX_FINDINGS_PER_RUN: usize = 40;
    pub const FINDING_MIN_CHARS: usize = 12;
    pub const FINDING_MAX_CHARS: usize = 400;
    /// The final text is never parsed past this many bytes.
    pub const FINAL_TEXT_CAP: usize = 256 * 1024;
}

// ---------------------------------------------------------------- verdicts (D6)

/// How a reviewer's verdict reads. The word lists live here and nowhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Verdict {
    Pass,
    /// A fail, fix-required, revise, off-system and the like: the reviewer found something.
    Findings,
    /// The reviewer said it only got part of the way (`STATUS: partial`).
    Partial,
    Other,
}

impl Verdict {
    /// The value stored in `agent_runs.verdict`.
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Pass => "pass",
            Verdict::Findings => "findings",
            Verdict::Partial => "partial",
            Verdict::Other => "other",
        }
    }
    pub fn parse(s: &str) -> Option<Verdict> {
        match s {
            "pass" => Some(Verdict::Pass),
            "findings" => Some(Verdict::Findings),
            "partial" => Some(Verdict::Partial),
            "other" => Some(Verdict::Other),
            _ => None,
        }
    }
}

/// D6: which words mean which class (upper-case).
pub const VERDICTS: &[(&str, Verdict)] = &[
    ("PASS", Verdict::Pass),
    ("PASSED", Verdict::Pass),
    ("MERGE", Verdict::Pass),
    ("APPROVE", Verdict::Pass),
    ("APPROVED", Verdict::Pass),
    ("ACCEPT", Verdict::Pass),
    ("ACCEPTED", Verdict::Pass),
    ("LGTM", Verdict::Pass),
    ("FIX-REQUIRED", Verdict::Findings),
    ("FAIL", Verdict::Findings),
    ("FAILED", Verdict::Findings),
    ("REVISE", Verdict::Findings),
    ("OFF-SYSTEM", Verdict::Findings),
    ("GENERIC", Verdict::Findings),
    ("CHANGES-REQUESTED", Verdict::Findings),
    ("BLOCK", Verdict::Findings),
    ("BLOCKED", Verdict::Findings),
    ("REJECT", Verdict::Findings),
    ("REJECTED", Verdict::Findings),
];

/// Function words and label words that may sit between a label and its verdict word ("Verdict: all
/// six checks PASS", "Overall verdict: PASS"). Measured on a real corpus: `all`, `by`, `the`, `on`,
/// `up` were once read as verdict words.
const FILLER: &[&str] = &[
    "ALL", "BY", "THE", "ON", "UP", "IS", "IT", "TO", "OF", "IN", "AS", "AT", "IF", "AN", "AND", "OR", "BUT", "ARE", "WAS", "BE", "FOR", "OVERALL",
    "VERDICT", "RESULT", "RESULTS", "STATUS", "FINAL", "NO",
];

/// `agent_runs.verdict_word` starts with this when the verdict was read from the `STATUS:` line.
pub const STATUS_PREFIX: &str = "STATUS:";

/// A parsed verdict: the upper-cased word and its class. `status` says it was read from the
/// `STATUS:` line, not from a `Verdict`/`Overall` line the reviewer wrote on purpose.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerdictLine {
    pub word: String,
    pub class: Verdict,
    pub status: bool,
}

pub fn classify_word(word: &str) -> Verdict {
    VERDICTS.iter().find(|(w, _)| *w == word).map_or(Verdict::Other, |(_, c)| *c)
}

fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// The upper-cased words of a text, in order; a hyphen inside a word stays ("fix-required"), a run
/// of digits is one empty-string word (a number is no word, but it still separates).
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        let w = cur.trim_matches('-');
        if !w.is_empty() {
            out.push(w.to_ascii_uppercase());
        }
        cur.clear();
    };
    let mut in_num = false;
    for c in s.chars() {
        if c.is_ascii_alphabetic() || (c == '-' && !cur.is_empty()) {
            in_num = false;
            cur.push(c);
        } else if c.is_ascii_digit() {
            flush(&mut cur, &mut out);
            if !in_num {
                out.push(String::new());
                in_num = true;
            }
        } else {
            in_num = false;
            flush(&mut cur, &mut out);
        }
    }
    flush(&mut cur, &mut out);
    out
}

/// The verdict word that opens a run of words, "FIX REQUIRED" read whole. A bare number is skipped.
fn verdict_word_at(ws: &[String], i: usize) -> Option<(&'static str, Verdict, usize)> {
    let w = ws.get(i)?.as_str();
    if w == "FIX" && ws.get(i + 1).is_some_and(|n| n == "REQUIRED") {
        return Some(("FIX-REQUIRED", Verdict::Findings, 2));
    }
    VERDICTS.iter().find(|(v, _)| *v == w).map(|(v, c)| (*v, *c, 1))
}

/// A `Verdict:` or `Overall:` label in a line, at a word boundary (not "verdicts", not "overall"
/// as the middle of another word); `(start, end, is_verdict)` of each label word.
fn labels(line: &str) -> Vec<(usize, usize, bool)> {
    let lower = line.to_ascii_lowercase();
    let mut out = Vec::new();
    for (label, is_verdict) in [("verdict", true), ("overall", false)] {
        let mut from = 0;
        while let Some(p) = lower[from..].find(label) {
            let at = from + p;
            let end = at + label.len();
            from = end;
            let before_ok = lower[..at].chars().next_back().is_none_or(|c| !is_word_char(c));
            let after_ok = lower[end..].chars().next().is_none_or(|c| !is_word_char(c));
            if before_ok && after_ok {
                out.push((at, end, is_verdict));
            }
        }
    }
    out.sort_unstable();
    out
}

/// What one label in one line says. `at_start`: only markup before the label (a line that opens
/// with "VERDICT:"); only then may an unlisted word be the verdict (class `Other`).
fn read_label(line: &str, start: usize, end: usize, is_verdict: bool) -> Option<VerdictLine> {
    let at_start = line[..start].chars().all(|c| !is_word_char(c));
    let rest = &line[end..];
    let up = rest.to_ascii_uppercase();
    // "PASS/FAIL" is a template, not a verdict.
    if up.contains("PASS/FAIL") || up.contains("FAIL/PASS") {
        return None;
    }
    let sep_ok = rest.chars().take(9).take_while(|c| !c.is_alphanumeric()).any(|c| matches!(c, ':' | '-' | '=' | '\u{2014}' | '\u{2013}'));
    let ws = words(rest);
    let mut seen = 0;
    let mut i = 0;
    while i < ws.len() && seen < 10 {
        let w = ws[i].as_str();
        if w.is_empty() {
            i += 1;
            continue;
        }
        if let Some((word, class, _)) = verdict_word_at(&ws, i) {
            return Some(VerdictLine { word: word.to_string(), class, status: false });
        }
        if FILLER.contains(&w) {
            i += 1;
            seen += 1;
            continue;
        }
        // The first real word of "VERDICT: needs-work" is the verdict, as written. Prose is not.
        if seen == 0 && is_verdict && at_start && sep_ok && w.len() >= 2 {
            return Some(VerdictLine { word: w.to_string(), class: Verdict::Other, status: false });
        }
        // "Verdict: all 6 criteria PASS": a sentence that began with filler may name the verdict later.
        if sep_ok && seen > 0 {
            i += 1;
            seen += 1;
            continue;
        }
        return None;
    }
    None
}

/// The `STATUS:` line of a final text (the contract's `done | partial | blocked`): `partial` is
/// said as it is, `blocked` is "other", a verdict word as the first word is that verdict, and a
/// `done` counts as a verdict only when the rest of the line names exactly one kind of verdict
/// word ("STATUS: done. All 6 criteria PASS"). A bare `done` states no verdict.
fn status_verdict(text: &str) -> Option<VerdictLine> {
    for line in text.lines() {
        let t = line.trim_start_matches(|c: char| !is_word_char(c));
        let Some(head) = t.get(..6) else { continue };
        if !head.eq_ignore_ascii_case("status") || t[6..].chars().next().is_some_and(is_word_char) {
            continue;
        }
        let ws = words(&t[6..]);
        let first = ws.iter().position(|w| !w.is_empty())?;
        let mk = |word: &str, class| Some(VerdictLine { word: word.to_string(), class, status: true });
        return match ws[first].as_str() {
            "PARTIAL" => mk("PARTIAL", Verdict::Partial),
            "BLOCKED" => mk("BLOCKED", Verdict::Other),
            _ => {
                let mut found: Vec<(&'static str, Verdict)> = Vec::new();
                let mut i = first;
                while i < ws.len() {
                    if let Some((word, class, n)) = verdict_word_at(&ws, i) {
                        found.push((word, class));
                        i += n;
                    } else {
                        i += 1;
                    }
                }
                let (w0, c0) = *found.first()?;
                // Mixed words ("check 1 PASS, check 2 FAIL") state no single verdict.
                found.iter().all(|(_, c)| *c == c0).then(|| VerdictLine { word: w0.to_string(), class: c0, status: true })
            }
        };
    }
    None
}

/// The verdict a final text states. First the first line with a `Verdict` or `Overall` label (up to
/// the words after it: "VERDICT: pass", "**Overall: FAIL**", "Verdict: all 6 criteria PASS"); else
/// the `STATUS:` line (see `status_verdict`). Nothing stated is `None`, never a guess.
pub fn parse_verdict(text: &str) -> Option<VerdictLine> {
    for line in text.lines() {
        for (start, end, is_verdict) in labels(line) {
            if let Some(v) = read_label(line, start, end, is_verdict) {
                return Some(v);
            }
        }
    }
    status_verdict(text)
}

// ---------------------------------------------------------------- finding lines (D8)

/// A finding line: the severity word as the reviewer wrote it (title case) and the text after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Finding {
    pub severity: Option<&'static str>,
    pub text: String,
}

const SEVERITIES: &[&str] = &["Critical", "High", "Medium", "Low", "Blocker", "Major", "Minor", "Nit"];

fn severity_of(word: &str) -> Option<&'static str> {
    SEVERITIES.iter().copied().find(|s| s.eq_ignore_ascii_case(word))
}

/// How the severity words rank, most serious first (for a mix like "4 High, 2 Medium").
pub fn severity_rank(s: &str) -> usize {
    match s {
        "Blocker" => 0,
        "Critical" => 1,
        "High" => 2,
        "Major" => 3,
        "Medium" => 4,
        "Low" => 5,
        "Minor" => 6,
        "Nit" => 7,
        _ => 8,
    }
}

/// A list item's text without its marker, and whether it was a list item at all.
fn strip_bullet(line: &str) -> (bool, &str) {
    for m in ["- ", "* ", "+ ", "\u{2022} "] {
        if let Some(r) = line.strip_prefix(m) {
            return (true, r.trim_start());
        }
    }
    let digits = line.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && digits <= 3 {
        let rest = &line[digits..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return (true, r.trim_start());
        }
    }
    (false, line)
}

enum Label {
    /// A FINDINGS / ISSUES / PROBLEMS heading or label with nothing after it.
    Findings,
    /// Any other heading or all-caps label: the section (if any) ends.
    Other,
    NotALabel,
}

fn has_section_word(s: &str) -> bool {
    let u = s.to_ascii_uppercase();
    u.contains("FINDINGS") || u.contains("ISSUES") || u.contains("PROBLEMS")
}

fn all_caps_label(s: &str) -> bool {
    let letters = s.chars().filter(|c| c.is_alphabetic()).count();
    letters >= 3
        && s.len() <= 40
        && s.chars().all(|c| c.is_ascii_uppercase() || matches!(c, ' ' | '/' | '&' | '-' | '_'))
        && severity_of(s.trim()).is_none()
}

fn classify_label(line: &str) -> Label {
    let is_heading = line.starts_with('#');
    let t = line.trim_start_matches(['#', '*', '_', ' ']);
    // Bold-wrapped or colon-ended labels: **Findings**, Findings:, **Findings:**
    let core = t.trim_end_matches(['*', '_', ' ']);
    let ends_colon = core.ends_with(':');
    let bare = core.trim_end_matches(':').trim_end_matches(['*', '_', ' ']);
    let bold = line.starts_with("**") || line.starts_with("__");
    if is_heading {
        return if has_section_word(bare) { Label::Findings } else { Label::Other };
    }
    // `LABEL: some content` (an all-caps label with inline content): ends a section, opens none.
    if let Some(i) = t.find(':') {
        let prefix = t[..i].trim_end_matches(['*', '_', ' ']);
        let after = t[i + 1..].trim_matches(['*', '_', ' ']);
        if all_caps_label(prefix) {
            return if after.is_empty() && has_section_word(prefix) { Label::Findings } else { Label::Other };
        }
        if after.is_empty() && bare.chars().count() <= 60 && has_section_word(bare) && (bold || ends_colon) {
            return Label::Findings;
        }
        return Label::NotALabel;
    }
    if bare.chars().count() <= 60 && has_section_word(bare) && (bold || all_caps_label(bare)) {
        return Label::Findings;
    }
    if all_caps_label(bare) {
        return Label::Other;
    }
    Label::NotALabel
}

/// A leading severity word (bare, bracketed, bold or followed by a colon or dash), with the rest.
/// `decorated` is true when the word carried one of those marks; a bare word counts only when
/// `allow_bare` (the line is a list item or sits in a findings section).
fn leading_severity(line: &str, allow_bare: bool) -> Option<(&'static str, &str)> {
    let mut s = line.trim_start_matches(['[', '(', '*', '_', ' ']);
    let opened = s.len() != line.len() && line[..line.len() - s.len()].chars().any(|c| matches!(c, '[' | '(' | '*' | '_'));
    let wlen = s.bytes().take_while(u8::is_ascii_alphabetic).count();
    if wlen == 0 {
        return None;
    }
    let sev = severity_of(&s[..wlen])?;
    s = &s[wlen..];
    // A word boundary: "Highlight" and "Low-risk" are not severities.
    match s.chars().next() {
        Some(c) if c.is_alphanumeric() || c == '_' => return None,
        Some('-') if s[1..].chars().next().is_some_and(char::is_alphabetic) => return None,
        _ => {}
    }
    let before_closers = s;
    s = s.trim_start_matches([']', ')', '*', '_']);
    let closed = s.len() != before_closers.len();
    let mut separated = false;
    if let Some(r) = s.strip_prefix(':') {
        s = r;
        separated = true;
    } else if let Some(r) = s.strip_prefix(" - ").or_else(|| s.strip_prefix(" \u{2013} ")).or_else(|| s.strip_prefix(" \u{2014} ")) {
        s = r;
        separated = true;
    }
    s = s.trim_start_matches(['*', '_', ' ', ':', '-', ')', ']']);
    if !(opened || closed || separated || allow_bare) {
        return None;
    }
    Some((sev, s))
}

/// Leading columns of a raw line (a tab counts four).
fn indent_of(raw: &str) -> usize {
    raw.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

/// "Where: ...", "Fix: ...", "Attack path: ...": a labelled line that describes a finding rather
/// than being one.
fn is_detail_line(body: &str) -> bool {
    const LABELS: &[&str] = &[
        "where", "fix", "attack", "attack path", "why", "impact", "evidence", "repro", "reproduce", "suggestion",
        "recommendation", "note", "severity", "location", "cause", "proof", "result", "expected", "actual", "detail",
        "details", "context", "example", "steps", "how", "what", "because", "so",
    ];
    let t = body.trim_start_matches(['*', '_', '`', ' ', '\u{b7}']);
    let Some(i) = t.find(':') else { return false };
    let label = t[..i].trim_end_matches(['*', '_', ' ']);
    LABELS.iter().any(|l| l.eq_ignore_ascii_case(label))
}

/// At least 8 letters outside code spans: a line of nothing but `file.rs:12` names no problem.
fn says_something(text: &str) -> bool {
    let mut in_code = false;
    let mut letters = 0;
    for c in text.chars() {
        if c == '`' {
            in_code = !in_code;
        } else if !in_code && c.is_alphabetic() {
            letters += 1;
        }
    }
    letters >= 8
}

fn clean_text(s: &str) -> String {
    let t = s.replace("**", "");
    t.trim().trim_matches(['*', '_', '\u{b7}']).trim().to_string()
}

/// Finding lines dropped because the secret mask would have changed them (process-wide, for the
/// measurement test; nothing else reads it).
pub static MASK_DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The finding lines of a final text (D8), already masked and bounded. A line the secret mask
/// would change is dropped entirely, never stored half-masked.
pub fn finding_lines(text: &str) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();
    let mut in_fence = false;
    let mut in_section = false;
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with("```") || line.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || line.is_empty() {
            continue;
        }
        let (is_item, body) = strip_bullet(line);
        if !is_item {
            match classify_label(line) {
                Label::Findings => {
                    in_section = true;
                    continue;
                }
                Label::Other => {
                    in_section = false;
                    continue;
                }
                Label::NotALabel => {}
            }
        }
        let (severity, rest) = match leading_severity(body, is_item) {
            Some((sev, rest)) => (Some(sev), rest),
            // A loose item under a findings heading is a finding only at the top level, and only
            // when it says something: a nested "Fix: ..." / "Where: ..." line is detail of the
            // finding above it, and a bare file reference names no problem (measured on a real
            // corpus: 80 % of loose items were such lines).
            None if in_section && is_item && indent_of(raw) < 2 && !is_detail_line(body) => (None, body),
            None => continue,
        };
        let text = clean_text(rest);
        if severity.is_none() && !says_something(&text) {
            continue;
        }
        let n = text.chars().count();
        if !(Thresholds::FINDING_MIN_CHARS..=Thresholds::FINDING_MAX_CHARS).contains(&n) {
            continue;
        }
        if mask_secrets(&text).as_ref() != text {
            MASK_DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            continue;
        }
        out.push(Finding { severity, text });
        if out.len() >= Thresholds::MAX_FINDINGS_PER_RUN {
            break;
        }
    }
    out
}

// ---------------------------------------------------------------- reviewer types (D7)

/// A type name that says reviewer: review, verif, judge, audit, or a `qa` word.
pub fn reviewer_by_name(agent_type: &str) -> bool {
    let l = agent_type.to_ascii_lowercase();
    l.contains("review")
        || l.contains("verif")
        || l.contains("judge")
        || l.contains("audit")
        || l.split(|c: char| !c.is_ascii_alphanumeric()).any(|w| w == "qa")
}

/// The reviewer types among `(type, runs, runs with a verdict)`: by name, or a verdict on at least
/// half the runs (with at least `REVIEWER_MIN_RUNS`).
pub fn reviewer_types<'a>(stats: impl IntoIterator<Item = (&'a str, u64, u64)>) -> HashSet<String> {
    stats
        .into_iter()
        .filter(|(t, runs, with_verdict)| {
            reviewer_by_name(t) || (*runs >= Thresholds::REVIEWER_MIN_RUNS && with_verdict * 2 >= *runs)
        })
        .map(|(t, _, _)| t.to_string())
        .collect()
}

// ---------------------------------------------------------------- ties (D10)

/// One helper run of a chat, as the tie rules need it.
#[derive(Debug, Clone)]
pub struct RunFacts {
    pub agent_id: String,
    pub agent_type: String,
    pub first_ts: i64,
    pub last_ts: i64,
    pub tool_use_id: Option<String>,
    pub verdict: Option<Verdict>,
}

/// One dispatch or message of a chat (the `agent_links` rows, one per named target).
#[derive(Debug, Clone)]
pub struct LinkFacts {
    pub ts: i64,
    pub send: bool,
    pub tool_use_id: String,
    /// The helper type the dispatch asked for (empty for a message).
    pub subagent_type: String,
    /// The helper id the prompt or message named; empty when it named none.
    pub target: String,
}

/// How a review was tied to a worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TieHow {
    /// L1: the reviewer's dispatch named the worker.
    Named,
    /// L2: the only worker that ended since the previous round of reviewers.
    Ended,
    /// The review was not tied by L1 or L2; a message or dispatch after its findings named the worker.
    SentBack,
}

/// One review of one chat and the work it was tied to.
#[derive(Debug, Clone)]
pub struct ReviewTie {
    pub reviewer: String,
    pub reviewer_type: String,
    pub verdict: Option<Verdict>,
    pub ended_ts: i64,
    /// The workers the review was tied to (empty: not tied) and how.
    pub workers: Vec<(String, TieHow)>,
    /// Workers a `findings` review sent back (a subset of `workers`, or workers named after it).
    pub sent_back: BTreeSet<String>,
}

/// D10 for one chat. `runs` are the chat's helper runs, `links` its dispatches and messages,
/// `is_reviewer` the D7 classification. Reviewers dispatched within `ROUND_MS` of each other are
/// one round: parallel reviewers (a code-reviewer and a verifier started together) share one
/// window, so the "previous reviewer dispatch" and "next reviewer dispatch" of D10 mean the
/// previous and next round.
pub fn tie_reviews(runs: &[RunFacts], links: &[LinkFacts], is_reviewer: &dyn Fn(&str) -> bool) -> Vec<ReviewTie> {
    let by_id: HashMap<&str, &RunFacts> = runs.iter().map(|r| (r.agent_id.as_str(), r)).collect();
    let workers_of = |ids: &[&str]| -> Vec<String> {
        let mut v: Vec<String> = ids
            .iter()
            .filter_map(|id| by_id.get(id))
            .filter(|r| !is_reviewer(&r.agent_type))
            .map(|r| r.agent_id.clone())
            .collect();
        v.sort();
        v.dedup();
        v
    };

    // Reviewer runs with their dispatch time (the dispatch that started them, else their first line).
    let dispatch_ts: HashMap<&str, i64> =
        links.iter().filter(|l| !l.send).map(|l| (l.tool_use_id.as_str(), l.ts)).collect();
    let mut reviewers: Vec<(i64, &RunFacts)> = runs
        .iter()
        .filter(|r| is_reviewer(&r.agent_type))
        .map(|r| {
            let d = r.tool_use_id.as_deref().and_then(|t| dispatch_ts.get(t).copied()).unwrap_or(r.first_ts);
            (d, r)
        })
        .collect();
    reviewers.sort_by(|a, b| (a.0, &a.1.agent_id).cmp(&(b.0, &b.1.agent_id)));

    // Rounds: a reviewer within ROUND_MS of its round's first dispatch joins that round.
    let mut round_start: Vec<i64> = Vec::new();
    let mut round_of: Vec<usize> = Vec::with_capacity(reviewers.len());
    for (d, _) in &reviewers {
        match round_start.last() {
            Some(s) if *d - *s <= Thresholds::ROUND_MS => round_of.push(round_start.len() - 1),
            _ => {
                round_start.push(*d);
                round_of.push(round_start.len() - 1);
            }
        }
    }

    // What each dispatch (by tool-use id) named, for L1 and for "a dispatch whose prompt names X".
    let mut named_by: HashMap<&str, Vec<&str>> = HashMap::new();
    for l in links.iter().filter(|l| !l.send && !l.target.is_empty()) {
        named_by.entry(l.tool_use_id.as_str()).or_default().push(l.target.as_str());
    }

    let mut out = Vec::with_capacity(reviewers.len());
    for (i, (d, r)) in reviewers.iter().enumerate() {
        let round = round_of[i];
        let window_lo = if round == 0 { i64::MIN } else { round_start[round - 1] };
        let window_hi = round_start[round];
        let mut workers: Vec<(String, TieHow)> = Vec::new();

        // L1: the dispatch names exactly one non-reviewer helper of the chat.
        if let Some(named) = r.tool_use_id.as_deref().and_then(|t| named_by.get(t)) {
            let w = workers_of(named);
            if w.len() == 1 {
                workers.push((w[0].clone(), TieHow::Named));
            }
        }
        // L2: exactly one non-reviewer helper ended since the previous round (or the chat's start).
        if workers.is_empty() {
            let ended: Vec<&str> = runs
                .iter()
                .filter(|w| !is_reviewer(&w.agent_type) && w.agent_id != r.agent_id)
                .filter(|w| w.last_ts > window_lo && w.last_ts <= window_hi.max(*d))
                .map(|w| w.agent_id.as_str())
                .collect();
            if ended.len() == 1 {
                workers.push((ended[0].to_string(), TieHow::Ended));
            }
        }

        // Sent back: findings, then (before the next round) a message to a helper, or a dispatch
        // that names one. The message and the dispatch are the same act, once per helper.
        let mut sent_back: BTreeSet<String> = BTreeSet::new();
        if r.verdict == Some(Verdict::Findings) {
            let next_round = round_start.get(round + 1).copied().unwrap_or(i64::MAX);
            let mut after: Vec<&LinkFacts> = links
                .iter()
                .filter(|l| !l.target.is_empty() && l.ts > r.last_ts && l.ts < next_round)
                .collect();
            after.sort_by(|a, b| (a.ts, &a.tool_use_id).cmp(&(b.ts, &b.tool_use_id)));
            for l in after {
                if let Some(w) = by_id.get(l.target.as_str())
                    && !is_reviewer(&w.agent_type)
                    && w.agent_id != r.agent_id
                {
                    sent_back.insert(w.agent_id.clone());
                }
            }
            for w in &sent_back {
                if !workers.iter().any(|(x, _)| x == w) && !workers.iter().any(|(_, h)| *h != TieHow::SentBack) {
                    workers.push((w.clone(), TieHow::SentBack));
                }
            }
        }
        // A review tied by L1 or L2 to one helper that sent another back keeps its own tie; the
        // helper that was sent back is counted as sent back only (never as having a tied review).
        out.push(ReviewTie {
            reviewer: r.agent_id.clone(),
            reviewer_type: r.agent_type.clone(),
            verdict: r.verdict,
            ended_ts: r.last_ts,
            workers,
            sent_back,
        });
    }
    out
}

/// How many of a type's reviews, per verdict class, tied to which workers: the counts a worker's
/// card shows (D11).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct WorkerReviews {
    /// Tied reviews (a review tied to several workers counts once for each).
    pub tied: u32,
    pub passed: u32,
    pub sent_back: u32,
    /// Tied reviews with another verdict word, or none.
    pub other: u32,
}

/// Count by worker agent id: every (review, worker) pair, and the sent-back ones.
pub fn per_worker(ties: &[ReviewTie]) -> BTreeMap<String, WorkerReviews> {
    let mut m: BTreeMap<String, WorkerReviews> = BTreeMap::new();
    for t in ties {
        for (w, _) in &t.workers {
            let e = m.entry(w.clone()).or_default();
            e.tied += 1;
            let back = t.sent_back.contains(w);
            if back {
                e.sent_back += 1;
            } else if t.verdict == Some(Verdict::Pass) {
                e.passed += 1;
            } else {
                e.other += 1;
            }
        }
        // A helper sent back by a review tied to someone else is sent back, not "tied".
        for w in &t.sent_back {
            if !t.workers.iter().any(|(x, _)| x == w) {
                m.entry(w.clone()).or_default().sent_back += 1;
            }
        }
    }
    m
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod verdict {
    use super::*;

    fn v(text: &str) -> Option<(String, Verdict)> {
        parse_verdict(text).map(|x| (x.word, x.class))
    }

    #[test]
    fn every_listed_word_maps_to_its_class() {
        for (word, class) in VERDICTS {
            assert_eq!(v(&format!("VERDICT: {word}")), Some((word.to_string(), *class)), "{word}");
        }
    }

    #[test]
    fn case_bold_colon_and_dash_all_read() {
        let pass = Some(("PASS".to_string(), Verdict::Pass));
        for t in [
            "Verdict: pass",
            "VERDICT: PASS",
            "verdict: Pass",
            "**VERDICT**: PASS",
            "**Verdict:** pass",
            "VERDICT - PASS",
            "VERDICT \u{2014} pass",
            "## Verdict\nignored\n",
            "  > Verdict : pass",
            "Intro\n\nVERDICT: PASS (with two notes)\nFINDINGS: none",
        ] {
            let want = if t.starts_with("## Verdict") { None } else { pass.clone() };
            assert_eq!(v(t), want, "{t:?}");
        }
    }

    /// Final-text shapes of real reviewer and verifier reports (words changed, shape kept).
    #[test]
    fn real_shaped_verifier_and_reviewer_endings_read() {
        let pass = Some(("PASS".to_string(), Verdict::Pass));
        let fail = Some(("FAIL".to_string(), Verdict::Findings));
        for (t, want) in [
            ("Checks ran.\n\nOverall: PASS", pass.clone()),
            ("Checks ran.\n\n**Overall: FAIL**", fail.clone()),
            ("overall PASS (two caveats)", pass.clone()),
            ("**Overall verdict: PASS.**", pass.clone()),
            ("VERDICT: pass", pass.clone()),
            ("**VERDICT: pass**", pass.clone()),
            ("VERDICT: **pass**", pass.clone()),
            ("VERDICT: all 6 criteria PASS. The new test can fail.", pass.clone()),
            ("**Verdict: 1.2.3 PASS, 1.2.4 PASS.**", pass.clone()),
            ("STATUS: done (read-only). **VERDICT: PASS**", pass.clone()),
            ("STATUS: done. Verdict: PASS, with caveats under UNVERIFIED.", pass.clone()),
            ("Overall: pass/fail per criterion below", None),
            ("VERDICT: fail", fail.clone()),
            ("VERDICT: FAIL", fail.clone()),
            ("VERDICT: fix-required (FAIL)", Some(("FIX-REQUIRED".to_string(), Verdict::Findings))),
            ("VERDICT: fix-required (one Medium; items 1-3 pass)", Some(("FIX-REQUIRED".to_string(), Verdict::Findings))),
            ("| # | Criterion | Verdict | Evidence |\n|---|---|---|---|\n| 1 | a | PASS | x |", None),
            ("Overall the change looks tidy and small.", None),
        ] {
            assert_eq!(v(t), want, "{t:?}");
        }
    }

    #[test]
    fn a_status_line_is_the_fallback_and_never_guesses() {
        let st = |t: &str| parse_verdict(t).map(|x| (x.word, x.class, x.status));
        // A bare done states no verdict.
        assert_eq!(st("STATUS: done\nCHANGED: a.rs"), None);
        assert_eq!(st("**STATUS:** done"), None);
        assert_eq!(st("STATUS: done (read-only review)"), None);
        assert_eq!(st("STATUS: done (one finding on item 2, see below)"), None);
        // Partial and blocked are said as they are.
        assert_eq!(st("STATUS: partial"), Some(("PARTIAL".into(), Verdict::Partial, true)));
        assert_eq!(st("**STATUS: partial.** Checks 1 to 3 PASS. Check 4 cannot run."), Some(("PARTIAL".into(), Verdict::Partial, true)));
        assert_eq!(st("STATUS: blocked"), Some(("BLOCKED".into(), Verdict::Other, true)));
        // A verdict word in the line counts when it is the only kind.
        assert_eq!(st("STATUS: done. All 4 criteria PASS."), Some(("PASS".into(), Verdict::Pass, true)));
        assert_eq!(st("STATUS: PASS (no blocking findings)"), Some(("PASS".into(), Verdict::Pass, true)));
        assert_eq!(st("**STATUS: PASS** (no blocking defects)"), Some(("PASS".into(), Verdict::Pass, true)));
        assert_eq!(st("STATUS: done. Check 1 PASS, check 2 FAIL."), None);
        // A Verdict line wins over the status line, and is not "from status".
        assert_eq!(st("STATUS: partial\nVERDICT: PASS"), Some(("PASS".into(), Verdict::Pass, false)));
        assert_eq!(st("Verdicts are listed below"), None);
    }

    #[test]
    fn an_unknown_word_is_other_and_keeps_the_word() {
        assert_eq!(v("VERDICT: needs-work"), Some(("NEEDS-WORK".to_string(), Verdict::Other)));
        assert_eq!(v("Verdict: Conditional\n"), Some(("CONDITIONAL".to_string(), Verdict::Other)));
    }

    #[test]
    fn the_first_verdict_line_wins_and_a_number_is_no_word() {
        assert_eq!(v("VERDICT: FIX-REQUIRED\nlater\nVERDICT: PASS"), Some(("FIX-REQUIRED".to_string(), Verdict::Findings)));
        assert_eq!(v("VERDICT: 3\nnothing"), None);
        // Prose before the word is skipped; a prose line with no word is no verdict; a later real
        // line still counts; FIX REQUIRED reads whole.
        assert_eq!(v("Verdict: all six checks passed"), Some(("PASSED".to_string(), Verdict::Pass)));
        assert_eq!(v("Verdict: the fix holds"), None);
        assert_eq!(v("Verdict: the fix holds\nVerdict: PASS"), Some(("PASS".to_string(), Verdict::Pass)));
        assert_eq!(v("VERDICT: FIX REQUIRED"), Some(("FIX-REQUIRED".to_string(), Verdict::Findings)));
        assert_eq!(v("no verdict anywhere in this text"), None);
        assert_eq!(v(""), None);
    }

    #[test]
    fn verdict_values_round_trip() {
        for c in [Verdict::Pass, Verdict::Findings, Verdict::Partial, Verdict::Other] {
            assert_eq!(Verdict::parse(c.as_str()), Some(c));
        }
        assert_eq!(Verdict::parse("x"), None);
    }
}

#[cfg(test)]
mod findings {
    use super::*;

    fn texts(t: &str) -> Vec<(Option<&'static str>, String)> {
        finding_lines(t).into_iter().map(|f| (f.severity, f.text)).collect()
    }

    #[test]
    fn items_under_findings_and_severity_led_lines_are_found() {
        let t = "VERDICT: FIX-REQUIRED\n\nFINDINGS:\n- High: the retry loop never backs off (src/net.rs:41)\n- Medium: error text is swallowed in the handler\n- a plain item without any severity word\n\nOPEN QUESTIONS:\n- an item after the section ended\n\n**Low** naming of the helper is inconsistent\n[Critical] the lock is taken twice on the same thread\n";
        let got = texts(t);
        assert_eq!(
            got,
            vec![
                (Some("High"), "the retry loop never backs off (src/net.rs:41)".to_string()),
                (Some("Medium"), "error text is swallowed in the handler".to_string()),
                (None, "a plain item without any severity word".to_string()),
                (Some("Low"), "naming of the helper is inconsistent".to_string()),
                (Some("Critical"), "the lock is taken twice on the same thread".to_string()),
            ]
        );
    }

    #[test]
    fn headings_open_and_close_sections() {
        let t = "## Findings\n1. the first thing is wrong in the parser\n2) the second thing is wrong too\n## Summary\n- a summary line that is not a finding\n### Problems\n* a problem that came up in review\n";
        let got: Vec<String> = texts(t).into_iter().map(|x| x.1).collect();
        assert_eq!(got, vec!["the first thing is wrong in the parser", "the second thing is wrong too", "a problem that came up in review"]);
    }

    #[test]
    fn a_label_with_inline_content_opens_no_section() {
        let got = texts("FINDINGS: none\n- a list item that is not under a section\nUNVERIFIED: x\n");
        assert!(got.is_empty(), "{got:?}");
    }

    #[test]
    fn short_long_fenced_and_masked_lines_are_dropped() {
        let long = format!("- High: {}", "x".repeat(401));
        let t = format!(
            "FINDINGS:\n- High: too short\n{long}\n```\n- High: this one is inside a code fence\n```\n- High: key is sk-ant-api03-AbCdEf0123456789AbCdEf0123456789\n- High: this one is fine and long enough\n"
        );
        let got = texts(&t);
        assert_eq!(got, vec![(Some("High"), "this one is fine and long enough".to_string())]);
    }

    #[test]
    fn bare_prose_that_only_starts_with_a_severity_word_is_not_a_finding() {
        assert!(texts("Highlight reel of the whole change set\nLow-risk change overall, nothing to do\nHigh level summary follows here\n").is_empty());
        // ...but a list item or a decorated word is.
        let got = texts("- Low confidence in the retry test as written\n**High:** the cache is never invalidated on write\n");
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn nested_detail_lines_and_bare_file_references_are_not_findings() {
        let t = "## Findings\n- the installer is downloaded over plain HTTP without any check\n  - Fix: use HTTPS and pin a hash\n  - nested note that is indented\n- Where: `app.py:5-8`\n- `src/winframe.rs:699-713`.\n- High: indented severity still counts\n    - Low: even when it is nested under another line\n- Attack path: someone on the same network swaps the file\n";
        let got: Vec<String> = texts(t).into_iter().map(|x| x.1).collect();
        assert_eq!(
            got,
            vec![
                "the installer is downloaded over plain HTTP without any check",
                "indented severity still counts",
                "even when it is nested under another line"
            ]
        );
    }

    #[test]
    fn at_most_forty_per_run() {
        let mut t = String::from("FINDINGS:\n");
        for i in 0..60 {
            t.push_str(&format!("- Medium: finding number {i} in the module\n"));
        }
        assert_eq!(finding_lines(&t).len(), Thresholds::MAX_FINDINGS_PER_RUN);
    }
}

#[cfg(test)]
mod ties {
    use super::*;

    fn run(id: &str, ty: &str, first: i64, last: i64, tool: &str, v: Option<Verdict>) -> RunFacts {
        RunFacts { agent_id: id.into(), agent_type: ty.into(), first_ts: first, last_ts: last, tool_use_id: Some(tool.into()), verdict: v }
    }
    fn dispatch(ts: i64, tool: &str, ty: &str, target: &str) -> LinkFacts {
        LinkFacts { ts, send: false, tool_use_id: tool.into(), subagent_type: ty.into(), target: target.into() }
    }
    fn send(ts: i64, tool: &str, target: &str) -> LinkFacts {
        LinkFacts { ts, send: true, tool_use_id: tool.into(), subagent_type: String::new(), target: target.into() }
    }
    fn is_rev(t: &str) -> bool {
        t.contains("review")
    }

    #[test]
    fn l1_names_one_worker_and_l2_takes_the_only_one_that_ended() {
        let runs = vec![
            run("w1", "coder", 0, 1_000, "t_w1", None),
            run("r1", "code-reviewer", 2_000, 5_000, "t_r1", Some(Verdict::Pass)),
            run("w2", "coder", 6_000, 8_000, "t_w2", None),
            run("r2", "code-reviewer", 10_000_000, 10_005_000, "t_r2", Some(Verdict::Pass)),
        ];
        // r1's dispatch names w1 (L1). r2's dispatch names nobody; w2 is the only worker that ended since (L2).
        let links = vec![dispatch(1_500, "t_r1", "code-reviewer", "w1"), dispatch(10_000_000, "t_r2", "code-reviewer", "")];
        let ties = tie_reviews(&runs, &links, &is_rev);
        assert_eq!(ties.len(), 2);
        assert_eq!(ties[0].workers, vec![("w1".to_string(), TieHow::Named)]);
        assert_eq!(ties[1].workers, vec![("w2".to_string(), TieHow::Ended)]);
        let m = per_worker(&ties);
        assert_eq!(m["w1"], WorkerReviews { tied: 1, passed: 1, sent_back: 0, other: 0 });
    }

    #[test]
    fn two_workers_ending_in_the_window_leave_the_review_not_tied() {
        let runs = vec![
            run("w1", "coder", 0, 1_000, "t1", None),
            run("w2", "coder", 0, 2_000, "t2", None),
            run("r1", "code-reviewer", 5_000, 9_000, "t_r1", Some(Verdict::Pass)),
        ];
        let ties = tie_reviews(&runs, &[dispatch(5_000, "t_r1", "code-reviewer", "")], &is_rev);
        assert!(ties[0].workers.is_empty());
    }

    #[test]
    fn a_message_after_a_findings_review_ties_and_sends_back() {
        let runs = vec![
            run("w1", "coder", 0, 1_000, "t1", None),
            run("w2", "coder", 0, 2_000, "t2", None),
            run("r1", "code-reviewer", 5_000, 9_000, "t_r1", Some(Verdict::Findings)),
        ];
        let links = vec![dispatch(5_000, "t_r1", "code-reviewer", ""), send(12_000, "s1", "w2"), send(13_000, "s2", "w2")];
        let ties = tie_reviews(&runs, &links, &is_rev);
        assert_eq!(ties[0].workers, vec![("w2".to_string(), TieHow::SentBack)]);
        assert!(ties[0].sent_back.contains("w2"));
        let m = per_worker(&ties);
        assert_eq!(m["w2"], WorkerReviews { tied: 1, passed: 0, sent_back: 1, other: 0 }, "once per review however many messages");
    }

    #[test]
    fn parallel_reviewers_are_one_round() {
        let runs = vec![
            run("w1", "coder", 0, 1_000, "t1", None),
            run("r1", "code-reviewer", 5_000, 9_000, "t_r1", Some(Verdict::Findings)),
            run("r2", "verifier-review", 5_100, 9_500, "t_r2", None),
        ];
        let links = vec![dispatch(5_000, "t_r1", "code-reviewer", ""), dispatch(5_100, "t_r2", "verifier-review", ""), send(12_000, "s1", "w1")];
        let ties = tie_reviews(&runs, &links, &is_rev);
        // Both reviewers see w1 as the only helper that ended before their round.
        assert_eq!(ties[0].workers, vec![("w1".to_string(), TieHow::Ended)]);
        assert_eq!(ties[1].workers, vec![("w1".to_string(), TieHow::Ended)]);
        assert!(ties[0].sent_back.contains("w1"));
        assert!(ties[1].sent_back.is_empty(), "no verdict, nothing sent back");
    }

    #[test]
    fn reviewer_types_by_name_or_by_verdict_share() {
        assert!(reviewer_by_name("code-reviewer") && reviewer_by_name("verifier") && reviewer_by_name("verify-auditor"));
        assert!(reviewer_by_name("acceptance-judge") && reviewer_by_name("qa") && reviewer_by_name("ui-qa"));
        assert!(!reviewer_by_name("desktop-app-dev") && !reviewer_by_name("squad"));
        let set = reviewer_types([("checker", 4, 3), ("coder", 10, 0), ("thin", 2, 2)]);
        assert!(set.contains("checker") && !set.contains("coder") && !set.contains("thin"));
    }
}
