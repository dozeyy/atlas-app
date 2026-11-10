//! The plugin catalog: Claude Code's `plugin list --available --json`, parsed, cached in Atlas's
//! own data folder, and searched in memory (D10, D11, D25).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::fsutil::atomic_write;

pub const SCHEMA_VERSION: u32 = 1;
/// The marketplace Claude Code ships with.
pub const DIRECTORY: &str = "anthropic-plugin-directory";

/// Where a plugin's files come from, as far as Atlas needs to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Source {
    /// A GitHub repository (the whole repo, or `path` inside it), pinned to `sha` when known.
    Github {
        repo: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        sha: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        /// The branch or tag Claude Code installs when there is no `sha` (HEAD when neither is set).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        git_ref: Option<String>,
    },
    /// A folder inside the marketplace's own repository (`./plugin`).
    Local { path: String },
    /// Installing it runs a command (`command`, `npm`): Atlas does not offer it.
    Command,
    /// Some other git host or an unknown shape: Claude Code can install it, Atlas cannot read it.
    Other { url: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub marketplace: String,
    pub version: String,
    pub source: Source,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogFile {
    pub schema_version: u32,
    pub fetched_ms: u64,
    pub entries: Vec<Entry>,
}

/// `https://github.com/o/r(.git)` -> `o/r`.
fn github_repo(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://github.com/").or_else(|| url.strip_prefix("http://github.com/"))?;
    let rest = rest.trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut it = rest.split('/');
    let (o, r) = (it.next()?, it.next()?);
    (it.next().is_none() && !o.is_empty() && !r.is_empty()).then(|| format!("{o}/{r}"))
}

fn sha_of(v: &Value) -> Option<String> {
    v.get("sha").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_hexdigit())).map(str::to_string)
}

/// A branch or tag name that is safe to put in a download address: letters, digits and `. _ - /`,
/// no `..`, no leading dash or slash, no empty parts.
pub fn valid_git_ref(r: &str) -> bool {
    !r.is_empty()
        && r.len() <= 200
        && !r.starts_with(['-', '/'])
        && !r.ends_with(['/', '.'])
        && !r.contains("..")
        && !r.contains("//")
        && !r.ends_with(".lock")
        && r.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-' | '/'))
}

/// The `ref` a catalog source names: `Ok(None)` when it names none, `Err` when it names one Atlas
/// can't safely turn into an address (the plugin is then "not readable", never read from HEAD).
fn ref_of(v: &Value) -> Result<Option<String>, ()> {
    match v.get("ref") {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) if s.is_empty() => Ok(None),
        Some(Value::String(s)) if valid_git_ref(s) => Ok(Some(s.clone())),
        Some(_) => Err(()),
    }
}

fn parse_source(v: &Value) -> Source {
    match v {
        Value::String(p) => Source::Local { path: p.clone() },
        Value::Object(m) => {
            let kind = m.get("source").and_then(Value::as_str).unwrap_or("");
            let url = m.get("url").and_then(Value::as_str).unwrap_or("");
            let path = m.get("path").and_then(Value::as_str).map(|p| p.trim_start_matches("./").trim_matches('/').to_string()).filter(|p| !p.is_empty());
            let git_ref = ref_of(v);
            match kind {
                "url" | "git-subdir" => match (github_repo(url), git_ref) {
                    (Some(repo), Ok(git_ref)) => Source::Github { repo, sha: sha_of(v), path, git_ref },
                    _ => Source::Other { url: url.to_string() },
                },
                "github" => match (m.get("repo").and_then(Value::as_str), git_ref) {
                    (Some(r), Ok(git_ref)) if r.matches('/').count() == 1 => Source::Github { repo: r.to_string(), sha: sha_of(v), path, git_ref },
                    _ => Source::Other { url: String::new() },
                },
                "npm" | "command" => Source::Command,
                _ => Source::Other { url: url.to_string() },
            }
        }
        _ => Source::Other { url: String::new() },
    }
}

/// The catalog from the text `claude plugin list --available --json` printed.
pub fn parse_available(json: &str) -> Result<Vec<Entry>, String> {
    let v: Value = serde_json::from_str(json).map_err(|_| "Claude Code's plugin list was not in the shape Atlas expects.".to_string())?;
    let list = v.get("available").and_then(Value::as_array).ok_or_else(|| "Claude Code's plugin list has no catalog in it.".to_string())?;
    let mut out = Vec::with_capacity(list.len());
    for e in list {
        let (Some(id), Some(name), Some(mp)) = (e.get("pluginId").and_then(Value::as_str), e.get("name").and_then(Value::as_str), e.get("marketplaceName").and_then(Value::as_str)) else { continue };
        out.push(Entry {
            plugin_id: id.to_string(),
            name: name.to_string(),
            description: e.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
            marketplace: mp.to_string(),
            version: e.get("version").and_then(Value::as_str).unwrap_or("").to_string(),
            source: parse_source(e.get("source").unwrap_or(&Value::Null)),
        });
    }
    Ok(out)
}

/// The marketplace files Claude Code already keeps on this computer, read without running
/// anything: what the Library shows on the very first visit, while the real list is fetched. Same
/// entries `list --available` would give for those marketplaces (a plugin's `source` is the same
/// value), so an install from one of these rows takes the same checked path.
pub fn read_local(marketplaces: &[(String, PathBuf)]) -> Vec<Entry> {
    const MAX_BYTES: u64 = 16 * 1024 * 1024;
    let mut out = Vec::new();
    for (mp, loc) in marketplaces {
        let file = if loc.is_file() { loc.clone() } else { loc.join(".claude-plugin").join("marketplace.json") };
        let Ok(md) = fs::metadata(&file) else { continue };
        if !md.is_file() || md.len() > MAX_BYTES {
            continue;
        }
        let Some(v) = fs::read(&file).ok().and_then(|b| serde_json::from_slice::<Value>(b.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&b)).ok()) else { continue };
        for p in v.get("plugins").and_then(Value::as_array).into_iter().flatten() {
            let Some(name) = p.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) else { continue };
            out.push(Entry {
                plugin_id: format!("{name}@{mp}"),
                name: name.to_string(),
                description: p.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
                marketplace: mp.clone(),
                version: p.get("version").and_then(Value::as_str).unwrap_or("").to_string(),
                source: parse_source(p.get("source").unwrap_or(&Value::Null)),
            });
        }
    }
    out
}

pub fn cache_path(data: &Path) -> PathBuf {
    super::library_dir(data).join("catalog.json")
}

/// The cached catalog, or `None` when there is none yet or it cannot be read (a stray temp file
/// from a write that was cut off is never looked at).
pub fn read_cache(data: &Path) -> Option<CatalogFile> {
    let bytes = fs::read(cache_path(data)).ok()?;
    let f: CatalogFile = serde_json::from_slice(&bytes).ok()?;
    (f.schema_version == SCHEMA_VERSION).then_some(f)
}

/// Where the cached catalog says `plugin_id` comes from right now.
pub fn source_of(data: &Path, plugin_id: &str) -> Option<Source> {
    read_cache(data)?.entries.into_iter().find(|e| e.plugin_id == plugin_id).map(|e| e.source)
}

pub fn write_cache(data: &Path, entries: Vec<Entry>, now_ms: u64) -> std::io::Result<()> {
    let f = CatalogFile { schema_version: SCHEMA_VERSION, fetched_ms: now_ms, entries };
    atomic_write(&cache_path(data), serde_json::to_string(&f).map_err(std::io::Error::other)?.as_bytes())
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

fn tokens(s: &str) -> Vec<String> {
    s.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).map(str::to_string).collect()
}

/// The words in `query` (case-folded).
pub fn query_words(query: &str) -> Vec<String> {
    tokens(query)
}

/// Does every query word begin some word of `text`? (The last word is usually half typed, so a
/// prefix is enough for all of them.)
fn all_prefix(words: &[String], text_tokens: &[String]) -> bool {
    words.iter().all(|w| text_tokens.iter().any(|t| t.starts_with(w.as_str())))
}

/// How well `e` answers the query: lower is better, `None` means it does not match.
pub fn rank(e: &Entry, words: &[String], whole: &str) -> Option<u8> {
    if words.is_empty() {
        return Some(5);
    }
    let name = e.name.to_lowercase();
    if name == whole {
        return Some(0);
    }
    if name.starts_with(whole) {
        return Some(1);
    }
    let name_tokens = tokens(&e.name);
    if all_prefix(words, &name_tokens) {
        return Some(2);
    }
    let mut with_mp = name_tokens;
    with_mp.extend(tokens(&e.marketplace));
    if all_prefix(words, &with_mp) {
        return Some(3);
    }
    with_mp.extend(tokens(&e.description));
    all_prefix(words, &with_mp).then_some(4)
}

/// Entries that match `query`, best first (a shorter name wins a tie, then alphabetical order).
/// An empty query returns everything in catalog order.
pub fn search<'a>(entries: &'a [Entry], query: &str, limit: usize) -> Vec<&'a Entry> {
    let words = query_words(query);
    if words.is_empty() {
        return entries.iter().take(limit).collect();
    }
    let whole = query.trim().to_lowercase();
    let mut hits: Vec<(u8, &Entry)> = entries.iter().filter_map(|e| rank(e, &words, &whole).map(|r| (r, e))).collect();
    hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.name.len().cmp(&b.1.name.len())).then_with(|| a.1.name.cmp(&b.1.name)));
    hits.into_iter().take(limit).map(|(_, e)| e).collect()
}

/// What the MCP tool `search_library` returns for one entry.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub plugin_id: String,
    pub name: String,
    pub description: String,
    pub marketplace: String,
    pub version: String,
    pub installed: bool,
}

pub const NO_CATALOG: &str = "Open Toolkit > Library in Atlas once so it can load the plugin catalog.";

/// `search_library`: read-only, from the cached catalog. No network, no command.
pub fn search_library(data: &Path, installed_ids: &[String], query: &str, limit: usize) -> Result<Vec<SearchHit>, String> {
    let cat = read_cache(data).ok_or_else(|| NO_CATALOG.to_string())?;
    Ok(search(&cat.entries, query, limit.clamp(1, 20))
        .into_iter()
        .map(|e| SearchHit {
            plugin_id: e.plugin_id.clone(),
            name: e.name.clone(),
            description: e.description.clone(),
            marketplace: e.marketplace.clone(),
            version: e.version.clone(),
            installed: installed_ids.contains(&e.plugin_id),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(id: &str, name: &str, desc: &str, mp: &str) -> Entry {
        Entry { plugin_id: id.into(), name: name.into(), description: desc.into(), marketplace: mp.into(), version: String::new(), source: Source::Command }
    }

    #[test]
    fn the_marketplace_files_on_disk_give_rows_before_the_first_refresh() {
        let t = tempfile::tempdir().unwrap();
        let mp = t.path().join("official");
        fs::create_dir_all(mp.join(".claude-plugin")).unwrap();
        fs::write(
            mp.join(".claude-plugin").join("marketplace.json"),
            r#"{"name":"official","plugins":[
              {"name":"local-one","description":"d","source":"./plugins/local-one"},
              {"name":"gh","version":"1.2.0","source":{"source":"github","repo":"o/r","ref":"payload"}},
              {"name":"bad-ref","source":{"source":"github","repo":"o/r","ref":"../x"}},
              {"description":"no name"}]}"#,
        )
        .unwrap();
        let got = read_local(&[("official".into(), mp.clone()), ("missing".into(), t.path().join("nope"))]);
        assert_eq!(got.len(), 3, "a plugin with no name and a marketplace with no file are skipped");
        assert_eq!(got[0].plugin_id, "local-one@official");
        assert_eq!(got[0].source, Source::Local { path: "./plugins/local-one".into() });
        assert!(matches!(&got[1].source, Source::Github { git_ref: Some(r), .. } if r == "payload"));
        assert!(matches!(got[2].source, Source::Other { .. }), "an unusable branch is unreadable, never HEAD");
    }

    #[test]
    fn sources_of_every_shape() {
        let v: Value = serde_json::from_str(
            r#"{"available":[
            {"pluginId":"a@m","name":"a","marketplaceName":"m","source":{"source":"url","url":"https://github.com/o/r.git","sha":"0412be76f50ab4f4f8abff3753efa9269fbbca5b"}},
            {"pluginId":"b@m","name":"b","marketplaceName":"m","source":{"source":"git-subdir","url":"https://github.com/o/r","path":"plugins/b","sha":"abcdef0"}},
            {"pluginId":"c@m","name":"c","marketplaceName":"m","source":"./plugin"},
            {"pluginId":"d@m","name":"d","marketplaceName":"m","source":{"source":"npm","package":"x"}},
            {"pluginId":"e@m","name":"e","marketplaceName":"m","source":{"source":"url","url":"https://gitlab.com/o/r.git"}},
            {"pluginId":"f@m","name":"f","marketplaceName":"m","source":{"source":"github","repo":"o/r"}},
            {"name":"no id","marketplaceName":"m"}
            ]}"#,
        )
        .unwrap();
        let got = parse_available(&v.to_string()).unwrap();
        assert_eq!(got.len(), 6, "the entry without an id is skipped");
        assert_eq!(got[0].source, Source::Github { repo: "o/r".into(), sha: Some("0412be76f50ab4f4f8abff3753efa9269fbbca5b".into()), path: None, git_ref: None });
        assert_eq!(got[1].source, Source::Github { repo: "o/r".into(), sha: Some("abcdef0".into()), path: Some("plugins/b".into()), git_ref: None });
        assert_eq!(got[2].source, Source::Local { path: "./plugin".into() });
        assert_eq!(got[3].source, Source::Command);
        assert_eq!(got[4].source, Source::Other { url: "https://gitlab.com/o/r.git".into() });
        assert_eq!(got[5].source, Source::Github { repo: "o/r".into(), sha: None, path: None, git_ref: None });
    }

    #[test]
    fn a_ref_is_kept_and_an_unusable_one_makes_the_plugin_unreadable() {
        // Review finding 2: Claude Code installs the named ref, so Atlas must check that ref, not HEAD.
        let v = r#"{"available":[
            {"pluginId":"a@m","name":"a","marketplaceName":"m","source":{"source":"github","repo":"o/r","ref":"payload"}},
            {"pluginId":"b@m","name":"b","marketplaceName":"m","source":{"source":"url","url":"https://github.com/o/r.git","ref":"release/1.2","path":"p"}},
            {"pluginId":"c@m","name":"c","marketplaceName":"m","source":{"source":"github","repo":"o/r","ref":"../../x"}},
            {"pluginId":"d@m","name":"d","marketplaceName":"m","source":{"source":"github","repo":"o/r","ref":"a b"}},
            {"pluginId":"e@m","name":"e","marketplaceName":"m","source":{"source":"github","repo":"o/r","ref":7}},
            {"pluginId":"f@m","name":"f","marketplaceName":"m","source":{"source":"github","repo":"o/r","ref":""}}
            ]}"#;
        let got = parse_available(v).unwrap();
        assert_eq!(got[0].source, Source::Github { repo: "o/r".into(), sha: None, path: None, git_ref: Some("payload".into()) });
        assert_eq!(got[1].source, Source::Github { repo: "o/r".into(), sha: None, path: Some("p".into()), git_ref: Some("release/1.2".into()) });
        for i in [2, 3, 4] {
            assert!(matches!(got[i].source, Source::Other { .. }), "{i}: {:?}", got[i].source);
        }
        assert_eq!(got[5].source, Source::Github { repo: "o/r".into(), sha: None, path: None, git_ref: None });
        for bad in ["-x", "/x", "x/", "a..b", "a//b", "a b", "a?b", "x.lock", "", "x%2e"] {
            assert!(!valid_git_ref(bad), "{bad}");
        }
        assert!(valid_git_ref("v1.2.3") && valid_git_ref("feature/x-y_z"));
    }

    #[test]
    fn bad_input_is_one_sentence() {
        assert!(parse_available("not json").is_err());
        assert!(parse_available("{}").unwrap_err().contains("no catalog"));
    }

    #[test]
    fn search_ranks_the_name_first_and_matches_every_word() {
        let list = vec![
            e("x@m", "web-frontend-helper", "Helps with design", "m"),
            e("frontend-design@m", "frontend-design", "Frontend design skill", "m"),
            e("y@m", "pdf", "Read PDFs. Great for frontend docs", "m"),
            e("z@other", "zzz", "unrelated", "other"),
        ];
        let names: Vec<&str> = search(&list, "frontend", 10).iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["frontend-design", "web-frontend-helper", "pdf"]);
        let names: Vec<&str> = search(&list, "front des", 10).iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["frontend-design", "web-frontend-helper"], "the last word is a prefix, every word must match");
        assert_eq!(search(&list, "OTHER", 10).len(), 1, "the marketplace counts, case does not");
        assert!(search(&list, "nothing like this", 10).is_empty());
        assert_eq!(search(&list, "", 2).len(), 2);
    }

    #[test]
    fn the_cache_round_trips_and_a_cut_off_write_leaves_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_cache(dir.path()).is_none());
        let a = vec![e("a@m", "a", "first", "m")];
        write_cache(dir.path(), a.clone(), 111).unwrap();
        let got = read_cache(dir.path()).unwrap();
        assert_eq!((got.fetched_ms, got.entries), (111, a.clone()));
        // A write killed after the temp file and before the rename leaves a half file beside it.
        fs::write(super::super::library_dir(dir.path()).join(".catalog.json.atlas-tmp-1-0"), b"{\"schemaVersion\":1,\"fetc").unwrap();
        assert_eq!(read_cache(dir.path()).unwrap().entries, a);
        // A newer write replaces it whole.
        write_cache(dir.path(), vec![e("b@m", "b", "", "m")], 222).unwrap();
        assert_eq!(read_cache(dir.path()).unwrap().fetched_ms, 222);
        // A file from another schema is ignored, not misread.
        fs::write(cache_path(dir.path()), b"{\"schemaVersion\":9,\"fetchedMs\":1,\"entries\":[]}").unwrap();
        assert!(read_cache(dir.path()).is_none());
    }

    #[test]
    fn search_library_says_what_to_do_when_there_is_no_catalog() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(search_library(dir.path(), &[], "x", 5).unwrap_err(), NO_CATALOG);
        write_cache(dir.path(), vec![e("a@m", "alpha", "", "m")], 1).unwrap();
        let hits = search_library(dir.path(), &["a@m".to_string()], "alp", 99).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].installed);
    }
}
