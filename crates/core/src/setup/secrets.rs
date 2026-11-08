//! Finding and hiding secret values. The real value never leaves this module
//! except through `reveal`, one value at a time, on an explicit click.
//!
//! What counts as secret:
//! - every value under an `env` or `headers` key, wherever it sits;
//! - a string under a key that names a secret (token, password, api key ...);
//! - a word that looks like a well-known token (sk-..., ghp_..., JWT ...) or the
//!   value of a `NAME_TOKEN=...` pair, anywhere in any text.

use serde::Serialize;

pub const MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

/// A masked span in the text the viewer received. Offsets are UTF-16 code
/// units (what JavaScript and CodeMirror count).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MaskedRange {
    pub start: usize,
    pub end: usize,
    /// The key it belongs to, or "value" for a loose token.
    pub key: String,
    /// Position among the masked values of this source (what `reveal` takes).
    pub index: usize,
}

pub struct Masked {
    pub text: String,
    pub ranges: Vec<MaskedRange>,
    /// Same order as `ranges`. Dropped by callers except `reveal`.
    pub originals: Vec<String>,
}

pub fn is_sensitive_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["token", "secret", "password", "passwd", "apikey", "api_key", "api-key", "authorization", "credential", "private_key", "private-key", "privatekey", "cookie", "bearer"]
        .iter()
        .any(|w| k.contains(w))
}

fn is_container_key(key: &str) -> bool {
    key.eq_ignore_ascii_case("env") || key.eq_ignore_ascii_case("headers")
}

fn trim_word(w: &str) -> &str {
    w.trim_matches(|c: char| matches!(c, '"' | '\'' | '\\' | ',' | ';' | '(' | ')' | '[' | ']' | '{' | '}' | '`'))
}

pub fn looks_like_secret(word: &str) -> bool {
    let w = trim_word(word);
    if w.len() < 16 {
        return false;
    }
    let prefixed = ["sk-", "sk_", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-", "AKIA", "ASIA", "AIza", "glpat-", "npm_", "pk_live", "rk_live", "shpat_", "hf_", "fal_", "key-"]
        .iter()
        .any(|p| w.starts_with(p));
    if prefixed && w.len() >= 20 {
        return true;
    }
    if w.starts_with("eyJ") && w.matches('.').count() == 2 && w.len() > 30 {
        return true;
    }
    w.len() >= 40 && w.chars().all(|c| c.is_ascii_hexdigit())
}

/// Byte spans inside `s` that hold a loose secret: token-looking words, the
/// value of `SECRETY_NAME=value`, the value after `Bearer`, and secret-named
/// query parameters.
pub fn inline_secret_spans(s: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut prev_word = "";
    for word in s.split_whitespace() {
        // `word` is a slice of `s`: its offset is the pointer difference.
        let start = word.as_ptr() as usize - s.as_ptr() as usize;
        // NAME=value (also --flag=value) and URL query parameters.
        let mut handled = false;
        let mut seg_start = 0;
        for (p, c) in word.char_indices().chain(std::iter::once((word.len(), '&'))) {
            if c == '&' || c == '?' || p == word.len() {
                let seg = &word[seg_start..p];
                if let Some(eq) = seg.find('=') {
                    let key = seg[..eq].trim_start_matches('-');
                    let val = &seg[eq + 1..];
                    let val_t = trim_word(val);
                    if is_sensitive_key(key) && val_t.len() >= 6 && !val_t.starts_with('$') && !val_t.starts_with("${") {
                        if let Some(off) = val.find(val_t) {
                            let a = start + seg_start + eq + 1 + off;
                            spans.push((a, a + val_t.len()));
                            handled = true;
                        }
                    }
                }
                seg_start = p + 1;
            }
        }
        if !handled {
            let t = trim_word(word);
            let after_bearer = prev_word.eq_ignore_ascii_case("bearer") && t.len() >= 8 && !t.starts_with('$');
            if looks_like_secret(t) || after_bearer {
                if let Some(off) = word.find(t) {
                    spans.push((start + off, start + off + t.len()));
                }
            }
        }
        prev_word = trim_word(word);
    }
    spans.sort_unstable();
    spans.dedup();
    spans
}

/// Replace secret-looking parts of one line of text with dots (cards, hook
/// commands, MCP summaries). No ranges: this is for short descriptions.
pub fn redact_inline(s: &str) -> String {
    let spans = inline_secret_spans(s);
    if spans.is_empty() {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut at = 0;
    for (a, b) in spans {
        if a < at {
            continue;
        }
        out.push_str(&s[at..a]);
        out.push_str(MASK);
        at = b;
    }
    out.push_str(&s[at..]);
    out
}

struct Builder {
    out: String,
    utf16: usize,
    ranges: Vec<MaskedRange>,
    originals: Vec<String>,
}

impl Builder {
    fn push(&mut self, s: &str) {
        self.out.push_str(s);
        self.utf16 += s.encode_utf16().count();
    }
    fn mask(&mut self, key: &str, original: &str) {
        let start = self.utf16;
        self.push(MASK);
        self.ranges.push(MaskedRange { start, end: self.utf16, key: key.to_string(), index: self.ranges.len() });
        self.originals.push(original.to_string());
    }
}

#[derive(Clone)]
struct Frame {
    is_obj: bool,
    /// The key of the member being read (objects only).
    key: String,
    /// Inside an `env` / `headers` value: everything below is secret.
    secret: bool,
    /// Waiting for a key (object) rather than a value.
    expect_key: bool,
}

/// Mask a JSON (or JSON-like) text. Tolerant: it tokenises, it does not validate.
// `flush_to!` keeps `copied` current; the write before the final flush is unread by design.
#[allow(unused_assignments)]
pub fn mask_json(text: &str) -> Masked {
    let b = text.as_bytes();
    let mut s = Builder { out: String::with_capacity(text.len()), utf16: 0, ranges: Vec::new(), originals: Vec::new() };
    let mut stack: Vec<Frame> = Vec::new();
    let mut i = 0;
    let mut copied = 0; // bytes of `text` already pushed
    macro_rules! flush_to {
        ($end:expr) => {{
            let end = $end;
            if end > copied {
                s.push(&text[copied..end]);
                copied = end;
            }
        }};
    }
    while i < b.len() {
        let c = b[i];
        match c {
            b'{' => {
                let parent_secret = stack.last().map(|f| f.secret).unwrap_or(false);
                let secret = parent_secret || stack.last().map(|f| f.is_obj && is_container_key(&f.key)).unwrap_or(false);
                stack.push(Frame { is_obj: true, key: String::new(), secret, expect_key: true });
                i += 1;
            }
            b'[' => {
                let parent_secret = stack.last().map(|f| f.secret).unwrap_or(false);
                let secret = parent_secret || stack.last().map(|f| f.is_obj && is_container_key(&f.key)).unwrap_or(false);
                let key = stack.last().map(|f| f.key.clone()).unwrap_or_default();
                stack.push(Frame { is_obj: false, key, secret, expect_key: false });
                i += 1;
            }
            b'}' | b']' => {
                stack.pop();
                i += 1;
            }
            b',' => {
                if let Some(f) = stack.last_mut() {
                    if f.is_obj {
                        f.expect_key = true;
                    }
                }
                i += 1;
            }
            b':' => {
                if let Some(f) = stack.last_mut() {
                    f.expect_key = false;
                }
                i += 1;
            }
            b'"' => {
                let start = i;
                i += 1;
                while i < b.len() {
                    if b[i] == b'\\' {
                        i += 2;
                        continue;
                    }
                    if b[i] == b'"' {
                        break;
                    }
                    i += 1;
                }
                let end = (i + 1).min(b.len());
                let inner_end = i.min(b.len());
                let raw_inner = &text[(start + 1).min(inner_end)..inner_end];
                i = end;
                let is_key = stack.last().map(|f| f.is_obj && f.expect_key).unwrap_or(false);
                if is_key {
                    let k = serde_json::from_str::<String>(&text[start..end]).unwrap_or_else(|_| raw_inner.to_string());
                    if let Some(f) = stack.last_mut() {
                        f.key = k;
                    }
                    continue;
                }
                // A string value.
                let (secret_ctx, key) = match stack.last() {
                    Some(f) => (f.secret, f.key.clone()),
                    None => (false, String::new()),
                };
                if !raw_inner.is_empty() && (secret_ctx || is_sensitive_key(&key)) && !raw_inner.starts_with("${") && !raw_inner.starts_with('$') {
                    flush_to!(start + 1);
                    let original = serde_json::from_str::<String>(&text[start..end]).unwrap_or_else(|_| raw_inner.to_string());
                    s.mask(&key, &original);
                    copied = inner_end;
                } else {
                    // Loose secrets inside an ordinary string (a hook command, an arg).
                    for (a, z) in inline_secret_spans(raw_inner) {
                        let abs_a = start + 1 + a;
                        let abs_z = start + 1 + z;
                        if abs_a < copied {
                            continue;
                        }
                        flush_to!(abs_a);
                        let original = text[abs_a..abs_z].to_string();
                        s.mask("value", &original);
                        copied = abs_z;
                    }
                }
            }
            b' ' | b'\n' | b'\r' | b'\t' => i += 1,
            _ => {
                // number / true / false / null
                let start = i;
                while i < b.len() && !matches!(b[i], b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t' | b':') {
                    i += 1;
                }
                let in_secret = stack.last().map(|f| f.secret).unwrap_or(false);
                if in_secret && start < i {
                    let key = stack.last().map(|f| f.key.clone()).unwrap_or_default();
                    flush_to!(start);
                    s.mask(&key, &text[start..i]);
                    copied = i;
                }
            }
        }
    }
    flush_to!(text.len());
    Masked { text: s.out, ranges: s.ranges, originals: s.originals }
}

/// Mask loose secrets in a non-JSON text (markdown, shell, scripts).
pub fn mask_plain(text: &str) -> Masked {
    let mut s = Builder { out: String::with_capacity(text.len()), utf16: 0, ranges: Vec::new(), originals: Vec::new() };
    let mut line_start = 0;
    for line in text.split_inclusive('\n') {
        let mut at = 0;
        for (a, z) in inline_secret_spans(line) {
            if a < at {
                continue;
            }
            s.push(&text[line_start + at..line_start + a]);
            s.mask("value", &line[a..z]);
            at = z;
        }
        s.push(&text[line_start + at..line_start + line.len()]);
        line_start += line.len();
    }
    Masked { text: s.out, ranges: s.ranges, originals: s.originals }
}

/// The original text of masked value `index` in `text` (JSON or plain).
pub fn reveal(text: &str, json: bool, index: usize) -> Option<String> {
    let m = if json { mask_json(text) } else { mask_plain(text) };
    m.originals.into_iter().nth(index)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "FIXTURE-PLACEHOLDER";

    #[test]
    fn env_and_headers_values_are_masked_keys_stay() {
        let t = format!(
            "{{\n  \"mcpServers\": {{\"a\": {{\"command\": \"x\", \"env\": {{\"SECRET_TOKEN\": \"{SECRET}\", \"N\": 5}}, \"headers\": {{\"Authorization\": \"Bearer {SECRET}\"}}}}}}\n}}"
        );
        let m = mask_json(&t);
        assert!(!m.text.contains(SECRET), "{}", m.text);
        assert!(m.text.contains("SECRET_TOKEN") && m.text.contains("Authorization"));
        assert_eq!(m.ranges.len(), 3);
        assert_eq!(m.originals[0], SECRET);
        assert_eq!(reveal(&t, true, 0).as_deref(), Some(SECRET));
        // Offsets point at the dots in the masked text.
        let r = &m.ranges[0];
        let units: Vec<u16> = m.text.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[r.start..r.end]).unwrap(), MASK);
    }

    #[test]
    fn variable_references_are_not_secrets() {
        let m = mask_json("{\"env\": {\"A\": \"${PROJ_TOKEN}\"}}");
        assert!(m.text.contains("${PROJ_TOKEN}"));
        assert!(m.ranges.is_empty());
    }

    #[test]
    fn sensitive_key_outside_env_is_masked() {
        let m = mask_json("{\"apiKey\": \"abcdef123456\", \"model\": \"x\"}");
        assert!(!m.text.contains("abcdef123456"));
        assert!(m.text.contains("\"x\""));
    }

    #[test]
    fn loose_tokens_in_commands_are_masked() {
        let t = "{\"command\": \"curl -H 'X: 1' --token=abcdef123456789 sk-abcdefghijklmnopqrstuvwxyz\"}";
        let m = mask_json(t);
        assert!(!m.text.contains("abcdef123456789"));
        assert!(!m.text.contains("sk-abcdef"));
        assert!(m.text.contains("curl"));
        assert_eq!(redact_inline("run --api-key=abcdefgh1234 now"), format!("run --api-key={MASK} now"));
    }

    #[test]
    fn plain_text_masks_pairs() {
        let m = mask_plain("export MY_SECRET_TOKEN=abcdefghijk\necho hi\n");
        assert!(!m.text.contains("abcdefghijk"));
        assert!(m.text.contains("echo hi"));
    }

    #[test]
    fn utf16_offsets_count_astral_characters() {
        let t = "{\"note\": \"\u{1F600}\", \"env\": {\"K\": \"v1234567\"}}";
        let m = mask_json(t);
        let units: Vec<u16> = m.text.encode_utf16().collect();
        let r = &m.ranges[0];
        assert_eq!(String::from_utf16(&units[r.start..r.end]).unwrap(), MASK);
    }

    #[test]
    fn untouched_text_is_identical() {
        let t = "{\n  \"a\": [1, 2, {\"b\": \"c\"}],\n  \"d\": null\n}\n";
        let m = mask_json(t);
        assert_eq!(m.text, t);
    }

    #[test]
    fn multibyte_text_around_secrets_survives_and_offsets_hold() {
        // 2-byte, 3-byte and 4-byte characters before and after each value.
        let t = "{\"n\": \"caf\u{e9} \u{65e5}\u{672c}\", \"env\": {\"API_KEY\": \"s\u{e9}cret-\u{65e5}-1234\", \"Z\": \"\u{1F600}x\"}, \"tail\": \"\u{e9}\u{65e5}\u{1F600}\"}";
        let m = mask_json(t);
        assert!(!m.text.contains("s\u{e9}cret"), "{}", m.text);
        assert!(m.text.contains("caf\u{e9} \u{65e5}\u{672c}") && m.text.contains("\u{e9}\u{65e5}\u{1F600}\""));
        let units: Vec<u16> = m.text.encode_utf16().collect();
        for (r, o) in m.ranges.iter().zip(&m.originals) {
            assert_eq!(String::from_utf16(&units[r.start..r.end]).unwrap(), MASK);
            assert!(!o.is_empty());
        }
        assert_eq!(reveal(t, true, 0).as_deref(), Some("s\u{e9}cret-\u{65e5}-1234"));
        let p = mask_plain("caf\u{e9}\u{65e5} password=hunter2-\u{e9}\u{65e5}x tail \u{1F600}\n");
        assert!(!p.text.contains("hunter2") && p.text.contains("tail \u{1F600}"), "{}", p.text);
    }
}
