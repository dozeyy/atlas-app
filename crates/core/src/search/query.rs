//! Turning what a person typed into a safe FTS5 expression, and the ranked results.

use std::time::Instant;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::mask::{contains_secret, mask_secrets};
use super::SearchStatus;

pub const MAX_LIMIT: usize = 50;
const MAX_TERMS: usize = 16;

/// One piece of a snippet; `hit` marks the words that matched.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnippetPart {
    pub text: String,
    pub hit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The message's row id in the index (stable until a rebuild).
    pub id: i64,
    /// The session the message belongs to; a subagent's messages carry the parent's id.
    pub session_id: String,
    /// Set when the message was written by a helper (subagent) of that session.
    pub agent_id: Option<String>,
    pub project: String,
    pub project_name: String,
    /// Epoch milliseconds.
    pub ts: Option<i64>,
    pub role: String,
    pub snippet: Vec<SnippetPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchPage {
    pub hits: Vec<SearchHit>,
    pub has_more: bool,
    pub took_ms: u64,
    pub index: SearchStatus,
}

/// A word or phrase the person typed.
#[derive(Debug, Clone, PartialEq)]
struct Term {
    text: String,
    phrase: bool,
    /// Still being typed: matches any word that starts with it.
    prefix: bool,
}

/// A last word shorter than this stays a whole-word match while it is being typed: a
/// one- or two-letter prefix matches a large share of the index and cannot be ranked
/// in time to feel instant (measured: "p*" took ~45 ms to rank on 28k messages).
const MIN_PREFIX: usize = 3;

fn parse_terms(input: &str) -> Vec<Term> {
    let mut raw: Vec<(String, bool)> = Vec::new(); // (text, is_phrase)
    let mut cur = String::new();
    let mut in_phrase = false;
    let flush = |cur: &mut String, phrase: bool, raw: &mut Vec<(String, bool)>| {
        let t = std::mem::take(cur);
        if t.chars().any(|c| c.is_alphanumeric()) && raw.len() < MAX_TERMS {
            raw.push((t, phrase));
        }
    };
    for c in input.chars() {
        if c == '"' {
            flush(&mut cur, in_phrase, &mut raw);
            in_phrase = !in_phrase;
        } else if c.is_whitespace() && !in_phrase {
            flush(&mut cur, false, &mut raw);
        } else if !c.is_control() {
            cur.push(c);
        }
    }
    flush(&mut cur, in_phrase, &mut raw);
    let typing = !input.ends_with(char::is_whitespace) && !input.trim_end().ends_with('"');
    let last = raw.len().saturating_sub(1);
    raw.into_iter()
        .enumerate()
        .map(|(i, (text, phrase))| {
            let prefix = i == last && !phrase && typing && text.chars().count() >= MIN_PREFIX;
            Term { text, phrase, prefix }
        })
        .collect()
}

/// FTS5 expression for free text. Every word is quoted (so no input can be a syntax
/// error); the last bare word is a prefix while the person is still typing; `"quoted
/// phrases"` stay phrases; all terms must match. `None` when there is nothing to search.
pub fn build_match(input: &str) -> Option<String> {
    let terms = parse_terms(input);
    if terms.is_empty() {
        return None;
    }
    let parts: Vec<String> = terms
        .iter()
        .map(|t| {
            let q = format!("\"{}\"", t.text.replace('"', "\"\""));
            if t.prefix { format!("{q}*") } else { q }
        })
        .collect();
    Some(parts.join(" AND "))
}

// ---------------------------------------------------------------- snippets
//
// Built here rather than with SQLite's snippet(): that function re-walks the posting
// lists of every term (a prefix expands to all its words) for each row it is asked
// about, which cost 80-340 ms for 20 rows on common words. Reading 20 rows and
// scanning their text is constant time.

const SNIPPET_BEFORE: usize = 70;
const SNIPPET_LEN: usize = 190;

/// Lower-case with the common Latin accents removed (the index folds the same way).
fn fold(word: &str) -> String {
    word.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            '\u{e0}'..='\u{e5}' => 'a',
            '\u{e7}' => 'c',
            '\u{e8}'..='\u{eb}' => 'e',
            '\u{ec}'..='\u{ef}' => 'i',
            '\u{f1}' => 'n',
            '\u{f2}'..='\u{f6}' => 'o',
            '\u{f9}'..='\u{fc}' => 'u',
            '\u{fd}' | '\u{ff}' => 'y',
            c => c,
        })
        .collect()
}

/// (folded word, is_prefix) for every word a person asked for.
fn wanted_words(terms: &[Term]) -> Vec<(String, bool)> {
    let mut out = Vec::new();
    for t in terms {
        let words: Vec<&str> = t.text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
        let n = words.len();
        for (i, w) in words.into_iter().enumerate() {
            out.push((fold(w), t.prefix && i + 1 == n));
        }
    }
    out
}

/// A short window of `text` around the first match, with the matched words marked.
fn make_snippet(text: &str, terms: &[Term]) -> Vec<SnippetPart> {
    let wanted = wanted_words(terms);
    // Word spans as (byte start, byte end) over the original text.
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut start: Option<usize> = None;
    for (i, c) in text.char_indices() {
        if c.is_alphanumeric() {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            spans.push((s, i));
        }
    }
    if let Some(s) = start {
        spans.push((s, text.len()));
    }
    let is_hit = |&(a, b): &(usize, usize)| {
        let w = fold(&text[a..b]);
        wanted.iter().any(|(t, prefix)| if *prefix { w.starts_with(t.as_str()) } else { w == *t })
    };
    let first = spans.iter().position(is_hit);
    // Window start: SNIPPET_BEFORE chars before the first hit, moved forward to a word start.
    let anchor = first.map(|i| spans[i].0).unwrap_or(0);
    let mut from = text[..anchor].char_indices().rev().nth(SNIPPET_BEFORE).map(|(i, _)| i).unwrap_or(0);
    if from > 0 {
        // `from` may be mid-word: skip to the next word start (but never past the hit).
        while from < anchor && text[from..].starts_with(|c: char| c.is_alphanumeric()) {
            from += text[from..].chars().next().map_or(1, char::len_utf8);
        }
        while from < anchor && !text[from..].starts_with(|c: char| c.is_alphanumeric()) {
            from += text[from..].chars().next().map_or(1, char::len_utf8);
        }
    }
    let mut to = text[from..].char_indices().nth(SNIPPET_LEN).map(|(i, _)| from + i).unwrap_or(text.len());
    if to < text.len() {
        // Do not cut a word in half.
        while to > from && text[..to].ends_with(|c: char| c.is_alphanumeric()) {
            to -= text[..to].chars().next_back().map_or(1, char::len_utf8);
        }
    }
    let mut out: Vec<SnippetPart> = Vec::new();
    let mut push = |s: &str, hit: bool| {
        let s: String = s.chars().map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c }).collect();
        if s.is_empty() {
            return;
        }
        match out.last_mut() {
            Some(l) if l.hit == hit => l.text.push_str(&s),
            _ => out.push(SnippetPart { text: s, hit }),
        }
    };
    if from > 0 {
        push("...", false);
    }
    let mut at = from;
    for sp in spans.iter().filter(|(a, b)| *a >= from && *b <= to).filter(|s| is_hit(s)) {
        push(&text[at..sp.0], false);
        push(&text[sp.0..sp.1], true);
        at = sp.1;
    }
    push(&text[at..to], false);
    if to < text.len() {
        push("...", false);
    }
    out
}

/// Last line of defence: text was masked before it was stored, but if a snippet still
/// reads as a secret (older masking rules), show it masked and without highlights.
fn guard(parts: Vec<SnippetPart>) -> Vec<SnippetPart> {
    let plain: String = parts.iter().map(|p| p.text.as_str()).collect();
    if contains_secret(&plain) {
        return vec![SnippetPart { text: mask_secrets(&plain).into_owned(), hit: false }];
    }
    parts
}

fn base_name(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(['/', '\\']).next().unwrap_or("").to_string()
}

pub fn search(conn: &Connection, input: &str, limit: usize, offset: usize, index: SearchStatus) -> rusqlite::Result<SearchPage> {
    let started = Instant::now();
    let limit = limit.clamp(1, MAX_LIMIT);
    let Some(expr) = build_match(input) else {
        return Ok(SearchPage { hits: Vec::new(), has_more: false, took_ms: 0, index });
    };
    // Step 1: ids in rank order (bm25, then newest). No text work for rows we drop.
    let mut ids: Vec<i64> = Vec::with_capacity(limit + 1);
    {
        let mut st = conn.prepare_cached(
            "SELECT fts.rowid FROM fts JOIN msgs m ON m.id = fts.rowid \
             WHERE fts MATCH ?1 ORDER BY fts.rank, m.ts DESC LIMIT ?2 OFFSET ?3",
        )?;
        for r in st.query_map(rusqlite::params![expr, (limit + 1) as i64, offset as i64], |r| r.get::<_, i64>(0))? {
            ids.push(r?);
        }
    }
    let has_more = ids.len() > limit;
    ids.truncate(limit);
    // Step 2: the text and row details for just those ids; the snippet is built here.
    let terms = parse_terms(input);
    let mut hits = Vec::with_capacity(ids.len());
    let mut st = conn.prepare_cached(
        "SELECT fts.text, m.session_id, m.agent_id, m.role, m.ts, COALESCE(f.project, '') \
         FROM msgs m JOIN fts ON fts.rowid = m.id JOIN sfiles f ON f.file_id = m.file_id \
         WHERE m.id = ?1",
    )?;
    for id in ids {
        let row = st.query_row(rusqlite::params![id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, Option<i64>>(4)?,
                r.get::<_, String>(5)?,
            ))
        });
        let Ok((text, session_id, agent_id, role, ts, project)) = row else { continue };
        hits.push(SearchHit {
            id,
            session_id,
            agent_id,
            project_name: base_name(&project),
            project,
            ts,
            role: if role == 0 { "user" } else { "assistant" }.to_string(),
            snippet: guard(make_snippet(&text, &terms)),
        });
    }
    Ok(SearchPage { hits, has_more, took_ms: started.elapsed().as_millis() as u64, index })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_expressions_are_always_safe() {
        assert_eq!(build_match("flaky test").unwrap(), "\"flaky\" AND \"test\"*");
        assert_eq!(build_match("flaky test ").unwrap(), "\"flaky\" AND \"test\"");
        assert_eq!(build_match("\"retry loop\" backoff").unwrap(), "\"retry loop\" AND \"backoff\"*");
        assert_eq!(build_match("say \"hi there\"").unwrap(), "\"say\" AND \"hi there\"");
        assert_eq!(build_match("foo-bar").unwrap(), "\"foo-bar\"*");
        assert!(build_match("   ").is_none());
        assert!(build_match("+ - * ( ) ^ :").is_none());
        // FTS operators are just words here.
        assert_eq!(build_match("a OR b NOT").unwrap(), "\"a\" AND \"OR\" AND \"b\" AND \"NOT\"*");
        // A stray quote closes at the end of input and stays a phrase.
        assert_eq!(build_match("\"open phrase").unwrap(), "\"open phrase\"");
    }

    #[test]
    fn short_last_word_is_not_a_prefix() {
        assert_eq!(build_match("fix a").unwrap(), "\"fix\" AND \"a\"");
        assert_eq!(build_match("fix te").unwrap(), "\"fix\" AND \"te\"");
        assert_eq!(build_match("fix tes").unwrap(), "\"fix\" AND \"tes\"*");
    }

    fn plain(p: &[SnippetPart]) -> String {
        p.iter().map(|x| x.text.as_str()).collect()
    }
    fn hits_of(p: &[SnippetPart]) -> Vec<&str> {
        p.iter().filter(|x| x.hit).map(|x| x.text.as_str()).collect()
    }

    #[test]
    fn snippet_marks_matches_and_trims_to_a_window() {
        let text = format!("{} the Retry loop fails\non Windows {}", "padding ".repeat(40), "tail ".repeat(60));
        let p = make_snippet(&text, &parse_terms("retry loop "));
        let s = plain(&p);
        assert!(s.starts_with("..."), "{s}");
        assert!(s.ends_with("..."), "{s}");
        assert!(s.len() < 300, "{}", s.len());
        assert!(!s.contains('\n'));
        assert_eq!(hits_of(&p), vec!["Retry", "loop"]);
    }

    #[test]
    fn snippet_prefix_folds_case_and_accents() {
        let p = make_snippet("Un caf\u{e9} noir, s'il vous pla\u{ee}t", &parse_terms("cafe"));
        // "cafe" is only 4 letters and still being typed, so it is a prefix of "caf\u{e9}".
        assert_eq!(hits_of(&p), vec!["caf\u{e9}"]);
        let p = make_snippet("running runner ran", &parse_terms("run"));
        assert_eq!(hits_of(&p), vec!["running", "runner"]);
        // A finished word is exact: "run " must not light up "running".
        let p = make_snippet("running run", &parse_terms("run "));
        assert_eq!(hits_of(&p), vec!["run"]);
    }

    #[test]
    fn snippet_without_a_visible_match_still_shows_the_start() {
        let p = make_snippet("hello there", &parse_terms("zzz "));
        assert_eq!(plain(&p), "hello there");
        assert!(hits_of(&p).is_empty());
        assert!(make_snippet("", &parse_terms("x ")).is_empty());
    }

    #[test]
    fn guard_masks_a_leaky_snippet_and_drops_highlights() {
        let parts = vec![SnippetPart { text: "token=abcdefgh1234 ".into(), hit: false }, SnippetPart { text: "x".into(), hit: true }];
        let out = guard(parts);
        assert_eq!(out.len(), 1);
        assert!(!out[0].text.contains("abcdefgh"));
    }
}
