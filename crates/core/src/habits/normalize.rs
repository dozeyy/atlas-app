//! Turn a typed request into a comparable string (D32): the same ask in different words,
//! with different file names, numbers or quoted text, lands on nearly the same string.

/// Words a person puts in front of a request that say nothing about it, stripped from the
/// start, repeatedly. Two-word phrases first so "can you" is one filler.
const FILLERS: &[&[&str]] = &[&["please"], &["pls"], &["can", "you"], &["could", "you"], &["hey"], &["ok"], &["okay"], &["now"], &["claude"]];

pub fn normalize(text: &str) -> String {
    let lower = text.to_lowercase();
    let unquoted = replace_quoted(&lower);
    let mut words: Vec<String> = Vec::new();
    for tok in unquoted.split_whitespace() {
        let core = tok.trim_matches(|c: char| "()[]{}<>,;:!?.".contains(c));
        if is_url(core) {
            words.push("url".into());
        } else if is_path(core) {
            words.push("path".into());
        } else {
            for w in tok.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()) {
                words.push(if is_number(w) { "n".into() } else { w.to_string() });
            }
        }
    }
    strip_fillers(&mut words);
    words.join(" ")
}

fn strip_fillers(words: &mut Vec<String>) {
    loop {
        let hit = FILLERS.iter().find(|f| words.len() >= f.len() && f.iter().zip(words.iter()).all(|(a, b)| a == b));
        match hit {
            Some(f) => {
                words.drain(..f.len());
            }
            None => return,
        }
    }
}

/// Quoted or backticked spans become the word `q`. A single quote only opens a span at a word
/// start and closes before a non-letter, so "don't" and "the user's" are left alone.
fn replace_quoted(s: &str) -> String {
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < cs.len() {
        if let Some(end) = span_end(&cs, i) {
            out.push_str(" q ");
            i = end + 1;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

/// If a non-empty quoted span opens at `i`, the index of its closing quote.
fn span_end(cs: &[char], i: usize) -> Option<usize> {
    let close = match cs[i] {
        c @ ('"' | '`') => c,
        '\u{201c}' => '\u{201d}',
        '\u{2018}' => '\u{2019}',
        '\'' if (i == 0 || !cs[i - 1].is_alphanumeric()) && cs.get(i + 1).is_some_and(|n| n.is_alphanumeric()) => '\'',
        _ => return None,
    };
    let single = close == '\'' || close == '\u{2019}';
    let mut j = i + 1;
    while j < cs.len() {
        // A single-quote closer followed by a letter is an apostrophe inside the span.
        if cs[j] == close && !(single && cs.get(j + 1).is_some_and(|n| n.is_alphanumeric())) {
            return (j > i + 1).then_some(j);
        }
        j += 1;
    }
    None
}

fn is_url(t: &str) -> bool {
    ["http://", "https://", "ftp://", "www."].iter().any(|p| t.starts_with(p))
}

fn is_path(t: &str) -> bool {
    if t.len() < 2 {
        return false;
    }
    if t.contains('\\') || t.starts_with("~/") || t.starts_with("./") || t.starts_with("../") {
        return true;
    }
    let segs: Vec<&str> = t.split('/').filter(|s| !s.is_empty()).collect();
    if segs.len() < 2 {
        return false;
    }
    // "/a/b" is a path. "src/app.rs" and "a/b/c" are paths. "and/or" and "yes/no" are words.
    t.starts_with('/') || segs.len() >= 3 || segs.last().is_some_and(|l| l.contains('.'))
}

/// `42`, `3rd`, `10x`: a number. `v2`, `h264` are names and stay.
fn is_number(w: &str) -> bool {
    let total = w.chars().count();
    let digits = w.chars().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && w.chars().skip(digits).all(|c| c.is_alphabetic()) && total - digits <= 2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_paths_numbers_and_quotes_collapse() {
        assert_eq!(normalize("Open https://example.com/a?b=1 and src\\lib\\x.ts, line 42"), "open url and path line n");
        assert_eq!(normalize("fix ~/notes/todo.md and /usr/local/bin"), "fix path and path");
        assert_eq!(normalize("rename 'old name' to \"new name\" in `file.txt`"), "rename q to q in q");
        assert_eq!(normalize("the 3rd of 10x and v2"), "the n of n and v2");
    }

    #[test]
    fn apostrophes_and_slashes_in_words_are_not_spans_or_paths() {
        assert_eq!(normalize("don't touch the user's file and/or yes/no"), "don t touch the user s file and or yes no");
    }

    #[test]
    fn leading_fillers_go_everything_else_stays() {
        assert_eq!(normalize("Hey Claude, please can you now run the tests"), "run the tests");
        assert_eq!(normalize("ok okay pls Run the tests please"), "run the tests please");
        assert_eq!(normalize("could you check the build"), "check the build");
        assert_eq!(normalize("now"), "");
    }
}
