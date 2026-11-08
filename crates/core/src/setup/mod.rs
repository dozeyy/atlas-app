//! Setup (read only): find every Claude Code setup item at every scope.
//!
//! `discover` is a pure function of the files on disk and `DiscoveryInputs`; it
//! reads the environment never, writes nothing and holds no file handle after
//! it returns. The page gets a `SetupSnapshot` (no file bodies); a body is
//! fetched one at a time with `Discovery::read_source`.

pub mod capability;
pub mod claude_json;
pub mod files;
pub mod frontmatter;
pub mod mcp;
pub mod model;
pub mod plugins;
pub mod projects;
pub mod secrets;
pub mod settings_items;
pub mod shadow;
pub mod source;
pub mod watch;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Instant, UNIX_EPOCH};

use serde_json::Value;

use crate::fsutil::strip_verbatim;
use crate::paths::ConfigRoot;

pub use model::*;
use claude_json::CjView;
use frontmatter::MdMeta;
use projects::{Collected, Folder, Proj};
use settings_items::SettingsFile;

/// Where an organisation's managed files live on this platform.
pub fn default_managed_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        Some(PathBuf::from(r"C:\Program Files\ClaudeCode"))
    } else if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Library/Application Support/ClaudeCode"))
    } else {
        Some(PathBuf::from("/etc/claude-code"))
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveryInputs {
    pub root: ConfigRoot,
    pub home: PathBuf,
    /// Where the organisation's managed files live, if anywhere.
    pub managed_dir: Option<PathBuf>,
    /// List agent worktree folders as projects too (the page hides them by default).
    pub include_worktrees: bool,
    /// Sandbox Mode is on: project items are the real files, not copies.
    pub sandboxed: bool,
}

/// Per-process caches keyed by path, size and modified time. Never holds a
/// secret value: markdown heads (descriptions) and transcript cwds only.
#[derive(Default)]
pub struct Cache {
    pub(crate) md: HashMap<PathBuf, (u64, i64, Arc<MdMeta>)>,
    pub(crate) cwd: HashMap<PathBuf, (u64, i64, Option<String>)>,
    pub(crate) last_cj: Option<Arc<CjView>>,
}

/// Where an item's text comes from.
#[derive(Debug, Clone)]
pub enum SourceRef {
    File { path: PathBuf },
    /// One server entry inside a JSON file (`.claude.json`, `.mcp.json`...).
    JsonEntry { file: PathBuf, pointer: Vec<String> },
    /// Names only: nothing on disk to open.
    Text(String),
}

pub struct Discovery {
    pub snapshot: SetupSnapshot,
    pub(crate) sources: HashMap<String, SourceRef>,
    pub(crate) root_dir: PathBuf,
    /// Folders to watch: project folders that were scanned.
    pub(crate) watched_projects: Vec<PathBuf>,
}

/// Who an item belongs to.
#[derive(Debug, Clone)]
pub struct ScopeCtx {
    pub kind: ScopeKind,
    /// (id, name)
    pub project: Option<(String, String)>,
    pub plugin: Option<String>,
    pub worktree: bool,
    pub real_project: bool,
}

impl ScopeCtx {
    pub fn user() -> Self {
        ScopeCtx { kind: ScopeKind::User, project: None, plugin: None, worktree: false, real_project: false }
    }
    pub fn simple(kind: ScopeKind) -> Self {
        ScopeCtx { kind, project: None, plugin: None, worktree: false, real_project: false }
    }
    pub fn label(&self) -> String {
        let pn = || self.project.as_ref().map(|p| p.1.clone()).unwrap_or_else(|| "Unknown project".into());
        match self.kind {
            ScopeKind::User => "Global".into(),
            ScopeKind::Project => format!("Project \u{b7} {}", pn()),
            ScopeKind::Local => format!("Local \u{b7} {}", pn()),
            ScopeKind::Plugin => format!("Plugin \u{b7} {}", self.plugin.clone().unwrap_or_default()),
            ScopeKind::Synced | ScopeKind::Connector => "claude.ai".into(),
            ScopeKind::Managed => "Managed".into(),
        }
    }
}

pub(crate) struct Build<'a> {
    pub inputs: &'a DiscoveryInputs,
    pub cache: &'a mut Cache,
    pub items: Vec<SetupItem>,
    pub sources: HashMap<String, SourceRef>,
    pub seen: HashSet<String>,
    pub root_key: String,
    pub cj: Option<Arc<CjView>>,
    pub col: Collected,
    pub folders: Vec<Folder>,
    pub settings: Vec<SettingsFile>,
    pub scripts: HashMap<String, settings_items::Script>,
    /// plugin id (`name@market`) -> install path
    pub plugin_paths: HashMap<String, PathBuf>,
    pub watched_projects: Vec<PathBuf>,
}

impl Build<'_> {
    /// Fill the shared fields, assign the id and store the source. Returns the
    /// index, or None when the same item was already added.
    pub(crate) fn add(&mut self, mut item: SetupItem, scope: &ScopeCtx, id_path: &Path, pointer: &str, src: SourceRef) -> Option<usize> {
        let norm = projects::norm_key(&id_path.to_string_lossy());
        item.id = item_id(item.kind, &norm, pointer);
        if !self.seen.insert(item.id.clone()) {
            return None;
        }
        item.scope = scope.kind;
        item.scope_label = scope.label();
        item.project_id = scope.project.as_ref().map(|p| p.0.clone());
        item.plugin = scope.plugin.clone();
        item.worktree = scope.worktree;
        item.real_project_file = scope.real_project && self.inputs.sandboxed;
        self.sources.insert(item.id.clone(), src);
        self.items.push(item);
        Some(self.items.len() - 1)
    }

    /// Markdown facts for a file, from the cache or the first 16 KB.
    pub(crate) fn md_meta(&mut self, path: &Path, size: u64, mtime: i64) -> Arc<MdMeta> {
        if let Some((s, m, v)) = self.cache.md.get(path) {
            if *s == size && *m == mtime {
                return v.clone();
            }
        }
        let mut text = read_head(path, frontmatter::HEAD_BYTES).unwrap_or_default();
        if frontmatter::needs_more(&text) && size as usize > frontmatter::HEAD_BYTES {
            text = read_head(path, frontmatter::WIDE_BYTES).unwrap_or(text);
        }
        let meta = Arc::new(frontmatter::analyze(&text));
        self.cache.md.insert(path.to_path_buf(), (size, mtime, meta.clone()));
        meta
    }
}

/// Read up to `cap` bytes from the start of a file as text. Opens, reads,
/// closes: no handle outlives the call.
pub(crate) fn read_head(path: &Path, cap: usize) -> Option<String> {
    let f = fs::File::open(path).ok()?;
    let mut buf = Vec::with_capacity(cap.min(64 * 1024));
    f.take(cap as u64).read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub(crate) fn mtime_ms(m: &fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn display_path(p: &Path) -> String {
    strip_verbatim(p).to_string_lossy().into_owned()
}

/// Read `<cj>` with one retry after 100 ms; fall back to the last good copy.
fn load_cj(root: &ConfigRoot, cache: &mut Cache) -> (Option<Arc<CjView>>, &'static str) {
    let mut res = claude_json::read(&root.claude_json);
    if res.is_err() {
        std::thread::sleep(std::time::Duration::from_millis(100));
        res = claude_json::read(&root.claude_json);
    }
    match res {
        Ok(Some(v)) => {
            let v = Arc::new(v);
            cache.last_cj = Some(v.clone());
            (Some(v), "ok")
        }
        Ok(None) => (None, "missing"),
        Err(_) => match cache.last_cj.clone() {
            Some(v) => (Some(v), "stale"),
            None => (None, "unreadable"),
        },
    }
}

pub fn discover(inputs: &DiscoveryInputs, cache: &mut Cache) -> Discovery {
    let started = Instant::now();
    let root = &inputs.root;
    let (cj, cj_state) = load_cj(root, cache);

    let folders = projects::scan_folders(&root.projects_dir, cache);
    let cj_keys: Vec<String> = cj.as_ref().map(|c| c.projects.iter().map(|p| p.key.clone()).collect()).unwrap_or_default();
    let gh: Vec<String> = cj.as_ref().map(|c| c.github_paths.clone()).unwrap_or_default();
    let col = projects::collect(&root.dir, &inputs.home, &cj_keys, &gh, &folders, inputs.include_worktrees);

    let mut b = Build {
        inputs,
        cache,
        items: Vec::new(),
        sources: HashMap::new(),
        seen: HashSet::new(),
        root_key: projects::norm_key(&root.dir.to_string_lossy()),
        cj,
        col,
        folders,
        settings: Vec::new(),
        scripts: HashMap::new(),
        plugin_paths: HashMap::new(),
        watched_projects: Vec::new(),
    };

    b.scan_user_scope();
    b.scan_managed();
    b.scan_projects();
    b.scan_memory();
    b.scan_plugins();
    b.derive_settings_items();
    b.derive_scripts();
    b.assemble_mcp();
    b.compute_enabled();
    shadow::apply(&mut b.items);

    let snapshot = b.finish(cj_state, started);
    let mut d = Discovery {
        snapshot,
        sources: std::mem::take(&mut b.sources),
        root_dir: root.dir.clone(),
        watched_projects: std::mem::take(&mut b.watched_projects),
    };
    for item in &mut d.snapshot.items {
        let cap = capability::capability(item, d.sources.get(&item.id));
        item.editable = cap.editable;
        item.deletable = cap.deletable;
        item.locked = cap.locked;
    }
    d
}

impl Build<'_> {
    fn finish(&mut self, cj_state: &str, started: Instant) -> SetupSnapshot {
        let mut hidden = HiddenCounts::default();
        let mut counts: HashMap<String, (u32, u32)> = HashMap::new(); // project id -> (items, local mcp)
        for it in &self.items {
            if it.backup {
                hidden.backups += 1;
            }
            if let Some(pid) = &it.project_id {
                let e = counts.entry(pid.clone()).or_default();
                if !it.backup {
                    e.0 += 1;
                }
                if it.scope == ScopeKind::Local {
                    e.1 += 1;
                }
            }
        }
        let mut worktree_counts: HashMap<String, u32> = HashMap::new();
        for p in &self.col.projects {
            if p.is_worktree {
                if let Some(parent) = &p.parent_key {
                    *worktree_counts.entry(parent.clone()).or_default() += 1;
                }
            }
        }
        // Worktrees are also counted when they were left out of the list.
        if !self.inputs.include_worktrees {
            let cj_keys: Vec<String> = self.cj.as_ref().map(|c| c.projects.iter().map(|p| p.key.clone()).collect()).unwrap_or_default();
            let mut seen = HashSet::new();
            for k in cj_keys.iter().chain(self.folders.iter().flat_map(|f| f.cwds.iter())) {
                let nk = projects::norm_key(k);
                if let Some(parent) = projects::worktree_parent(&nk) {
                    if seen.insert(nk) {
                        *worktree_counts.entry(parent).or_default() += 1;
                        hidden.worktrees += 1;
                    }
                }
            }
        }
        let mut out_projects = Vec::new();
        for p in &self.col.projects {
            let (n, m) = counts.get(&p.id).copied().unwrap_or((0, 0));
            if p.is_worktree {
                hidden.worktrees += 1;
            }
            let listed = if p.exists { n > 0 || m > 0 } else { n > 0 || m > 0 };
            if !listed {
                if p.is_worktree {
                    continue;
                }
                if p.exists {
                    hidden.empty_projects += 1;
                } else {
                    hidden.missing_projects += 1;
                }
                continue;
            }
            if !p.exists && !p.is_worktree {
                hidden.missing_projects += 1;
            }
            out_projects.push(Project {
                id: p.id.clone(),
                name: p.name.clone(),
                path: display_path(&p.path),
                exists: p.exists,
                is_home: p.is_home,
                is_worktree: p.is_worktree,
                parent_id: p.parent_key.as_ref().and_then(|k| self.col.by_key.get(k)).map(|&i| self.col.projects[i].id.clone()),
                worktree_count: worktree_counts.get(&p.key).copied().unwrap_or(0),
                item_count: n,
                local_mcp_count: m,
                last_activity_ms: p.last_activity_ms,
            });
        }
        out_projects.sort_by(|a, b| {
            (a.is_worktree, !a.exists, std::cmp::Reverse(a.last_activity_ms), a.name.to_lowercase()).cmp(&(b.is_worktree, !b.exists, std::cmp::Reverse(b.last_activity_ms), b.name.to_lowercase()))
        });
        let mut items = std::mem::take(&mut self.items);
        items.sort_by(|a, b| {
            (a.kind.as_str(), a.name.to_lowercase(), &a.scope_label, &a.id).cmp(&(b.kind.as_str(), b.name.to_lowercase(), &b.scope_label, &b.id))
        });
        SetupSnapshot {
            version: 0,
            root: RootStatus {
                dir: display_path(&self.inputs.root.dir),
                dir_exists: self.inputs.root.dir.is_dir(),
                claude_json: display_path(&self.inputs.root.claude_json),
                claude_json_state: cj_state.into(),
            },
            items,
            projects: out_projects,
            hidden,
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }

    pub(crate) fn proj_scope(&self, p: &Proj, kind: ScopeKind) -> ScopeCtx {
        ScopeCtx {
            kind,
            project: Some((p.id.clone(), p.name.clone())),
            plugin: None,
            worktree: p.is_worktree,
            real_project: true,
        }
    }
}

impl Discovery {
    pub fn items(&self) -> &[SetupItem] {
        &self.snapshot.items
    }
    pub fn item(&self, id: &str) -> Option<&SetupItem> {
        self.snapshot.items.iter().find(|i| i.id == id)
    }
    /// Folders a watcher should cover.
    pub fn watched_projects(&self) -> &[PathBuf] {
        &self.watched_projects
    }
}

pub fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.split_whitespace().collect::<Vec<_>>().join(" "),
        Value::Null => String::new(),
        Value::Array(a) => a.iter().map(value_text).collect::<Vec<_>>().join(", "),
        other => other.to_string(),
    }
}

pub(crate) fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('\u{2026}');
        t
    }
}
