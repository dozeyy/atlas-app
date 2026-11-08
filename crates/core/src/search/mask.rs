//! Secret masking for chat text (project rule: nothing that looks like a secret reaches
//! the index, a snippet, a log or a screenshot).
//!
//! No regex crate: one pass over whitespace/quote-delimited tokens. It errs towards
//! masking. Masked spans become `***` (punctuation, so the tokenizer never indexes it).
//!
//! What is caught: vendor key prefixes (Anthropic/OpenAI `sk-`, GitHub, Slack, AWS, Google,
//! npm, Hugging Face, GitLab), JWTs, PEM private-key blocks, `Bearer <token>`, passwords
//! inside URLs, `NAME=value` / `"name": "value"` where the name says password, secret,
//! token, key or credential, and long mixed letter+digit tokens. Pure hex strings and
//! UUIDs are left alone (hashes and ids are far more common in dev chat than hex keys).

use std::borrow::Cow;

pub const MASK: &str = "***";

/// A masked copy of `text`, or `text` itself when nothing looked secret.
pub fn mask_secrets(text: &str) -> Cow<'_, str> {
    if text.len() < 8 {
        return Cow::Borrowed(text);
    }
    let mut out: Option<String> = None;
    let mut copied = 0usize; // bytes of `text` already copied into `out`
    let mut pem_until: Option<usize> = None;
    let mut mask_next = false; // previous token was a sensitive `name:` / `name=` / `Bearer`
    let mut pos = 0usize;
    let bytes = text.as_bytes();

    while pos < bytes.len() {
        // Skip delimiters.
        let Some(start) = text[pos..].find(|c: char| !is_delim(c)).map(|i| pos + i) else { break };
        let end = text[start..].find(is_delim).map(|i| start + i).unwrap_or(text.len());
        pos = end;
        if let Some(until) = pem_until
            && start < until
        {
            continue;
        }
        let tok = &text[start..end];
        let mut hit: Option<(usize, usize)> = None; // byte range inside text to replace

        if tok.starts_with("-----BEGIN") && text[start..].contains("PRIVATE KEY") {
            // Mask through the matching END line (or the end of the text).
            let stop = text[start..]
                .find("-----END")
                .and_then(|i| text[start + i + 8..].find("-----").map(|j| start + i + 8 + j + 5))
                .unwrap_or(text.len());
            hit = Some((start, stop));
            pem_until = Some(stop);
        } else if mask_next && !tok.chars().any(|c| c.is_alphanumeric()) {
            // `"password" : "x"` / `key = x`: the separator is not the value; keep waiting.
            continue;
        } else if mask_next && tok.len() >= 6 && !tok.eq_ignore_ascii_case("bearer") {
            hit = Some((start, end));
        } else if let Some((vs, ve)) = inline_value(tok) {
            hit = Some((start + vs, start + ve));
        } else if let Some((vs, ve)) = url_password(tok) {
            hit = Some((start + vs, start + ve));
        } else if looks_like_secret(tok) {
            hit = Some((start, end));
        }

        mask_next = false;
        match hit {
            Some((a, b)) if b > a => {
                let o = out.get_or_insert_with(|| String::with_capacity(text.len()));
                o.push_str(&text[copied..a]);
                o.push_str(MASK);
                copied = b;
            }
            _ => {
                // `Bearer`, `password:`, `API_KEY=` -> the next token is the value.
                let t = tok.trim_matches(|c: char| !c.is_alphanumeric());
                let followed_by_sep = text[end..].trim_start_matches(['"', '\'', ' ']).starts_with([':', '=']);
                if t.eq_ignore_ascii_case("bearer")
                    || (tok.ends_with([':', '=']) && sensitive_name(tok))
                    || (followed_by_sep && sensitive_name(t))
                {
                    mask_next = true;
                }
            }
        }
    }
    match out {
        None => Cow::Borrowed(text),
        Some(mut o) => {
            o.push_str(&text[copied..]);
            Cow::Owned(o)
        }
    }
}

/// True when `text` would be changed by `mask_secrets`.
pub fn contains_secret(text: &str) -> bool {
    matches!(mask_secrets(text), Cow::Owned(_))
}

fn is_delim(c: char) -> bool {
    c.is_whitespace() || matches!(c, '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']' | '{' | '}' | ',' | ';' | '\u{1}' | '\u{2}')
}

/// Does a name (the part before `:`/`=`) say it holds a secret?
fn sensitive_name(name: &str) -> bool {
    let n: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
    ["password", "passwd", "secret", "token", "apikey", "privatekey", "credential", "authorization", "accesskey", "clientsecret"]
        .iter()
        .any(|k| n.contains(k))
        || n.ends_with("key") && n.len() > 3 && n != "monkey" && n != "hotkey" && n != "keykey"
            && (n.contains("api") || n.contains("secret") || n.contains("private") || n.contains("access") || n.contains("auth") || n.contains("signing") || n.contains("encryption"))
}

/// `NAME=value` / `name:value` inside one token: the byte range of the value.
fn inline_value(tok: &str) -> Option<(usize, usize)> {
    let i = tok.find(['=', ':'])?;
    if i == 0 || i + 1 >= tok.len() {
        return None;
    }
    // `https://...` is not name:value.
    if tok[i..].starts_with("://") {
        return None;
    }
    let (name, value) = (&tok[..i], &tok[i + 1..]);
    let value_trim = value.trim_start_matches(['=', ':']);
    let vs = i + 1 + (value.len() - value_trim.len());
    if (value_trim.len() >= 6 && sensitive_name(name)) || looks_like_secret(value_trim) {
        return Some((vs, tok.len()));
    }
    None
}

/// `scheme://user:pass@host`: the byte range of `pass`.
fn url_password(tok: &str) -> Option<(usize, usize)> {
    let s = tok.find("://")? + 3;
    let rest = &tok[s..];
    let at = rest.find('@')?;
    let userinfo = &rest[..at];
    if userinfo.contains('/') {
        return None;
    }
    let colon = userinfo.find(':')?;
    if colon + 1 >= userinfo.len() {
        return None;
    }
    Some((s + colon + 1, s + at))
}

fn all(tok: &str, f: impl Fn(u8) -> bool) -> bool {
    tok.bytes().all(f)
}

fn looks_like_secret(tok: &str) -> bool {
    // Peel trailing punctuation a sentence adds.
    let t = tok.trim_end_matches(['.', ':', '!', '?']);
    let t = t.trim_start_matches(['=', ':']);
    let n = t.len();
    if n < 16 {
        return false;
    }
    let tail_ok = |min: usize| n >= min && all(t, |b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'+' | b'/' | b'='));
    if (t.starts_with("sk-") || t.starts_with("rk-") || t.starts_with("pk-live") || t.starts_with("sk_live") || t.starts_with("sk_test")) && tail_ok(20) {
        return true;
    }
    for p in ["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "xoxb-", "xoxp-", "xoxa-", "xoxs-", "xoxr-", "npm_", "hf_", "AIza", "ya29."] {
        if t.starts_with(p) && n >= p.len() + 16 && tail_ok(p.len() + 16) {
            return true;
        }
    }
    if (t.starts_with("AKIA") || t.starts_with("ASIA")) && n == 20 && all(t, |b| b.is_ascii_uppercase() || b.is_ascii_digit()) {
        return true;
    }
    if t.starts_with("eyJ") && t.matches('.').count() == 2 && n >= 30 && tail_ok(30) {
        return true;
    }
    // Generic: a long run of [A-Za-z0-9_-] with both letters and digits.
    if n >= 32 && all(t, |b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        let has_digit = t.bytes().any(|b| b.is_ascii_digit());
        let has_alpha = t.bytes().any(|b| b.is_ascii_alphabetic());
        let hex = all(t, |b| b.is_ascii_hexdigit());
        let uuid = n == 36 && t.matches('-').count() == 4;
        return has_digit && has_alpha && !hex && !uuid && !t.contains("--");
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(s: &str) -> String {
        mask_secrets(s).into_owned()
    }

    #[test]
    fn plain_text_is_untouched_and_borrowed() {
        let s = "please refactor the parser so tokens are counted once";
        assert!(matches!(mask_secrets(s), Cow::Borrowed(_)));
        assert_eq!(m("the api key is stored in the keychain"), "the api key is stored in the keychain");
    }

    #[test]
    fn vendor_prefixes() {
        assert_eq!(m("use sk-ant-api03-AbCdEf0123456789xyzXYZ now"), "use *** now");
        assert_eq!(m("export GH=ghp_abcdefghijklmnop1234567890ABCD done"), "export GH=*** done");
        assert_eq!(m("key AKIAIOSFODNN7EXAMPLE end"), "key *** end");
        assert_eq!(m("slack xoxb-1234567890-abcdefghijklmnop"), "slack ***");
    }

    #[test]
    fn jwt_and_bearer() {
        assert_eq!(m("tok eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk x"), "tok *** x");
        assert_eq!(m("Authorization: Bearer abc123def456ghi789"), "Authorization: Bearer ***");
    }

    #[test]
    fn named_values() {
        assert_eq!(m("DB_PASSWORD=hunter2hunter2 next"), "DB_PASSWORD=*** next");
        assert_eq!(m(r#"{"api_key": "abcdef123456"}"#), r#"{"api_key": "***"}"#);
        assert_eq!(m("password: s3cretValue ok"), "password: *** ok");
        // Prose after a `password:` label is masked too: erring towards masking.
        assert_eq!(m("the password: required here"), "the password: *** here");
    }

    #[test]
    fn url_credentials() {
        assert_eq!(m("postgres://admin:topsecret99@db.local:5432/x"), "postgres://admin:***@db.local:5432/x");
        assert_eq!(m("see https://example.com/a/b?x=1 ok"), "see https://example.com/a/b?x=1 ok");
    }

    #[test]
    fn pem_block() {
        let s = "key:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter";
        let out = m(s);
        assert!(!out.contains("MIIEow"), "{out}");
        assert!(out.starts_with("key:\n***"), "{out}");
        assert!(out.ends_with("\nafter"), "{out}");
    }

    #[test]
    fn long_mixed_tokens_but_not_hashes_uuids_or_words() {
        assert_eq!(m("tok Zm9vYmFyMTIzNDU2Nzg5MGFiY2RlZmdoaWo end"), "tok *** end");
        // sha256 (pure hex), a uuid, a long identifier without digits, a path
        assert_eq!(m("sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"), "sha 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
        assert_eq!(m("id 123e4567-e89b-12d3-a456-426614174000 x"), "id 123e4567-e89b-12d3-a456-426614174000 x");
        assert_eq!(m("fn handle_a_very_long_identifier_name_for_things()"), "fn handle_a_very_long_identifier_name_for_things()");
        assert_eq!(m("C:/Users/Will/Documents/Desktop Apps/atlas/crates/core/src/search/mod.rs"), "C:/Users/Will/Documents/Desktop Apps/atlas/crates/core/src/search/mod.rs");
    }

    #[test]
    fn multibyte_text_survives() {
        assert_eq!(m("caf\u{e9} \u{2014} password=\u{e9}\u{e9}\u{e9}\u{e9}\u{e9}\u{e9} fin"), "caf\u{e9} \u{2014} password=*** fin");
    }

    #[test]
    fn contains_secret_matches_mask() {
        assert!(contains_secret("token=abcdefgh1234"));
        assert!(!contains_secret("nothing to see here at all"));
    }
}
