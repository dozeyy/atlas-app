//! A pasted GitHub link, turned into (owner, repo, ref, folder).
//!
//! Accepted (D16): `owner/repo`, `github.com/owner/repo`, `https://github.com/owner/repo[.git]`,
//! `.../tree/<ref>/<folder>`, `.../blob/<ref>/<file>` (its folder) and `git@github.com:o/r.git`.
//! Anything else gets one sentence. A branch name with a slash in it cannot be told apart from a
//! folder in a `tree` link, so the ref is the first segment after `tree`.

/// The one sentence every rejected link gets.
pub const BAD_LINK: &str = "Paste a GitHub link, like github.com/owner/repo.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Link {
    pub owner: String,
    pub repo: String,
    /// Branch, tag or commit. `None` means the repository's default branch (`HEAD`).
    pub git_ref: Option<String>,
    /// A folder inside the repository (no leading or trailing slash).
    pub path: Option<String>,
}

impl Link {
    /// `owner/repo`, the form Claude Code's marketplace command takes.
    pub fn slug(&self) -> String {
        format!("{}/{}", self.owner, self.repo)
    }

    /// The ref to download (`HEAD` when the link named none).
    pub fn ref_or_head(&self) -> &str {
        self.git_ref.as_deref().unwrap_or("HEAD")
    }
}

fn valid_owner(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !s.starts_with('-') && !s.ends_with('-')
}

fn valid_repo(s: &str) -> bool {
    !s.is_empty() && s.len() <= 100 && s != "." && s != ".." && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// A path segment or a ref: plain characters only (no `..`, no `%`, no backslash, no colon).
fn valid_segment(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && s.len() <= 200 && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+' | '@' | '=' | ',' | '~'))
}

pub fn parse(text: &str) -> Result<Link, &'static str> {
    let t = text.trim();
    if t.is_empty() || t.chars().any(|c| c.is_whitespace() || c.is_control()) || t.len() > 400 {
        return Err(BAD_LINK);
    }
    // Drop a query or a fragment (`?tab=readme`, `#readme`).
    let t = t.split(['?', '#']).next().unwrap_or("");

    // `git@github.com:owner/repo.git`
    if let Some(rest) = t.strip_prefix("git@github.com:") {
        return from_parts(&rest.split('/').collect::<Vec<_>>());
    }
    let rest = if let Some(r) = t.strip_prefix("https://") {
        r
    } else if t.contains("://") {
        // http://, ssh://, git:// ...
        return Err(BAD_LINK);
    } else {
        t
    };
    let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
    match parts.first().map(|h| h.to_ascii_lowercase()) {
        Some(h) if h == "github.com" || h == "www.github.com" => from_parts(&parts[1..]),
        // `owner/repo` and nothing else: the first part is not a host name.
        Some(h) if !h.contains('.') || valid_owner(&h) => from_parts(&parts),
        _ => Err(BAD_LINK),
    }
}

fn from_parts(parts: &[&str]) -> Result<Link, &'static str> {
    if parts.len() < 2 {
        return Err(BAD_LINK);
    }
    let owner = parts[0];
    let repo = parts[1].strip_suffix(".git").unwrap_or(parts[1]);
    if !valid_owner(owner) || !valid_repo(repo) {
        return Err(BAD_LINK);
    }
    let mut link = Link { owner: owner.to_string(), repo: repo.to_string(), git_ref: None, path: None };
    match &parts[2..] {
        [] => Ok(link),
        // `tree/<ref>` or `tree/<ref>/<folder...>`; `blob/<ref>/<file...>` uses the file's folder.
        [kind @ ("tree" | "blob"), git_ref, rest @ ..] => {
            if !valid_segment(git_ref) || !rest.iter().all(|s| valid_segment(s)) {
                return Err(BAD_LINK);
            }
            link.git_ref = Some((*git_ref).to_string());
            let folder: &[&str] = if *kind == "blob" {
                if rest.is_empty() {
                    return Err(BAD_LINK);
                }
                &rest[..rest.len() - 1]
            } else {
                rest
            };
            if !folder.is_empty() {
                link.path = Some(folder.join("/"));
            }
            Ok(link)
        }
        _ => Err(BAD_LINK),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(s: &str) -> Link {
        parse(s).unwrap_or_else(|e| panic!("{s:?} should parse: {e}"))
    }
    fn link(owner: &str, repo: &str, r: Option<&str>, p: Option<&str>) -> Link {
        Link { owner: owner.into(), repo: repo.into(), git_ref: r.map(Into::into), path: p.map(Into::into) }
    }

    #[test]
    fn every_accepted_form() {
        let plain = link("pbakaus", "impeccable", None, None);
        for s in [
            "pbakaus/impeccable",
            "github.com/pbakaus/impeccable",
            "https://github.com/pbakaus/impeccable",
            "https://github.com/pbakaus/impeccable/",
            "https://github.com/pbakaus/impeccable.git",
            "https://www.github.com/pbakaus/impeccable",
            "git@github.com:pbakaus/impeccable.git",
            "  https://github.com/pbakaus/impeccable?tab=readme-ov-file#install  ",
        ] {
            assert_eq!(ok(s), plain, "{s}");
        }
        assert_eq!(ok("https://github.com/o/r/tree/main"), link("o", "r", Some("main"), None));
        assert_eq!(ok("https://github.com/o/r/tree/v1.2.0/skills/pdf"), link("o", "r", Some("v1.2.0"), Some("skills/pdf")));
        assert_eq!(ok("https://github.com/o/r/blob/main/skills/pdf/SKILL.md"), link("o", "r", Some("main"), Some("skills/pdf")));
        assert_eq!(ok("https://github.com/o/r/blob/main/SKILL.md"), link("o", "r", Some("main"), None));
        assert_eq!(ok("o/r").slug(), "o/r");
        assert_eq!(ok("o/r").ref_or_head(), "HEAD");
        assert_eq!(ok("github.com/o/r.with.dots").repo, "r.with.dots");
    }

    #[test]
    fn rejects_get_the_one_sentence() {
        for s in [
            "",
            "   ",
            "https://gitlab.com/o/r",
            "https://gist.github.com/o/abc123",
            "https://raw.githubusercontent.com/o/r/main/SKILL.md",
            "https://github.com/o/r/tree/main/../../etc",
            "https://github.com/o/r/tree/..",
            "o/r/../x",
            "../r",
            "https://github.com/o r",
            "https://github.com/o/r/issues",
            "https://github.com/o/r/issues/5",
            "https://github.com/o/r/pulls",
            "https://github.com/o",
            "https://github.com/",
            "github.com",
            "http://github.com/o/r",
            "ssh://git@github.com/o/r.git",
            "git@gitlab.com:o/r.git",
            "o",
            "o/r/extra",
            "https://github.com/o/r/blob/main",
            "https://github.com/-o/r",
            "https://github.com/o/r%2e%2e",
            "https://github.com/o/r/tree/main/a\\b",
            "just some words",
        ] {
            assert_eq!(parse(s), Err(BAD_LINK), "{s:?}");
        }
    }
}
