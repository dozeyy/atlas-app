//! Files on disk -> items: skills, agents, commands, rules, output styles,
//! instructions, memory, workflows, keybindings, themes and "other".

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::frontmatter::MdMeta;
use super::model::*;
use super::projects::{self, Proj};
use super::secrets::redact_inline;
use super::{display_path, mtime_ms, read_head, truncate_chars, value_text, Build, ScopeCtx, SourceRef};
use crate::layout;

const MAX_DEPTH: usize = 9;
const MAX_FILES: usize = 20_000;

#[derive(Debug, Clone)]
pub struct FileEnt {
    /// Relative to the walked base, `/` separators.
    pub rel: String,
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
    pub link: Option<PathBuf>,
}

impl FileEnt {
    pub fn name(&self) -> &str {
        self.rel.rsplit('/').next().unwrap_or(&self.rel)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    User,
    Project,
    Plugin,
}

/// Every non-denied file under `base`. `top_skip`: top-level folders to leave
/// out; `only_top`: if given, the only top-level folders to enter.
pub fn walk(base: &Path, top_skip: &[&str], only_top: Option<&[&str]>) -> Vec<FileEnt> {
    let mut out = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let mut stack: Vec<(PathBuf, String, usize)> = vec![(base.to_path_buf(), String::new(), 0)];
    while let Some((dir, prefix, depth)) = stack.pop() {
        let Ok(rd) = fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            if out.len() >= MAX_FILES {
                return out;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if layout::is_denied_name(&name) {
                continue;
            }
            let rel = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            if layout::is_denied(&rel) {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            let path = e.path();
            let (is_dir, is_file, link) = if ft.is_symlink() {
                match (fs::metadata(&path), fs::canonicalize(&path)) {
                    (Ok(m), Ok(t)) => {
                        if layout::is_denied_name(&t.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()) {
                            continue;
                        }
                        (m.is_dir(), m.is_file(), Some(crate::fsutil::strip_verbatim(&t)))
                    }
                    _ => continue,
                }
            } else {
                (ft.is_dir(), ft.is_file(), None)
            };
            if is_dir {
                if depth == 0 {
                    let low = name.to_ascii_lowercase();
                    if top_skip.contains(&low.as_str()) {
                        continue;
                    }
                    if let Some(only) = only_top
                        && !only.contains(&low.as_str()) {
                            continue;
                        }
                }
                if depth + 1 >= MAX_DEPTH {
                    continue;
                }
                if link.is_some() {
                    match fs::canonicalize(&path) {
                        Ok(c) => {
                            if !visited.insert(c) {
                                continue;
                            }
                        }
                        Err(_) => continue,
                    }
                }
                stack.push((path, rel, depth + 1));
            } else if is_file {
                if only_top.is_some() && depth == 0 {
                    continue;
                }
                let target = link.as_ref().map(|_| path.as_path());
                let md = match target {
                    Some(p) => fs::metadata(p).ok(),
                    None => e.metadata().ok(),
                };
                let Some(md) = md else { continue };
                out.push(FileEnt { rel, path, size: md.len(), mtime: mtime_ms(&md), link });
            }
        }
    }
    out.sort_by(|a, b| a.rel.cmp(&b.rel));
    out
}

fn stem(name: &str) -> &str {
    name.rsplit_once('.').map(|(s, _)| s).unwrap_or(name)
}

fn short_desc(s: &str) -> String {
    truncate_chars(&redact_inline(s), 400)
}

pub(crate) fn fm_rows(meta: &MdMeta) -> Vec<DetailRow> {
    let mut rows = Vec::new();
    if let Some(fm) = &meta.fm {
        for (k, v) in fm {
            if k == "hooks" {
                rows.push(DetailRow { label: k.clone(), value: "see Hooks".into() });
                continue;
            }
            let text = truncate_chars(&redact_inline(&value_text(v)), 300);
            rows.push(DetailRow { label: k.clone(), value: text });
        }
    }
    rows
}

fn text_rows(rows: &mut Vec<DetailRow>, meta: &MdMeta) {
    rows.push(DetailRow { label: "Line endings".into(), value: if meta.crlf { "CRLF" } else { "LF" }.into() });
    if meta.bom {
        rows.push(DetailRow { label: "Byte order mark".into(), value: "Yes".into() });
    }
}

impl Build<'_> {
    /// Common fields every file-backed item gets.
    fn file_item(&self, kind: ItemKind, name: impl Into<String>, ent: &FileEnt) -> SetupItem {
        let mut it = SetupItem::new(kind, ScopeKind::User, name);
        it.path = Some(display_path(&ent.path));
        it.link_target = ent.link.as_ref().map(|l| display_path(l));
        it.size = Some(ent.size);
        it.modified_ms = Some(ent.mtime);
        it
    }

    pub(crate) fn scan_user_scope(&mut self) {
        let root = self.inputs.root.dir.clone();
        if !root.is_dir() {
            return;
        }
        let ents = walk(&root, &["projects", "plugins", "uploads"], None);
        self.classify(ents, &ScopeCtx::user(), Mode::User);
        self.scan_connectors(&root);
    }

    pub(crate) fn scan_managed(&mut self) {
        let Some(dir) = self.inputs.managed_dir.clone() else { return };
        if !dir.is_dir() {
            return;
        }
        let scope = ScopeCtx::simple(ScopeKind::Managed);
        for (name, kind) in [("managed-settings.json", ItemKind::Settings), ("CLAUDE.md", ItemKind::Instructions)] {
            let p = dir.join(name);
            let Ok(md) = fs::metadata(&p) else { continue };
            let ent = FileEnt { rel: name.into(), path: p, size: md.len(), mtime: mtime_ms(&md), link: None };
            if kind == ItemKind::Settings {
                self.load_settings(&ent, &scope, false, 5);
            } else {
                self.instructions_item(&ent, &scope);
            }
        }
        let mcp = dir.join("managed-mcp.json");
        if mcp.is_file() {
            self.add_mcp_file(&mcp, &scope, "mcpServers");
        }
    }

    pub(crate) fn scan_projects(&mut self) {
        let projs: Vec<Proj> = self.col.projects.clone();
        for p in &projs {
            if !p.exists || p.under_root {
                continue;
            }
            let pscope = self.proj_scope(p, ScopeKind::Project);
            self.watched_projects.push(p.path.clone());
            for (name, kind) in [("CLAUDE.md", ItemKind::Instructions), ("CLAUDE.local.md", ItemKind::Instructions), ("AGENTS.md", ItemKind::Instructions)] {
                let f = p.path.join(name);
                if let Ok(md) = fs::metadata(&f)
                    && md.is_file() {
                        let ent = FileEnt { rel: name.into(), path: f, size: md.len(), mtime: mtime_ms(&md), link: None };
                        let _ = kind;
                        self.instructions_item(&ent, &pscope);
                    }
            }
            let mcp = p.path.join(".mcp.json");
            if mcp.is_file() {
                self.add_mcp_file(&mcp, &pscope, "mcpServers");
            }
            let dot = p.path.join(".claude");
            // The home folder's `.claude` is the user's own: never listed twice.
            if projects::norm_key(&dot.to_string_lossy()) == self.root_key || !dot.is_dir() {
                continue;
            }
            let ents = walk(&dot, &[], None);
            self.classify(ents, &pscope, Mode::Project);
        }
    }

    pub(crate) fn scan_memory(&mut self) {
        let folders = std::mem::take(&mut self.folders);
        for f in &folders {
            if f.memory.is_empty() {
                continue;
            }
            let key = projects::folder_project(f, &self.col);
            let (scope, wt) = match key.as_ref().and_then(|k| self.col.by_key.get(k)) {
                Some(&i) => {
                    let p = self.col.projects[i].clone();
                    (self.proj_scope(&p, ScopeKind::Project), p.is_worktree)
                }
                None => (ScopeCtx { kind: ScopeKind::Project, project: None, plugin: None, worktree: false, real_project: false }, false),
            };
            let _ = wt;
            for path in &f.memory {
                let Ok(md) = fs::metadata(path) else { continue };
                let (size, mtime) = (md.len(), mtime_ms(&md));
                let meta = self.md_meta(path, size, mtime);
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let mut it = SetupItem::new(ItemKind::AutoMemory, ScopeKind::Project, name);
                it.path = Some(display_path(path));
                it.size = Some(size);
                it.modified_ms = Some(mtime);
                it.description = short_desc(meta.heading.as_deref().or(meta.first_line.as_deref()).unwrap_or(""));
                let mut rows = Vec::new();
                text_rows(&mut rows, &meta);
                it.detail = rows;
                self.add(it, &scope, path, "", SourceRef::File { path: path.clone() });
            }
        }
        self.folders = folders;
    }

    /// claude.ai connectors: names only, from `mcp-needs-auth-cache.json`.
    fn scan_connectors(&mut self, root: &Path) {
        let p = root.join("mcp-needs-auth-cache.json");
        let Some(text) = read_head(&p, 512 * 1024) else { return };
        let Ok(Value::Object(m)) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return };
        let mtime = fs::metadata(&p).ok().map(|m| mtime_ms(&m));
        let scope = ScopeCtx::simple(ScopeKind::Connector);
        for name in m.keys() {
            let mut it = SetupItem::new(ItemKind::McpServer, ScopeKind::Connector, name.clone());
            it.description = "claude.ai connector (managed in your account)".into();
            it.modified_ms = mtime;
            it.mcp = Some(McpInfo { transport: "connector".into(), summary: "Needs sign-in".into(), ..Default::default() });
            it.enabled = Enabled::of(EnabledKind::None, "Account");
            self.add(it, &scope, &p, &format!("/{name}"), SourceRef::Text(format!("{{\n  \"{name}\": \"claude.ai connector. Atlas lists the name only; its settings live in your claude.ai account.\"\n}}\n")));
        }
    }

    fn instructions_item(&mut self, ent: &FileEnt, scope: &ScopeCtx) {
        let meta = self.md_meta(&ent.path, ent.size, ent.mtime);
        let mut it = self.file_item(ItemKind::Instructions, ent.name().to_string(), ent);
        it.description = short_desc(meta.heading.as_deref().or(meta.first_line.as_deref()).unwrap_or(""));
        let mut rows = Vec::new();
        text_rows(&mut rows, &meta);
        it.detail = rows;
        self.add(it, scope, &ent.path, "", SourceRef::File { path: ent.path.clone() });
    }

    /// The one classifier for a `.claude`-shaped folder (user, project or plugin).
    pub(crate) fn classify(&mut self, ents: Vec<FileEnt>, scope: &ScopeCtx, mode: Mode) {
        // Skill folders first: which dirs hold a SKILL.md, and their attachments.
        let mut skill_dirs: HashMap<String, usize> = HashMap::new(); // dir rel -> index of SKILL.md ent
        let mut synced_manifests: HashMap<String, Value> = HashMap::new();
        for (i, e) in ents.iter().enumerate() {
            let segs: Vec<&str> = e.rel.split('/').collect();
            if segs[0] != "skills" {
                continue;
            }
            if segs.len() == 3 && segs[2] == "SKILL.md" && segs[1] != "synced" {
                skill_dirs.insert(format!("skills/{}", segs[1]), i);
            } else if segs.len() == 5 && segs[1] == "synced" && segs[4] == "SKILL.md" {
                skill_dirs.insert(format!("skills/synced/{}/{}", segs[2], segs[3]), i);
            } else if segs.len() == 4 && segs[1] == "synced" && segs[3] == "manifest.json"
                && let Some(t) = read_head(&e.path, 2 * 1024 * 1024)
                    && let Ok(v) = serde_json::from_str::<Value>(t.trim_start_matches('\u{feff}')) {
                        synced_manifests.insert(format!("skills/synced/{}", segs[2]), v);
                    }
        }
        let mut attachments: HashMap<String, Vec<String>> = HashMap::new();
        let mut consumed: HashSet<usize> = HashSet::new();
        for (i, e) in ents.iter().enumerate() {
            let segs: Vec<&str> = e.rel.split('/').collect();
            if segs[0] != "skills" || segs.len() < 3 {
                continue;
            }
            let dir = if segs[1] == "synced" {
                if segs.len() < 5 {
                    continue;
                }
                format!("skills/synced/{}/{}", segs[2], segs[3])
            } else {
                format!("skills/{}", segs[1])
            };
            if skill_dirs.contains_key(&dir) {
                consumed.insert(i);
                if skill_dirs[&dir] != i {
                    let rest = e.rel[dir.len() + 1..].to_string();
                    let v = attachments.entry(dir).or_default();
                    if v.len() < 60 {
                        v.push(rest);
                    }
                }
            } else if segs[1] == "synced" && segs.len() == 4 && segs[3] == "manifest.json" {
                consumed.insert(i);
            }
        }

        for (i, e) in ents.iter().enumerate() {
            let segs: Vec<&str> = e.rel.split('/').collect();
            let fname = e.name();
            let low0 = segs[0].to_ascii_lowercase();
            // Backup copies are always "other", whatever they sit beside.
            if layout::is_backup_name(fname) && mode != Mode::Plugin {
                self.other_item(e, scope, true);
                continue;
            }
            if consumed.contains(&i) {
                if let Some((dir, _)) = skill_dirs.iter().find(|(_, idx)| **idx == i) {
                    let dir = dir.clone();
                    let att = attachments.remove(&dir).unwrap_or_default();
                    let manifest = if dir.starts_with("skills/synced/") {
                        let bucket = dir.rsplit_once('/').map(|x| x.0.to_string()).unwrap_or_default();
                        synced_manifests.get(&bucket).cloned()
                    } else {
                        None
                    };
                    let dname = dir.rsplit('/').next().unwrap_or("").to_string();
                    self.skill_item(e, scope, &dname, att, manifest.as_ref(), dir.starts_with("skills/synced/"), mode);
                }
                continue;
            }
            if mode == Mode::Plugin {
                match (low0.as_str(), segs.len()) {
                    ("agents", n) if n >= 2 && fname.ends_with(".md") => self.agent_item(e, scope),
                    ("commands", n) if n >= 2 && fname.ends_with(".md") => self.command_item(e, scope),
                    ("output-styles", n) if n >= 2 && fname.ends_with(".md") => self.style_item(e, scope),
                    _ => {}
                }
                continue;
            }
            match (low0.as_str(), segs.len()) {
                ("settings.json", 1) => self.load_settings(e, scope, false, if mode == Mode::User { 1 } else { 3 }),
                ("settings.local.json", 1) => self.load_settings(e, scope, true, if mode == Mode::User { 2 } else { 4 }),
                ("claude.md", 1) => self.instructions_item(e, scope),
                ("agents", n) if n >= 2 && fname.ends_with(".md") => self.agent_item(e, scope),
                ("commands", n) if n >= 2 && fname.ends_with(".md") => self.command_item(e, scope),
                ("rules", n) if n >= 2 && fname.ends_with(".md") => self.rule_item(e, scope),
                ("output-styles", n) if n >= 2 && fname.ends_with(".md") => self.style_item(e, scope),
                ("workflows", 2) if fname.ends_with(".js") => self.workflow_item(e, scope),
                ("agent-memory" | "agent-memory-local", n) if n >= 3 => self.agent_memory_item(e, scope),
                ("keybindings.json", 1) if mode == Mode::User => self.keybindings_item(e, scope),
                ("themes", 2) if mode == Mode::User && fname.ends_with(".json") => self.theme_item(e, scope),
                ("hooks", n) if n >= 2 => self.script_candidate(e, scope),
                _ => self.other_item(e, scope, false),
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn skill_item(&mut self, e: &FileEnt, scope: &ScopeCtx, dir_name: &str, att: Vec<String>, manifest: Option<&Value>, synced: bool, _mode: Mode) {
        let meta = self.md_meta(&e.path, e.size, e.mtime);
        let base = meta.name.clone().unwrap_or_else(|| dir_name.to_string());
        let mut scope_eff = scope.clone();
        let mut it = self.file_item(ItemKind::Skill, base.clone(), e);
        let mut desc = meta.description.clone();
        if synced {
            scope_eff.kind = ScopeKind::Synced;
            let entry = manifest
                .and_then(|m| m.get("skills"))
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|s| s.get("name").and_then(Value::as_str) == Some(base.as_str())));
            let source = entry.and_then(|s| s.get("source")).and_then(Value::as_str).unwrap_or("anthropic");
            let prefix = if source == "anthropic" { "anthropic-skills".to_string() } else { source.to_string() };
            it.name = format!("{prefix}:{base}");
            if desc.is_empty() {
                desc = entry.and_then(|s| s.get("description")).and_then(Value::as_str).unwrap_or("").to_string();
            }
            it.detail.push(DetailRow { label: "Source".into(), value: source.to_string() });
        } else if scope.kind == ScopeKind::Plugin {
            it.name = format!("{}:{}", scope.plugin.clone().unwrap_or_default(), base);
        } else {
            it.shadow_key = Some(base.clone());
        }
        if meta.name.is_none() && meta.fm_error.is_none() {
            it.detail.push(DetailRow { label: "Name".into(), value: format!("{dir_name} (from the folder name)") });
        }
        self.finish_md_item(&mut it, &meta, desc);
        it.attachments = att;
        let ptr = "";
        let idx = self.add(it, &scope_eff, &e.path, ptr, SourceRef::File { path: e.path.clone() });
        if let (Some(i), Some(fm)) = (idx, meta.fm.as_ref())
            && let Some(h) = fm.get("hooks") {
                let sc = scope_eff.clone();
                self.add_hooks(h, &e.path, &sc, "/frontmatter/hooks", false);
                let _ = i;
            }
    }

    fn finish_md_item(&self, it: &mut SetupItem, meta: &MdMeta, desc: String) {
        if let Some(err) = &meta.fm_error {
            it.description = "Frontmatter can't be read".into();
            it.warnings.push("Frontmatter can't be read".into());
            it.warnings.push(err.clone());
        } else {
            it.description = short_desc(&desc);
        }
        let mut rows = fm_rows(meta);
        rows.append(&mut it.detail);
        text_rows(&mut rows, meta);
        it.detail = rows;
    }

    fn agent_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let meta = self.md_meta(&e.path, e.size, e.mtime);
        let fallback = stem(e.name()).to_string();
        let name = meta.name.clone().unwrap_or_else(|| fallback.clone());
        let mut it = self.file_item(ItemKind::Agent, name.clone(), e);
        if meta.name.is_none() {
            it.warnings.push("No name in the frontmatter; using the file name".into());
        }
        it.shadow_key = Some(name);
        let desc = meta.description.clone();
        self.finish_md_item(&mut it, &meta, desc);
        let idx = self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
        if let (Some(_), Some(fm)) = (idx, meta.fm.as_ref())
            && let Some(h) = fm.get("hooks") {
                self.add_hooks(h, &e.path, scope, "/frontmatter/hooks", false);
            }
    }

    fn command_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let meta = self.md_meta(&e.path, e.size, e.mtime);
        let sub = e.rel.split_once('/').map(|x| x.1).unwrap_or(&e.rel);
        let sub = sub.strip_suffix(".md").unwrap_or(sub);
        let name = sub.replace('/', ":");
        let mut it = self.file_item(ItemKind::Command, name.clone(), e);
        if scope.kind != ScopeKind::Plugin {
            it.shadow_key = Some(name.clone());
        } else {
            it.name = format!("{}:{}", scope.plugin.clone().unwrap_or_default(), name);
        }
        let mut desc = meta.description.clone();
        if desc.is_empty() {
            desc = meta.first_line.clone().unwrap_or_default();
        }
        self.finish_md_item(&mut it, &meta, desc);
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }

    fn rule_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let meta = self.md_meta(&e.path, e.size, e.mtime);
        let sub = e.rel.split_once('/').map(|x| x.1).unwrap_or(&e.rel);
        let name = sub.strip_suffix(".md").unwrap_or(sub).to_string();
        let mut it = self.file_item(ItemKind::Rule, name, e);
        let desc = meta.first_line.clone().unwrap_or_default();
        self.finish_md_item(&mut it, &meta, desc);
        it.chips = meta.paths.clone();
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }

    fn style_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let meta = self.md_meta(&e.path, e.size, e.mtime);
        let base = meta.name.clone().unwrap_or_else(|| stem(e.name()).to_string());
        let mut it = self.file_item(ItemKind::OutputStyle, base.clone(), e);
        if scope.kind == ScopeKind::Plugin {
            it.name = format!("{}:{}", scope.plugin.clone().unwrap_or_default(), base);
        } else {
            it.shadow_key = Some(base);
        }
        let desc = meta.description.clone();
        self.finish_md_item(&mut it, &meta, desc);
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }

    fn workflow_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let head = read_head(&e.path, 4096).unwrap_or_default();
        let first = head.lines().map(str::trim).find(|l| l.starts_with("//")).map(|l| l.trim_start_matches('/').trim().to_string()).unwrap_or_default();
        let mut it = self.file_item(ItemKind::Workflow, stem(e.name()).to_string(), e);
        it.description = short_desc(&first);
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }

    fn agent_memory_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let sub = e.rel.split_once('/').map(|x| x.1).unwrap_or(&e.rel);
        let head = read_head(&e.path, 2048).unwrap_or_default();
        let first = head.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").trim_start_matches('#').trim().to_string();
        let mut it = self.file_item(ItemKind::AgentMemory, sub.to_string(), e);
        it.description = short_desc(&first);
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }

    fn keybindings_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let mut it = self.file_item(ItemKind::Keybindings, "Keybindings", e);
        let text = read_head(&e.path, 1024 * 1024).unwrap_or_default();
        let n = match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
            Ok(Value::Array(a)) => Some(a.len()),
            Ok(Value::Object(m)) => m.get("bindings").and_then(Value::as_array).map(|a| a.len()).or(Some(m.len())),
            _ => None,
        };
        it.description = match n {
            Some(n) => format!("{n} bindings"),
            None => format!("{} bytes", e.size),
        };
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }

    fn theme_item(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let text = read_head(&e.path, 64 * 1024).unwrap_or_default();
        let name = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}'))
            .ok()
            .and_then(|v| v.get("name").and_then(Value::as_str).map(str::to_string))
            .unwrap_or_else(|| stem(e.name()).to_string());
        let mut it = self.file_item(ItemKind::Theme, name, e);
        it.description = "Color theme".into();
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }

    pub(crate) fn other_item(&mut self, e: &FileEnt, scope: &ScopeCtx, backup: bool) {
        // Shown as connectors (names only) instead.
        if e.rel == "mcp-needs-auth-cache.json" {
            return;
        }
        let mut it = self.file_item(ItemKind::Other, e.rel.clone(), e);
        it.backup = backup;
        it.description = if backup { "Backup copy".into() } else { "Not managed by Atlas".into() };
        if backup {
            it.chips.push("backup copy".into());
        }
        self.add(it, scope, &e.path, "", SourceRef::File { path: e.path.clone() });
    }
}
