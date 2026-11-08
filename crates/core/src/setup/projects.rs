//! Which project folders exist, from three sources: `.claude.json` `projects`
//! keys, `githubRepoPaths`, and the first `cwd` of each transcript.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::model::fnv1a64;
use super::Cache;

/// Identity of a project path: absolute, separators unified, no trailing
/// separator, case-folded on Windows only.
pub fn norm_key(s: &str) -> String {
    let mut t = s.trim().to_string();
    if let Some(r) = t.strip_prefix(r"\\?\") {
        t = r.to_string();
    }
    if cfg!(windows) {
        t = t.replace('\\', "/");
    }
    // Collapse repeated separators (keep a leading pair: UNC).
    let lead = t.starts_with("//");
    let mut out = String::with_capacity(t.len());
    let mut prev_slash = false;
    for c in t.chars() {
        if c == '/' {
            if prev_slash {
                continue;
            }
            prev_slash = true;
        } else {
            prev_slash = false;
        }
        out.push(c);
    }
    if lead {
        out.insert(0, '/');
    }
    while out.len() > 1 && out.ends_with('/') && !out.ends_with(":/") {
        out.pop();
    }
    if cfg!(windows) {
        out = out.to_lowercase();
    }
    out
}

/// Claude Code's folder name for a project path: every non-alphanumeric
/// character becomes `-`. Lossy, so it is only ever compared, never decoded.
pub fn encode_lossy(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

pub fn project_id(key: &str) -> String {
    format!("p-{:012x}", fnv1a64(key) & 0xffff_ffff_ffff)
}

pub fn display_name(path: &str) -> String {
    let t = path.trim_end_matches(['/', '\\']);
    t.rsplit(['/', '\\']).next().filter(|s| !s.is_empty()).unwrap_or(t).to_string()
}

const WT_SEG: &str = "/.claude/worktrees/";

pub fn worktree_parent(key: &str) -> Option<String> {
    key.find(WT_SEG).map(|i| key[..i].to_string())
}

#[derive(Debug, Clone)]
pub struct Proj {
    pub id: String,
    pub key: String,
    /// The spelling to open on disk and to show.
    pub path: PathBuf,
    pub name: String,
    pub exists: bool,
    pub is_home: bool,
    pub is_worktree: bool,
    pub parent_key: Option<String>,
    pub last_activity_ms: i64,
    /// Inside (or equal to) the config folder: contributes no file items.
    pub under_root: bool,
}

#[derive(Debug, Clone, Default)]
pub struct Folder {
    /// The encoded folder name under `projects/`.
    pub enc: String,
    pub dir: PathBuf,
    pub cwds: Vec<String>,
    pub last_ms: i64,
    /// Markdown files under `memory/`.
    pub memory: Vec<PathBuf>,
}

fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The first `cwd` in the first 64 KB of a transcript, skipping `api-request*` lines.
fn probe_cwd_uncached(path: &Path) -> Option<String> {
    let mut f = fs::File::open(path).ok()?;
    let mut buf = vec![0u8; 64 * 1024];
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => n += k,
            Err(_) => break,
        }
    }
    buf.truncate(n);
    let text = String::from_utf8_lossy(&buf);
    for line in text.split('\n') {
        if line.starts_with("{\"type\":\"api-request") {
            continue;
        }
        let Some(i) = line.find("\"cwd\":") else { continue };
        let rest = line[i + 6..].trim_start();
        let mut de = serde_json::Deserializer::from_str(rest).into_iter::<String>();
        if let Some(Ok(s)) = de.next() {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}

fn probe_cwd(path: &Path, size: u64, mtime: i64, cache: &mut Cache) -> Option<String> {
    if let Some((s, m, v)) = cache.cwd.get(path) {
        if *s == size && *m == mtime {
            return v.clone();
        }
    }
    let v = probe_cwd_uncached(path);
    cache.cwd.insert(path.to_path_buf(), (size, mtime, v.clone()));
    v
}

fn list_memory(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![(dir.to_path_buf(), 0)];
    while let Some((d, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() && depth < 2 {
                stack.push((p, depth + 1));
            } else if ft.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("md")) {
                out.push(p);
            }
        }
    }
    out.sort();
    out
}

/// One pass over `projects/`: cwds, newest activity, memory files.
pub fn scan_folders(projects_dir: &Path, cache: &mut Cache) -> Vec<Folder> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(projects_dir) else { return out };
    for e in rd.flatten() {
        let Ok(ft) = e.file_type() else { continue };
        if !ft.is_dir() {
            continue;
        }
        let dir = e.path();
        let mut folder = Folder {
            enc: e.file_name().to_string_lossy().into_owned(),
            dir: dir.clone(),
            ..Default::default()
        };
        let mut transcripts: Vec<(PathBuf, u64, i64)> = Vec::new();
        if let Ok(files) = fs::read_dir(&dir) {
            for f in files.flatten() {
                let Ok(fft) = f.file_type() else { continue };
                let name = f.file_name();
                let name = name.to_string_lossy();
                if fft.is_file() && name.ends_with(".jsonl") {
                    let Ok(md) = f.metadata() else { continue };
                    let mt = mtime_ms(&md);
                    folder.last_ms = folder.last_ms.max(mt);
                    transcripts.push((f.path(), md.len(), mt));
                } else if fft.is_dir() && name == "memory" {
                    folder.memory = list_memory(&f.path());
                }
            }
        }
        // One folder is one project: the newest transcripts that name a cwd
        // are enough (a few probes at most, each reading 64 KB, cached).
        transcripts.sort_by(|a, b| b.2.cmp(&a.2));
        for (p, size, mt) in transcripts.iter().take(4) {
            if let Some(c) = probe_cwd(p, *size, *mt, cache) {
                folder.cwds.push(c);
                break;
            }
        }
        out.push(folder);
    }
    out
}

pub struct Collected {
    pub projects: Vec<Proj>,
    /// norm key -> index in `projects`.
    pub by_key: HashMap<String, usize>,
}

/// Merge the three project sources into one list, deduped by `norm_key`.
pub fn collect(
    root_dir: &Path,
    home: &Path,
    cj_keys: &[String],
    github_paths: &[String],
    folders: &[Folder],
    include_worktrees: bool,
) -> Collected {
    let root_key = norm_key(&root_dir.to_string_lossy());
    let home_key = norm_key(&home.to_string_lossy());
    let mut spelling: HashMap<String, String> = HashMap::new();
    let mut activity: HashMap<String, i64> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut add = |raw: &str, prefer: bool, ms: i64, spelling: &mut HashMap<String, String>, activity: &mut HashMap<String, i64>| {
        if raw.trim().is_empty() {
            return;
        }
        let k = norm_key(raw);
        if !spelling.contains_key(&k) {
            order.push(k.clone());
            spelling.insert(k.clone(), raw.to_string());
        } else if prefer {
            spelling.insert(k.clone(), raw.to_string());
        }
        let a = activity.entry(k).or_insert(0);
        *a = (*a).max(ms);
    };
    for p in cj_keys {
        add(p, false, 0, &mut spelling, &mut activity);
    }
    for p in github_paths {
        add(p, false, 0, &mut spelling, &mut activity);
    }
    for f in folders {
        for c in &f.cwds {
            add(c, true, f.last_ms, &mut spelling, &mut activity);
        }
    }
    let mut projects = Vec::new();
    for k in order {
        let raw = spelling[&k].clone();
        let is_worktree = k.contains(WT_SEG);
        if is_worktree && !include_worktrees {
            continue;
        }
        let path = PathBuf::from(&raw);
        let exists = path.is_dir();
        projects.push(Proj {
            id: project_id(&k),
            name: display_name(&raw),
            exists,
            is_home: k == home_key,
            is_worktree,
            parent_key: worktree_parent(&k),
            last_activity_ms: activity.get(&k).copied().unwrap_or(0),
            under_root: k == root_key || k.starts_with(&format!("{root_key}/")),
            path,
            key: k,
        });
    }
    let by_key = projects.iter().enumerate().map(|(i, p)| (p.key.clone(), i)).collect();
    Collected { projects, by_key }
}

/// Map an encoded `projects/<enc>` folder to a project key.
pub fn folder_project(folder: &Folder, c: &Collected) -> Option<String> {
    for cwd in &folder.cwds {
        let k = norm_key(cwd);
        if c.by_key.contains_key(&k) {
            return Some(k);
        }
    }
    // No transcript left: encode every known path the same lossy way.
    c.projects
        .iter()
        .find(|p| encode_lossy(&p.path.to_string_lossy()) == folder.enc)
        .map(|p| p.key.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spellings_of_one_path_share_a_key() {
        let a = norm_key("c:/Users/Will/Documents/app/");
        let b = norm_key(r"C:\Users\Will\Documents\app");
        if cfg!(windows) {
            assert_eq!(a, b);
        }
        assert!(!a.ends_with('/'));
    }

    #[test]
    fn lossy_encoding_replaces_every_symbol() {
        assert_eq!(encode_lossy(r"C:\Users\Will\x y"), "C--Users-Will-x-y");
    }

    #[test]
    fn worktree_paths_name_their_parent() {
        let k = norm_key("/w/app/.claude/worktrees/agent-1");
        assert_eq!(worktree_parent(&k).as_deref(), Some("/w/app"));
        assert_eq!(worktree_parent("/w/app"), None);
    }

    #[test]
    fn names_come_from_the_last_segment() {
        assert_eq!(display_name(r"C:\a\b\app\"), "app");
        assert_eq!(display_name("/a/b/c"), "c");
    }
}
