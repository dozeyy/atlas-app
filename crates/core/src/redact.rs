//! Redaction for files copied into a Sandbox.
//!
//! A sandbox is a throw-away copy, but it sits in the shared temp folder, so it
//! must not carry live secrets. `.claude.json`, `settings*.json` and MCP config
//! files hold tokens in `env` blocks, request headers, `--token` arguments, URL
//! query strings and OAuth/account records. This module blanks those *values*
//! and keeps the structure and every key, so the copy still looks and behaves
//! like the original for anything Atlas shows.
//!
//! Fails closed: text that is not valid JSON cannot be redacted structurally, so
//! `redact_json_bytes` returns `None` and the caller leaves the file out.

use serde_json::Value;

/// What a redacted string becomes.
pub const REDACTED: &str = "[redacted by Atlas]";

/// Files whose contents are redacted when copied into a sandbox: Claude Code's
/// global state, every `settings*.json`, and MCP server definitions.
pub fn needs_redaction(file_name: &str) -> bool {
    let n = file_name.to_ascii_lowercase();
    n == ".claude.json"
        || n == ".mcp.json"
        || n == "plugin.json"
        || n == "claude_desktop_config.json"
        || (n.starts_with("settings") && n.ends_with(".json"))
}

/// Parse `bytes` as JSON, blank every secret-looking value and write it back
/// out. `None` when the bytes are not JSON (the caller must not copy them raw).
pub fn redact_json_bytes(bytes: &[u8]) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(bytes).ok()?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut value: Value = serde_json::from_str(text).ok()?;
    walk(&mut value, false);
    let mut out = serde_json::to_vec_pretty(&value).ok()?;
    out.push(b'\n');
    Some(out)
}

/// Lowercase and drop everything that is not a letter or digit, so `api_key`,
/// `API-Key` and `apiKey` all compare as `apikey`.
fn normalize(key: &str) -> String {
    key.chars().filter(|c| c.is_ascii_alphanumeric()).map(|c| c.to_ascii_lowercase()).collect()
}

/// Objects whose every string value is a secret or personal (environment
/// variables passed to a server, request headers, an OAuth account record).
fn is_secret_container(norm: &str) -> bool {
    matches!(norm, "env" | "headers" | "httpheaders" | "environment" | "envvars") || norm.contains("oauth")
}

/// A key whose string value (or whole subtree of strings) is a secret.
fn is_secret_key(norm: &str) -> bool {
    const PARTS: [&str; 11] = [
        "token",
        "secret",
        "password",
        "passwd",
        "apikey",
        "authorization",
        "credential",
        "bearer",
        "cookie",
        "privatekey",
        "accesskey",
    ];
    const EXACT: [&str; 7] =
        ["auth", "userid", "anonymousid", "email", "emailaddress", "accountuuid", "organizationuuid"];
    PARTS.iter().any(|p| norm.contains(p)) || EXACT.contains(&norm)
}

fn walk(v: &mut Value, force: bool) {
    match v {
        Value::Object(map) => {
            for (k, child) in map.iter_mut() {
                let norm = normalize(k);
                let child_force = force || is_secret_container(&norm) || is_secret_key(&norm);
                if norm == "args"
                    && let Value::Array(items) = child {
                        redact_args(items);
                        continue;
                    }
                walk(child, child_force);
            }
        }
        Value::Array(items) => {
            for item in items {
                walk(item, force);
            }
        }
        Value::String(s) => {
            if force {
                *s = REDACTED.to_string();
            } else if let Some(clean) = redact_url(s) {
                *s = clean;
            }
        }
        _ => {}
    }
}

/// Command-line arguments: `--api-key=VALUE` and `--token VALUE` lose the value.
fn redact_args(items: &mut [Value]) {
    let mut redact_next = false;
    for item in items.iter_mut() {
        let Value::String(s) = item else {
            redact_next = false;
            continue;
        };
        if redact_next {
            redact_next = false;
            if !s.starts_with('-') {
                *s = REDACTED.to_string();
                continue;
            }
        }
        if let Some(flag) = s.strip_prefix('-') {
            let flag = flag.trim_start_matches('-');
            match flag.split_once('=') {
                Some((name, _)) if is_secret_key(&normalize(name)) => {
                    let name = s[..s.len() - flag.len()].to_string() + name;
                    *s = format!("{name}={REDACTED}");
                }
                None if is_secret_key(&normalize(flag)) => redact_next = true,
                _ => {}
            }
        } else if let Some(clean) = redact_url(s) {
            *s = clean;
        }
    }
}

/// `https://user:pass@host/x?token=abc&q=1` keeps its shape but loses the
/// password and the values of secret-looking query parameters. `None` when the
/// text is not a URL or there is nothing to blank.
fn redact_url(s: &str) -> Option<String> {
    let (scheme, rest) = s.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphabetic() || c == '+' || c == '-') {
        return None;
    }
    let (before_query, query) = match rest.split_once('?') {
        Some((a, b)) => (a, Some(b)),
        None => (rest, None),
    };
    let mut changed = false;

    // user:password@host
    let authority_end = before_query.find('/').unwrap_or(before_query.len());
    let (authority, path) = before_query.split_at(authority_end);
    let authority = match authority.rsplit_once('@') {
        Some((userinfo, host)) if userinfo.contains(':') => {
            changed = true;
            let user = userinfo.split_once(':').map_or(userinfo, |(u, _)| u);
            format!("{user}:{REDACTED}@{host}")
        }
        _ => authority.to_string(),
    };

    let query = query.map(|q| {
        let (q, fragment) = match q.split_once('#') {
            Some((a, b)) => (a, Some(b)),
            None => (q, None),
        };
        let parts: Vec<String> = q
            .split('&')
            .map(|pair| match pair.split_once('=') {
                Some((name, _)) if is_secret_key(&normalize(name)) => {
                    changed = true;
                    format!("{name}={REDACTED}")
                }
                _ => pair.to_string(),
            })
            .collect();
        let mut out = parts.join("&");
        if let Some(f) = fragment {
            out.push('#');
            out.push_str(f);
        }
        out
    });

    if !changed {
        return None;
    }
    let mut out = format!("{scheme}://{authority}{path}");
    if let Some(q) = query {
        out.push('?');
        out.push_str(&q);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(v: Value) -> Value {
        let out = redact_json_bytes(v.to_string().as_bytes()).expect("valid json");
        serde_json::from_slice(&out).unwrap()
    }

    #[test]
    fn env_values_and_headers_are_blanked_but_keys_stay() {
        let out = run(json!({
            "mcpServers": {
                "gh": {
                    "command": "npx",
                    "env": { "GITHUB_TOKEN": "ghp_live", "REGION": "us" },
                    "headers": { "Authorization": "Bearer abc", "X-Trace": "1" }
                }
            },
            "env": { "ANTHROPIC_API_KEY": "sk-ant-live" }
        }));
        let gh = &out["mcpServers"]["gh"];
        assert_eq!(gh["command"], "npx", "non-secret fields survive");
        assert_eq!(gh["env"]["GITHUB_TOKEN"], REDACTED);
        assert_eq!(gh["env"]["REGION"], REDACTED, "every env value goes, not only the ones that look secret");
        assert_eq!(gh["headers"]["Authorization"], REDACTED);
        assert_eq!(gh["headers"]["X-Trace"], REDACTED);
        assert_eq!(out["env"]["ANTHROPIC_API_KEY"], REDACTED);
        assert!(!out.to_string().contains("ghp_live"));
        assert!(!out.to_string().contains("sk-ant-live"));
    }

    #[test]
    fn oauth_account_and_credential_like_keys_are_blanked() {
        let out = run(json!({
            "oauthAccount": { "emailAddress": "dad@example.com", "organizationUuid": "u-1", "displayName": "Dad" },
            "primaryApiKey": "sk-live",
            "customApiKeyResponses": { "approved": ["abcd1234"] },
            "userID": "hash",
            "apiKeyHelper": "get-key.sh",
            "model": "opus",
            "numStartups": 12,
            "hasCompletedOnboarding": true,
            "maxTokens": 4096
        }));
        let text = out.to_string();
        for leaked in ["dad@example.com", "u-1", "Dad", "sk-live", "abcd1234", "hash", "get-key.sh"] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        assert_eq!(out["model"], "opus");
        assert_eq!(out["numStartups"], 12);
        assert_eq!(out["hasCompletedOnboarding"], true);
        assert_eq!(out["maxTokens"], 4096, "numbers are not secrets");
        assert!(out["oauthAccount"].as_object().unwrap().contains_key("emailAddress"), "keys stay");
    }

    #[test]
    fn secret_arguments_and_urls_lose_their_values() {
        let out = run(json!({
            "mcpServers": {
                "a": { "command": "srv", "args": ["--port", "80", "--api-key=KEY1", "--token", "TOK2", "-v", "ok"] },
                "b": { "type": "http", "url": "https://user:hunter2@host.example/mcp?api_key=KEY3&q=hello#frag" }
            }
        }));
        let text = out.to_string();
        for leaked in ["KEY1", "TOK2", "hunter2", "KEY3"] {
            assert!(!text.contains(leaked), "{leaked} leaked: {text}");
        }
        let args = out["mcpServers"]["a"]["args"].as_array().unwrap();
        assert_eq!(args[0], "--port");
        assert_eq!(args[1], "80");
        assert_eq!(args[2], format!("--api-key={REDACTED}"));
        assert_eq!(args[3], "--token");
        assert_eq!(args[4], REDACTED);
        assert_eq!(args[6], "ok");
        let url = out["mcpServers"]["b"]["url"].as_str().unwrap();
        assert!(url.starts_with("https://user:"));
        assert!(url.contains("host.example/mcp?"));
        assert!(url.contains("q=hello") && url.ends_with("#frag"));
    }

    #[test]
    fn plain_urls_and_text_are_left_alone() {
        let out = run(json!({ "homepage": "https://example.com/a?b=c", "note": "a://b", "list": ["x", "y"] }));
        assert_eq!(out["homepage"], "https://example.com/a?b=c");
        assert_eq!(out["list"], json!(["x", "y"]));
    }

    #[test]
    fn invalid_json_is_not_copied() {
        assert!(redact_json_bytes(b"{ // comment\n \"env\": {\"T\": \"secret\"} }").is_none());
        assert!(redact_json_bytes(b"\xff\xfe").is_none());
        assert!(redact_json_bytes(b"").is_none());
    }

    #[test]
    fn a_bom_is_tolerated() {
        let out = redact_json_bytes("\u{feff}{\"env\":{\"A\":\"b\"}}".as_bytes()).unwrap();
        assert!(!String::from_utf8(out).unwrap().contains("\"b\""));
    }

    #[test]
    fn file_names_that_get_redacted() {
        for yes in [".claude.json", "settings.json", "settings.local.json", "Settings.JSON", ".mcp.json", "plugin.json"] {
            assert!(needs_redaction(yes), "{yes}");
        }
        for no in ["CLAUDE.md", "package.json", "settings.md", "mysettings.json", "keybindings.json"] {
            assert!(!needs_redaction(no), "{no}");
        }
    }
}
