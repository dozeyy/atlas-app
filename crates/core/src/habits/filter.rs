//! Which user lines may count as "a request the person typed" (D31).
//!
//! Runs on text that is already secret-masked and capped by the search index. A line that
//! fails any test here is never grouped, never shown and never counted.

/// Shortest and longest prompt, in characters after trimming.
pub const MIN_CHARS: usize = 12;
pub const MAX_CHARS: usize = 400;
pub const MIN_WORDS: usize = 3;
/// A prompt with this many lines or more is a paste, not a request.
pub const MAX_LINES: usize = 6;
/// Letters must be at least this share (percent) of the non-space characters: logs, paths
/// and stack traces are mostly symbols and digits.
pub const MIN_LETTER_PCT: usize = 60;

/// True when `text` looks like something the person typed as a request.
pub fn keep(text: &str) -> bool {
    let t = text.trim();
    let chars = t.chars().count();
    if !(MIN_CHARS..=MAX_CHARS).contains(&chars) {
        return false;
    }
    // A secret was here (the index masks it as `***`): never repeat what is left.
    if t.contains("***") || t.contains("```") {
        return false;
    }
    if t.lines().count() >= MAX_LINES || t.split_whitespace().count() < MIN_WORDS {
        return false;
    }
    // A bracketed harness line: "[Request interrupted by user]", "[Image #1]", "[Pasted text #2]".
    if t.starts_with('[') && t.ends_with(']') {
        return false;
    }
    let mut first = t.chars();
    match first.next() {
        // A slash command, or a path typed alone.
        Some('/') => return false,
        // A machine tag: <command-name>, <task-notification>, <system-reminder>, ...
        Some('<') if first.next().is_some_and(|c| c.is_alphabetic()) => return false,
        _ => {}
    }
    let (mut letters, mut visible) = (0usize, 0usize);
    for c in t.chars().filter(|c| !c.is_whitespace()) {
        visible += 1;
        if c.is_alphabetic() {
            letters += 1;
        }
    }
    letters * 100 >= visible * MIN_LETTER_PCT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_request_is_kept() {
        assert!(keep("Read the README and give me a three bullet summary in plain words"));
        assert!(keep("  can you fix the failing test in the parser?  "));
    }

    #[test]
    fn what_is_dropped_and_why() {
        let table: &[(&str, &str)] = &[
            ("slash command", "/review-changes please check the diff"),
            ("command tag", "<command-name>/clear</command-name> and some more words"),
            ("task tag", "<task-notification>build finished with 0 errors</task-notification>"),
            ("system tag", "<system-reminder>remember the rules of this chat please</system-reminder>"),
            ("code fence", "run this ```npm test``` and tell me what it says"),
            ("too short", "fix it now"),
            ("two words", "continue please"),
            ("masked secret", "deploy with the key *** to staging please"),
            ("log lines", "error one\nerror two\nerror three\nerror four\nerror five\nerror six"),
            ("mostly symbols", "12:01:33 [4412] 0x7ffe 8812 9921 1203 4421 5567 1111"),
            ("interrupt marker", "[Request interrupted by user for tool use]"),
            ("interrupt marker long", "[Request interrupted by user while the build was running in the background]"),
            ("image marker", "[Image #1] [Image #2] [Image #3] [Image #4] [Image #5]"),
            ("a path", "C:\\work\\atlas\\src\\wrappedModel.ts 1203 3404 5605 7806 9907 1111"),
        ];
        for (why, text) in table {
            assert!(!keep(text), "{why}: {text}");
        }
        assert!(!keep(&"word ".repeat(100)), "over 400 characters");
        // A `<` that is not a tag stays.
        assert!(keep("<3 the new tour screen, can you make the next one the same"));
        // A bracket in the middle of a real request stays.
        assert!(keep("[WIP] fix the failing parser test and tell me what changed"));
    }
}
