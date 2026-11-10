//! The operations Claude can perform on the setup through the Atlas MCP server (and, in
//! propose mode, the in-app assistant): list, read, create, edit, rename, delete, turn hooks
//! and MCP servers on and off, and list and restore backups.
//!
//! Nothing here is a second write path. Every change goes through `setup_write` (backup first,
//! atomic write, read back), under the cross-process write lock, and the backup it leaves is
//! tagged with who made the change so History can say "edited by Claude". Reads use the same
//! scan the Setup page uses, so the registry of ids is the allow-list: only a file that scan
//! found (inside the Claude folder or a project Claude has worked in) can be named, secrets are
//! masked, and the credential files are never in the registry at all.
//!
//! A write is a `Write` value. `preview` says what it would do without touching anything (what
//! propose mode records in the queue); `apply` does it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::connect::CliChoice;
use crate::layout;
use crate::setup::projects::norm_key;
use crate::setup::secrets::MASK;
use crate::setup::{Cache, Discovery, DiscoveryInputs, ItemKind, ScopeKind, SetupItem, SourceRef, discover};
use crate::setup_write::{self as sw, CreateCtx, WriteError};

/// Longest text a tool returns or records (a bigger file is cut, and says so).
pub const TEXT_CAP: usize = 100_000;
const DEFAULT_LIMIT: usize = 40;
const MAX_LIMIT: usize = 200;
/// Items with this id prefix are hooks turned off from a tool, kept in a backup.
pub const PARKED_PREFIX: &str = "parked:";

fn wm(e: WriteError) -> String {
    match e {
        WriteError::Conflict => "That changed on disk since you read it. Read it again and retry.".into(),
        other => other.message(),
    }
}

fn scope_word(s: ScopeKind) -> &'static str {
    match s {
        ScopeKind::User => "user",
        ScopeKind::Project => "project",
        ScopeKind::Local => "local",
        ScopeKind::Plugin => "plugin",
        ScopeKind::Synced => "synced",
        ScopeKind::Managed => "managed",
        ScopeKind::Connector => "connector",
    }
}

fn cut(s: &str, n: usize) -> (String, bool) {
    if s.chars().count() <= n {
        return (s.to_string(), false);
    }
    (s.chars().take(n).collect(), true)
}

/// The only kinds a direct (code-denied) write may touch: plain markdown that Claude reads as
/// words. Everything else (hooks, scripts, MCP servers, settings, permissions, the status line,
/// plugins, workflows, and any file Atlas has no name for) can end up running a command, so it
/// is an allow-list: a kind added later is refused until someone decides it is safe.
fn is_prose_kind(k: ItemKind) -> bool {
    matches!(k, ItemKind::Instructions | ItemKind::Rule | ItemKind::OutputStyle | ItemKind::Skill | ItemKind::Agent | ItemKind::Command | ItemKind::AutoMemory | ItemKind::AgentMemory)
}

/// The same allow-list for a backup's `kind` word.
fn is_prose_kind_word(k: &str) -> bool {
    matches!(k, "instructions" | "rule" | "outputStyle" | "skill" | "agent" | "command" | "autoMemory" | "agentMemory")
}

/// Kinds whose text can carry behaviour of its own: a skill, agent or command runs `!` shell
/// lines and can grant tools or attach hooks through its frontmatter.
fn can_carry_code(k: ItemKind) -> bool {
    matches!(k, ItemKind::Skill | ItemKind::Agent | ItemKind::Command)
}

/// Frontmatter keys that make a skill, agent or command run something or widen what it may run.
const CODE_KEYS: [&str; 7] = ["hooks", "allowed-tools", "allowed_tools", "allowedtools", "permissionmode", "mcpservers", "shell"];

/// Why the YAML header of a skill, agent or command could run something, if it could. It is
/// parsed the way the scanner parses it (`serde_yaml_ng`), merge keys applied, so a quoted key,
/// flow style (`{hooks: ...}`), an explicit key (`? hooks`) or a merge (`<<: *a`) cannot hide a
/// key from the check. A header that does not parse, or has a key that is not plain text, is
/// refused: it is not something Atlas can vouch for.
fn code_in_header(yaml: &str) -> Option<&'static str> {
    use serde_yaml_ng::Value as Y;
    const WHY: &str = "a hook, a tool permission or a server in its header";
    if yaml.trim().is_empty() {
        return None;
    }
    let Ok(mut v) = serde_yaml_ng::from_str::<Y>(yaml) else { return Some("a header that can't be read") };
    if v.is_null() {
        return None;
    }
    if v.apply_merge().is_err() {
        return Some("a header that can't be read");
    }
    let Y::Mapping(m) = &v else { return Some("a header that is not a list of keys") };
    for k in m.keys() {
        let Y::String(k) = k else { return Some("a header with a key that is not plain text") };
        let k = k.trim().to_lowercase();
        if k == "<<" {
            return Some("a header that merges other keys in");
        }
        if CODE_KEYS.contains(&k.as_str()) {
            return Some(WHY);
        }
    }
    None
}

/// Why `text` (the body of a skill, agent or command) could run a command, if it could.
fn code_in_text(text: &str) -> Option<&'static str> {
    let text = text.trim_start_matches('\u{feff}');
    if text.lines().next().is_some_and(|l| l.trim_end() == "---") {
        // Claude Code ends the header at the next `---`; the scanner also accepts `...`. Check
        // the header both ways, and refuse one that never closes.
        let mut yaml = String::new();
        let mut closed = false;
        for l in text.lines().skip(1) {
            if l.trim_end() == "---" {
                closed = true;
                break;
            }
            yaml.push_str(l);
            yaml.push('\n');
        }
        if !closed {
            return Some("a header that is never closed");
        }
        if let Some(why) = code_in_header(&yaml) {
            return Some(why);
        }
        let (fm, _, fm_closed) = crate::setup::frontmatter::split(text);
        if let Some(fm) = fm
            && (!fm_closed || fm != yaml)
            && let Some(why) = code_in_header(fm)
        {
            return Some(why);
        }
    }
    // `![alt](url)` is a markdown image, not a shell line.
    let shell_line = |l: &str| {
        let t = l.trim_start();
        (t.starts_with('!') && !t.starts_with("![")) || t.starts_with("```!")
    };
    if text.contains("!`") || text.lines().any(shell_line) {
        return Some("a shell line (starting with !)");
    }
    None
}

fn kind_from_word(k: &str) -> ItemKind {
    match k {
        "instructions" => ItemKind::Instructions,
        "skill" => ItemKind::Skill,
        "agent" => ItemKind::Agent,
        "command" => ItemKind::Command,
        "rule" => ItemKind::Rule,
        "outputStyle" => ItemKind::OutputStyle,
        _ => ItemKind::Other,
    }
}

fn is_md(path: &str) -> bool {
    Path::new(path).extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

/// Folders whose files are run, not read.
fn is_code_folder(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "hooks" | "scripts" | "local")
}

/// A change this size is refused (and a card never shows a cut-off version of it): what is
/// approved must be exactly what was shown.
fn too_long(text: &str) -> Result<(), String> {
    if text.chars().count() > TEXT_CAP {
        return Err(format!("That text is longer than {TEXT_CAP} characters, so it can't be shown in full for approval. Make the change smaller."));
    }
    Ok(())
}

/// The sentence a card carries when the change would run commands.
fn runs_commands(note: Option<String>, why: Option<String>) -> Option<String> {
    match why {
        Some(w) => Some(match note {
            Some(n) => format!("This change runs commands: {w}. {n}"),
            None => format!("This change runs commands: {w}."),
        }),
        None => note,
    }
}

fn no_mask(text: &str) -> Result<(), String> {
    if text.contains(MASK) {
        return Err("That text contains the dots Atlas shows in place of a hidden key or token. Writing them would replace the real value, so nothing was changed.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// What the tools return
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListFilter {
    pub kind: Option<String>,
    pub scope: Option<String>,
    pub project: Option<String>,
    pub query: Option<String>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemBrief {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub scope: String,
    pub scope_label: String,
    pub description: String,
    pub path: Option<String>,
    pub enabled: String,
    pub editable: bool,
    pub deletable: bool,
    pub locked: Option<String>,
    pub has_secrets: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOut {
    pub matches: usize,
    pub shown: usize,
    /// How many of the matches are of each kind.
    pub kinds: BTreeMap<String, usize>,
    pub items: Vec<ItemBrief>,
    /// Projects Claude has worked in (names usable as the `project` filter).
    pub projects: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOut {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub scope_label: String,
    pub path: Option<String>,
    pub language: String,
    /// The text, with every key, token and password replaced by dots.
    pub text: String,
    pub truncated: bool,
    /// Pass back to `update_item` as `stamp` to be sure nothing changed in between.
    pub stamp: Option<String>,
    pub editable: bool,
    pub deletable: bool,
    pub locked: Option<String>,
    /// Some values in the text are hidden; the item can be read but not changed from here.
    pub has_hidden_values: bool,
    /// For a skill: the files in its folder (pass one as `file`).
    pub files: Vec<String>,
}

/// What a write would do, or did.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub tool: String,
    /// One plain line.
    pub summary: String,
    pub kind: String,
    pub name: String,
    /// The file or folder it touches.
    pub target_path: String,
    pub before: Option<String>,
    pub after: Option<String>,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Applied {
    pub summary: String,
    /// The backup Atlas made first (restore_backup undoes the change from it).
    pub backup_id: Option<String>,
    pub path: Option<String>,
    pub note: Option<String>,
}

/// One change a tool asks for. Serialised into the propose-mode queue and applied later.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum Write {
    CreateItem {
        kind: String,
        name: String,
        #[serde(default)]
        event: Option<String>,
        #[serde(default)]
        text: Option<String>,
    },
    UpdateItem {
        id: String,
        text: String,
        #[serde(default)]
        file: Option<String>,
        #[serde(default)]
        stamp: Option<String>,
    },
    RenameItem {
        id: String,
        new_name: String,
    },
    DeleteItem {
        id: String,
    },
    ToggleHook {
        id: String,
        enabled: bool,
    },
    ToggleMcpServer {
        id: String,
        enabled: bool,
        #[serde(default)]
        project: Option<String>,
    },
    RestoreBackup {
        backup_id: String,
    },
}

impl Write {
    pub fn tool(&self) -> &'static str {
        match self {
            Write::CreateItem { .. } => "create_item",
            Write::UpdateItem { .. } => "update_item",
            Write::RenameItem { .. } => "rename_item",
            Write::DeleteItem { .. } => "delete_item",
            Write::ToggleHook { .. } => "toggle_hook",
            Write::ToggleMcpServer { .. } => "toggle_mcp_server",
            Write::RestoreBackup { .. } => "restore_backup",
        }
    }
}

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

pub struct Ops {
    inputs: DiscoveryInputs,
    data_dir: PathBuf,
    backups: PathBuf,
    /// Who the changes are tagged as: `mcp` or `assistant`.
    source: String,
    cache: Mutex<Cache>,
    /// May a change add or edit something that runs commands (hooks, MCP servers, settings)?
    allow_code: bool,
    /// Claude Code's command, used to register an MCP server (`claude mcp add-json`).
    cli: CliChoice,
    /// Send what a delete removes to the OS trash as well as Atlas's backups.
    to_trash: bool,
}

impl Ops {
    /// `data_dir` is Atlas's data folder (the one that holds `setup-backups`). Deletes go to the
    /// OS trash too (set `ATLAS_NO_TRASH=1`, or call `without_trash`, to keep tests out of the
    /// real Recycle Bin). MCP servers are added through Claude Code's own command when it is found (`with_cli`
    /// picks another or none); the guarded file edit is the fallback.
    pub fn new(inputs: DiscoveryInputs, data_dir: &Path, source: &str) -> Ops {
        let to_trash = std::env::var_os("ATLAS_NO_TRASH").is_none_or(|v| v.is_empty() || v == "0");
        Ops { inputs, data_dir: data_dir.to_path_buf(), backups: data_dir.join("setup-backups"), source: source.to_string(), cache: Mutex::new(Cache::default()), allow_code: true, cli: CliChoice::Auto, to_trash }
    }

    /// Use Claude Code's own command to add MCP servers (it owns `.claude.json`); the guarded
    /// file edit stays the fallback.
    pub fn with_cli(mut self, cli: CliChoice) -> Ops {
        self.cli = cli;
        self
    }

    /// Will a new MCP server be added through Claude Code's own command (it is found)?
    pub fn registers_servers_with_claude_command(&self) -> bool {
        self.cli.found()
    }

    /// Do not send deleted files to the OS trash (Atlas's backups still keep them).
    pub fn without_trash(mut self) -> Ops {
        self.to_trash = false;
        self
    }

    /// Refuse (in `apply`) to add or edit anything that runs commands on the computer: hooks,
    /// MCP servers, settings, permissions, the status line. The MCP server uses this when it
    /// writes straight away, so a prompt-injected chat can't plant a command; such a change
    /// has to go through propose mode, where the user approves it in the app.
    pub fn deny_code_changes(mut self) -> Ops {
        self.allow_code = false;
        self
    }

    fn guard_code(&self, what: &str) -> Result<(), String> {
        if self.allow_code {
            return Ok(());
        }
        Err(format!("Changing {what} could make a command run on this computer, so Atlas will not do it without the user's approval. Ask the user to make this change in Atlas, or use Atlas in propose mode so they can approve it."))
    }

    /// Why a text edit of this kind of file, at this path, with this new text, could run
    /// something: only plain markdown is safe, and for a skill, agent or command only when its
    /// text cannot run anything. `None` means it is words only.
    fn prose_reason(&self, kind: ItemKind, path: &str, text: &str) -> Option<String> {
        if !is_prose_kind(kind) {
            return Some("hooks, MCP servers, settings or files of this kind".into());
        }
        if !is_md(path) {
            return Some("a file that is not plain markdown (it could be a script)".into());
        }
        if can_carry_code(kind)
            && let Some(why) = code_in_text(text)
        {
            return Some(format!("text with {why}"));
        }
        None
    }

    fn guard_prose(&self, kind: ItemKind, path: &str, text: &str) -> Result<(), String> {
        if self.allow_code {
            return Ok(());
        }
        match self.prose_reason(kind, path, text) {
            Some(why) => self.guard_code(&why),
            None => Ok(()),
        }
    }

    /// Where a restore may write: the Claude folder, `.claude.json` and the projects Claude knows.
    fn confine(&self, d: &Discovery) -> sw::Confine {
        sw::Confine::from_discovery(&self.inputs.root.dir, &self.inputs.root.claude_json, d)
    }

    /// Does this path sit in a folder that holds code (below the Claude folder, or below a
    /// project's `.claude`)? Paths are compared in their canonical form, so a short (8.3) name,
    /// a link or a root that is not called `.claude` cannot slip past.
    fn in_code_folder(&self, path: &Path, d: &Discovery) -> bool {
        use crate::fsutil::relative_inside;
        let below = |r: &Path| r.parent().into_iter().flat_map(|p| p.components()).any(|c| is_code_folder(&c.as_os_str().to_string_lossy()));
        let known = relative_inside(path, &self.inputs.root.dir)
            .or_else(|| d.snapshot.projects.iter().find_map(|p| relative_inside(path, &Path::new(&p.path).join(".claude"))));
        if let Some(r) = known {
            return below(&r);
        }
        // Not inside anything Atlas knows: judge by the last `.claude` in the path, else its folder.
        let comps: Vec<_> = path.components().collect();
        match comps.iter().rposition(|c| c.as_os_str().eq_ignore_ascii_case(".claude")) {
            Some(at) => below(&comps[at + 1..].iter().collect::<PathBuf>()),
            None => path.parent().and_then(|p| p.file_name()).is_some_and(|n| is_code_folder(&n.to_string_lossy())),
        }
    }

    /// Why putting this backup back could put code on the computer. Decided from the files that
    /// would be written, never from the manifest's own `kind` word: every file must be
    /// markdown, outside the folders that hold hooks and scripts, and its text must not carry a
    /// header key or `!` line that runs something. `None` means it is words only.
    fn backup_reason(&self, info: &sw::BackupInfo, d: &Discovery) -> Option<String> {
        let path = info.path.as_deref().unwrap_or("");
        let p = Path::new(path);
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_ascii_lowercase();
        if !is_prose_kind_word(&info.kind) || (name.starts_with("settings") && name.ends_with(".json")) || name == ".claude.json" || name == ".mcp.json" {
            return Some("hooks, MCP servers or settings".into());
        }
        if p.extension().is_some_and(|e| !e.eq_ignore_ascii_case("md")) {
            return Some("a file that is not plain markdown (it could be a script)".into());
        }
        if self.in_code_folder(p, d) {
            return Some("a hooks, scripts or local folder".into());
        }
        for (rel, bytes) in sw::backup_files(&self.backups, &info.backup_id) {
            if !is_md(&rel) {
                return Some("a file that is not plain markdown (it could be a script)".into());
            }
            if Path::new(&rel).parent().into_iter().flat_map(|p| p.components()).any(|c| is_code_folder(&c.as_os_str().to_string_lossy())) {
                return Some("a hooks, scripts or local folder".into());
            }
            if let Some(why) = code_in_text(&String::from_utf8_lossy(&bytes)) {
                return Some(format!("text with {why}"));
            }
        }
        None
    }

    fn guard_backup(&self, info: &sw::BackupInfo, d: &Discovery) -> Result<(), String> {
        if self.allow_code {
            return Ok(());
        }
        match self.backup_reason(info, d) {
            Some(why) => self.guard_code(&why),
            None => Ok(()),
        }
    }

    /// What a restore would put where: the saved files (secrets masked) and what is there now.
    fn restore_view(&self, info: &sw::BackupInfo, d: &Discovery) -> (Option<String>, Option<String>) {
        let show = |name: &str, bytes: &[u8]| {
            let t = String::from_utf8_lossy(bytes).into_owned();
            if name.to_ascii_lowercase().ends_with(".json") { crate::setup::secrets::mask_json(&t).text } else { crate::setup::secrets::mask_plain(&t).text }
        };
        let files = sw::backup_files(&self.backups, &info.backup_id);
        let after = match files.len() {
            0 => None,
            1 => Some(show(&files[0].0, &files[0].1)),
            _ => Some(files.iter().map(|(n, b)| format!("=== {n} ===\n{}", show(n, b))).collect::<Vec<_>>().join("\n")),
        };
        let confine = self.confine(d);
        let now = info.path.as_deref().map(Path::new).filter(|p| confine.allows(p)).filter(|p| p.is_file() && p.metadata().is_ok_and(|m| m.len() <= 2 * 1024 * 1024)).and_then(|p| std::fs::read(p).ok());
        let before = now.map(|b| show(info.path.as_deref().unwrap_or(""), &b));
        (before, after)
    }

    pub fn inputs(&self) -> &DiscoveryInputs {
        &self.inputs
    }

    pub fn backups_dir(&self) -> &Path {
        &self.backups
    }

    /// Atlas's data folder (where the Library keeps its catalog).
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// A fresh scan of the setup (cheap: unchanged markdown heads come from the cache).
    pub fn discovery(&self) -> Discovery {
        let mut c = self.cache.lock().unwrap_or_else(|p| p.into_inner());
        discover(&self.inputs, &mut c)
    }

    fn ctx(&self) -> CreateCtx<'_> {
        CreateCtx { root: &self.inputs.root.dir, claude_json: &self.inputs.root.claude_json }
    }

    fn tag(&self, backup_id: &str, summary: &str) {
        sw::tag_backup(&self.backups, backup_id, &self.source, summary);
    }

    // ------------------------------------------------------------ reads

    pub fn list_items(&self, f: &ListFilter) -> ListOut {
        let d = self.discovery();
        let want_kind = f.kind.as_deref().map(|k| k.trim().to_lowercase().replace(['_', '-', ' '], ""));
        let want_scope = f.scope.as_deref().map(|s| s.trim().to_lowercase());
        let q = f.query.as_deref().map(|q| q.trim().to_lowercase()).filter(|q| !q.is_empty());
        let proj = f.project.as_deref().and_then(|p| resolve_project(&d, p));
        let proj_missing = f.project.is_some() && proj.is_none();
        let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
        let mut hits: Vec<ItemBrief> = Vec::new();
        let mut consider = |b: ItemBrief, project_id: Option<&String>| {
            if let Some(k) = &want_kind
                && b.kind.to_lowercase() != *k
            {
                return;
            }
            if let Some(s) = &want_scope
                && b.scope != *s
            {
                return;
            }
            if let Some(p) = &proj
                && project_id != Some(p)
            {
                return;
            }
            if let Some(q) = &q
                && !(b.name.to_lowercase().contains(q) || b.description.to_lowercase().contains(q))
            {
                return;
            }
            *kinds.entry(b.kind.clone()).or_default() += 1;
            hits.push(b);
        };
        if !proj_missing {
            for it in d.items() {
                if it.backup || it.worktree {
                    continue;
                }
                consider(brief(it), it.project_id.as_ref());
            }
            if want_scope.as_deref().is_none_or(|s| s == "user") && proj.is_none() {
                for p in sw::list_parked(&self.backups) {
                    consider(parked_brief(&p), None);
                }
            }
        }
        let matches = hits.len();
        let limit = f.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        hits.truncate(limit);
        ListOut { matches, shown: hits.len(), kinds, items: hits, projects: d.snapshot.projects.iter().filter(|p| !p.is_worktree && p.exists).map(|p| p.name.clone()).collect() }
    }

    pub fn read_item(&self, id: &str, file: Option<&str>) -> Result<ReadOut, String> {
        if id.starts_with(PARKED_PREFIX) {
            return Err("That hook is turned off. Use toggle_hook with enabled true to turn it back on, then read it.".into());
        }
        let d = self.discovery();
        let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
        let files: Vec<String> = d.skill_files(id).map(|v| v.into_iter().map(|f| f.rel).collect()).unwrap_or_default();
        if let Some(rel) = file {
            let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
            if layout::is_denied_name(name) {
                return Err("That file is never shown.".into());
            }
            let raw = d.read_raw_file(id, Some(rel), false).map_err(wm)?;
            if raw.needs_reveal {
                return Err("That file holds keys or tokens, so Atlas does not show it.".into());
            }
            let (text, truncated) = cut(&raw.text, TEXT_CAP);
            return Ok(ReadOut { id: id.into(), kind: item.kind.as_str().into(), name: item.name.clone(), scope_label: item.scope_label.clone(), path: Some(raw.path), language: raw.language, text, truncated, stamp: Some(raw.stamp), editable: item.editable, deletable: item.deletable, locked: item.locked.clone(), has_hidden_values: false, files });
        }
        let v = d.read_source(id)?;
        let hidden = !v.masked_ranges.is_empty();
        let stamp = (item.editable && !item.has_secrets && !hidden).then(|| d.read_raw_file(id, None, false).ok().filter(|r| !r.needs_reveal).map(|r| r.stamp)).flatten();
        let (text, cut_here) = cut(&v.text, TEXT_CAP);
        Ok(ReadOut {
            id: id.into(),
            kind: item.kind.as_str().into(),
            name: item.name.clone(),
            scope_label: item.scope_label.clone(),
            path: item.path.clone(),
            language: v.language,
            text,
            truncated: v.truncated || cut_here,
            stamp,
            editable: item.editable,
            deletable: item.deletable,
            locked: item.locked.clone(),
            has_hidden_values: hidden || item.has_secrets,
            files,
        })
    }

    pub fn list_backups(&self, limit: usize) -> Vec<sw::BackupInfo> {
        sw::list_backups_detailed(&self.backups, limit.clamp(1, 200))
    }

    /// For a proposal: pin an edit to the file as it is now, so approving it later refuses if
    /// the file changed in between (instead of overwriting the newer text).
    pub fn pin_stamp(&self, w: Write) -> Write {
        match w {
            Write::UpdateItem { id, text, file, stamp: None } => {
                let stamp = self.discovery().read_raw_file(&id, file.as_deref(), false).ok().map(|r| r.stamp);
                Write::UpdateItem { id, text, file, stamp }
            }
            other => other,
        }
    }

    // ------------------------------------------------------------ previews (write nothing)

    pub fn preview(&self, w: &Write) -> Result<Preview, String> {
        let d = self.discovery();
        let base = |summary: String, kind: &str, name: &str, target: String, before: Option<String>, after: Option<String>, note: Option<String>| Preview {
            tool: w.tool().into(),
            summary,
            kind: kind.into(),
            name: name.into(),
            target_path: target,
            before: before.map(|s| cut(&s, TEXT_CAP).0),
            after: after.map(|s| cut(&s, TEXT_CAP).0),
            note,
        };
        match w {
            Write::CreateItem { kind, name, event, text } => {
                let draft = sw::create_draft(kind, name, event.as_deref(), &self.ctx()).map_err(wm)?;
                let text = text.clone().unwrap_or_else(|| draft.text.clone());
                no_mask(&text)?;
                too_long(&text)?;
                if let Some(p) = sw::validate_draft(kind, name, event.as_deref(), &text, &self.ctx()).map_err(wm)?.first() {
                    return Err(p.message.clone());
                }
                let why = match kind.as_str() {
                    "hook" => Some("it is a hook".to_string()),
                    "mcpServer" => Some("it starts a server program".to_string()),
                    k => self.prose_reason(kind_from_word(k), &draft.path, &text),
                };
                Ok(base(format!("Create {} {}", kind_word(kind), draft.name), kind, &draft.name, draft.path.clone(), None, Some(text), runs_commands(Some(draft.where_note), why)))
            }
            Write::UpdateItem { id, text, file, stamp } => {
                no_mask(text)?;
                too_long(text)?;
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                let plan = d.save_plan_file(id, file.as_deref()).map_err(wm)?;
                let raw = d.read_raw_file(id, file.as_deref(), false).map_err(wm)?;
                if raw.needs_reveal {
                    return Err("This holds keys or tokens, so it can be read but not changed from here. Change it in Atlas.".into());
                }
                if let Some(s) = stamp
                    && *s != raw.stamp
                {
                    return Err("That changed on disk since you read it. Read it again and retry.".into());
                }
                if let Some(p) = sw::validate(plan.kind, &plan.language, plan.folder_name.as_deref(), matches!(plan.unit, sw::Unit::Entry { .. }), text).first() {
                    return Err(p.message.clone());
                }
                let why = self.prose_reason(item.kind, &raw.path, text);
                Ok(base(format!("Edit {} {}", item.kind.as_str(), item.name), item.kind.as_str(), &item.name, raw.path, Some(raw.text), Some(text.clone()), runs_commands(None, why)))
            }
            Write::RenameItem { id, new_name } => {
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                d.delete_plan(id).map_err(wm)?;
                if !matches!(item.kind, ItemKind::Skill | ItemKind::Agent | ItemKind::Command | ItemKind::Rule | ItemKind::OutputStyle) {
                    return Err("Atlas can rename skills, agents, commands, rules and output styles.".into());
                }
                Ok(base(format!("Rename {} {} to {}", item.kind.as_str(), item.name, new_name.trim()), item.kind.as_str(), &item.name, item.path.clone().unwrap_or_default(), Some(item.name.clone()), Some(new_name.trim().to_string()), None))
            }
            Write::DeleteItem { id } => {
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                d.delete_plan(id).map_err(wm)?;
                let before = d.read_source(id).ok().map(|v| v.text);
                Ok(base(format!("Delete {} {}", item.kind.as_str(), item.name), item.kind.as_str(), &item.name, item.path.clone().unwrap_or_default(), before, None, Some("Kept in Atlas's backups, so it can be restored.".into())))
            }
            Write::ToggleHook { id, enabled } => {
                if let Some(bid) = id.strip_prefix(PARKED_PREFIX) {
                    let info = sw::list_parked(&self.backups).into_iter().find(|b| b.backup_id == bid).ok_or("That turned-off hook is no longer in Atlas's backups.")?;
                    if !*enabled {
                        return Err("That hook is already off.".into());
                    }
                    let (before, after) = self.restore_view(&info, &d);
                    return Ok(base(format!("Turn hook {} back on", info.name), "hook", &info.name, info.path.clone().unwrap_or_default(), before, after, runs_commands(None, Some("a hook runs whenever its event happens".into()))));
                }
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                if item.kind != ItemKind::Hook {
                    return Err("That is not a hook.".into());
                }
                if *enabled {
                    return Err("That hook is already on.".into());
                }
                d.delete_plan(id).map_err(wm)?;
                let before = d.read_source(id).ok().map(|v| v.text);
                Ok(base(format!("Turn hook {} off", item.name), "hook", &item.name, item.path.clone().unwrap_or_default(), before, None, Some("Its entry is kept in Atlas's backups and goes back exactly where it was when it is turned on.".into())))
            }
            Write::ToggleMcpServer { id, enabled, project } => {
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                let t = self.mcp_target(&d, item, project.as_deref(), *enabled)?;
                let word = if *enabled { "on" } else { "off" };
                Ok(base(format!("Turn MCP server {} {} for {}", item.name, word, t.labels.join(", ")), "mcpServer", &item.name, display(&self.inputs.root.claude_json), Some(if *enabled { "off" } else { "on" }.into()), Some(word.into()), None))
            }
            Write::RestoreBackup { backup_id } => {
                let info = sw::list_backups_detailed(&self.backups, usize::MAX).into_iter().find(|b| b.backup_id == *backup_id).ok_or("There is no backup with that id.")?;
                if !info.can_restore {
                    return Err("That backup can't be undone this way.".into());
                }
                if info.action == "library" {
                    let op = sw::library_op(&self.backups, backup_id).ok_or("That backup can't be undone this way.")?;
                    let what = if op.op == "install" { format!("Uninstall plugin {}", info.name) } else { format!("Reinstall plugin {}", info.name) };
                    let note = Some("Runs Claude Code's own plugin command, so a plugin's commands can run on this computer.".to_string());
                    return Ok(base(what, "plugin", &info.name, info.path.clone().unwrap_or_default(), None, None, note));
                }
                let (before, after) = self.restore_view(&info, &d);
                let why = self.backup_reason(&info, &d);
                Ok(base(format!("Undo the {} of {} {}", info.action, info.kind, info.name), &info.kind, &info.name, info.path.clone().unwrap_or_default(), before, after, runs_commands(info.summary.clone(), why)))
            }
        }
    }

    // ------------------------------------------------------------ writes

    pub fn apply(&self, w: &Write) -> Result<Applied, String> {
        let _guard = crate::writelock::acquire(&self.data_dir, Duration::from_secs(15)).map_err(|e| e.to_string())?;
        let d = self.discovery();
        match w {
            Write::CreateItem { kind, name, event, text } => {
                if matches!(kind.as_str(), "hook" | "mcpServer") {
                    self.guard_code(if kind == "hook" { "hooks" } else { "MCP servers" })?;
                }
                let draft = sw::create_draft(kind, name, event.as_deref(), &self.ctx()).map_err(wm)?;
                let text = text.clone().unwrap_or_else(|| draft.text.clone());
                no_mask(&text)?;
                too_long(&text)?;
                if !matches!(kind.as_str(), "hook" | "mcpServer") {
                    let k = match kind.as_str() {
                        "instructions" => ItemKind::Instructions,
                        "skill" => ItemKind::Skill,
                        "agent" => ItemKind::Agent,
                        "command" => ItemKind::Command,
                        "rule" => ItemKind::Rule,
                        "outputStyle" => ItemKind::OutputStyle,
                        _ => ItemKind::Other,
                    };
                    self.guard_prose(k, &draft.path, &text)?;
                }
                let adder = |n: &str, v: &Value| crate::connect::cli_add_json(&self.cli, &self.inputs.root, n, v);
                let out = sw::create_apply_with(kind, name, event.as_deref(), &text, &self.ctx(), &self.backups, Some(&adder)).map_err(wm)?;
                let summary = format!("Created {} {}", kind_word(kind), out.name);
                self.tag(&out.backup_id, &summary);
                Ok(Applied { summary, backup_id: Some(out.backup_id), path: Some(draft.path), note: out.note })
            }
            Write::UpdateItem { id, text, file, stamp } => {
                no_mask(text)?;
                too_long(text)?;
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                if !is_prose_kind(item.kind) {
                    self.guard_code("hooks, MCP servers, settings or files of this kind")?;
                }
                if let Some(rel) = file
                    && !rel.to_ascii_lowercase().ends_with(".md")
                {
                    self.guard_code("a file that is not plain markdown (it could be a script)")?;
                }
                let plan = d.save_plan_file(id, file.as_deref()).map_err(wm)?;
                let raw = d.read_raw_file(id, file.as_deref(), false).map_err(wm)?;
                if raw.needs_reveal {
                    return Err("This holds keys or tokens, so it can be read but not changed from here. Change it in Atlas.".into());
                }
                self.guard_prose(item.kind, &raw.path, text)?;
                let expected = stamp.clone().unwrap_or_else(|| raw.stamp.clone());
                let out = sw::apply_save(&plan, text, &expected, false, &self.backups).map_err(wm)?;
                let summary = format!("Edited {} {}", item.kind.as_str(), item.name);
                if let Some(b) = &out.backup_id {
                    self.tag(b, &summary);
                }
                Ok(Applied { summary, backup_id: out.backup_id, path: Some(raw.path), note: None })
            }
            Write::RenameItem { id, new_name } => {
                let out = sw::rename_item(&d, id, new_name, &self.inputs.root.dir, &self.backups).map_err(wm)?;
                let summary = format!("Renamed {} {} to {}", out.kind, out.old_name, out.new_name);
                self.tag(&out.backup_id, &summary);
                Ok(Applied { summary, backup_id: Some(out.backup_id), path: Some(out.new_path), note: Some("The old one is in Atlas's backups. Restoring it brings the old name back; the new one then needs deleting.".into()) })
            }
            Write::DeleteItem { id } => {
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                let plan = d.delete_plan(id).map_err(wm)?;
                let out = sw::apply_delete_with(&plan, &self.backups, self.to_trash).map_err(wm)?;
                let summary = format!("Deleted {} {}", item.kind.as_str(), item.name);
                self.tag(&out.backup_id, &summary);
                let note = match (self.to_trash, out.note) {
                    (_, Some(n)) => n,
                    (true, None) => "Kept in Atlas's backups (restore_backup puts it back), and a file or folder is also in the computer's trash.".into(),
                    (false, None) => "Kept in Atlas's backups; restore_backup puts it back.".into(),
                };
                Ok(Applied { summary, backup_id: Some(out.backup_id), path: item.path.clone(), note: Some(note) })
            }
            Write::ToggleHook { id, enabled } => {
                if let Some(bid) = id.strip_prefix(PARKED_PREFIX) {
                    if !*enabled {
                        return Err("That hook is already off.".into());
                    }
                    // Turning a hook on makes it run again, so it is code coming back.
                    self.guard_code("hooks")?;
                    let info = sw::list_parked(&self.backups).into_iter().find(|b| b.backup_id == bid).ok_or("That turned-off hook is no longer in Atlas's backups.")?;
                    let out = sw::restore(&self.backups, bid, &self.confine(&d)).map_err(wm)?;
                    sw::set_parked(&self.backups, bid, false);
                    let summary = format!("Turned hook {} back on", out.name);
                    self.tag(bid, &summary);
                    return Ok(Applied { summary, backup_id: Some(bid.to_string()), path: info.path, note: None });
                }
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                if item.kind != ItemKind::Hook {
                    return Err("That is not a hook.".into());
                }
                if *enabled {
                    return Err("That hook is already on.".into());
                }
                let plan = d.delete_plan(id).map_err(wm)?;
                let out = sw::apply_delete(&plan, &self.backups).map_err(wm)?;
                let summary = format!("Turned hook {} off", item.name);
                self.tag(&out.backup_id, &summary);
                sw::set_parked(&self.backups, &out.backup_id, true);
                Ok(Applied { summary, backup_id: Some(out.backup_id.clone()), path: item.path.clone(), note: Some(format!("To turn it back on use toggle_hook with id \"{PARKED_PREFIX}{}\" and enabled true.", out.backup_id)) })
            }
            Write::ToggleMcpServer { id, enabled, project } => {
                if *enabled {
                    // Turning a server on lets Claude Code start its command.
                    self.guard_code("MCP servers")?;
                }
                let item = d.item(id).ok_or("Unknown item. Use list_items to find the id.")?;
                let t = self.mcp_target(&d, item, project.as_deref(), *enabled)?;
                let name = item.name.clone();
                let on = *enabled;
                let keys = t.keys.clone();
                let bid = sw::edit_json_keys(&self.inputs.root.claude_json, &self.backups, &format!("mcp-{}-{name}", if on { "on" } else { "off" }), "mcpServer", &name, &["projects"], |root| {
                    let projects = root.get_mut("projects").and_then(Value::as_object_mut).ok_or_else(|| WriteError::Refused("Claude Code has no projects recorded yet.".into()))?;
                    for key in &keys {
                        let p = projects.get_mut(key).and_then(Value::as_object_mut).ok_or_else(|| WriteError::Refused("Claude Code has not been used in that project yet.".into()))?;
                        let arr = p.entry("disabledMcpServers").or_insert_with(|| Value::Array(vec![]));
                        let arr = arr.as_array_mut().ok_or_else(|| WriteError::Refused("The list of turned-off servers in that project is not a list.".into()))?;
                        if on {
                            arr.retain(|v| v.as_str() != Some(name.as_str()));
                        } else if !arr.iter().any(|v| v.as_str() == Some(name.as_str())) {
                            arr.push(Value::String(name.clone()));
                        }
                    }
                    Ok(())
                })
                .map_err(wm)?;
                let summary = format!("Turned MCP server {} {} for {}", name, if on { "on" } else { "off" }, t.labels.join(", "));
                self.tag(&bid, &summary);
                Ok(Applied { summary, backup_id: Some(bid), path: Some(display(&self.inputs.root.claude_json)), note: Some("Takes effect the next time Claude Code starts in that project.".into()) })
            }
            Write::RestoreBackup { backup_id } => {
                let info = sw::list_backups_detailed(&self.backups, usize::MAX).into_iter().find(|b| b.backup_id == *backup_id).ok_or("There is no backup with that id.")?;
                if info.action == "library" {
                    // A plugin install or removal is undone through Claude Code's own command (D21).
                    if !info.can_restore {
                        return Err("That backup can't be undone this way.".into());
                    }
                    self.guard_code("plugins")?;
                    let op = sw::library_op(&self.backups, backup_id).ok_or("That backup can't be undone this way.")?;
                    let runner = crate::library::cli::Runner::new(&self.cli, &self.inputs.root).map_err(|e| e.message())?;
                    let ctx = crate::library::install::Ctx { root: &self.inputs.root, data: &self.data_dir, backups: &self.backups };
                    let now = crate::library::catalog::source_of(&self.data_dir, &op.id);
                    let done = crate::library::install::undo_plugin_backup_locked(&ctx, &runner, backup_id, now.as_ref())?;
                    let summary = format!("Undid the {} of plugin {}", if done.did == "uninstall" { "install" } else { "removal" }, done.name);
                    return Ok(Applied { summary, backup_id: Some(done.backup_id), path: info.path, note: None });
                }
                self.guard_backup(&info, &d)?;
                let out = sw::restore_any(&self.backups, backup_id, &self.confine(&d)).map_err(wm)?;
                if info.parked {
                    sw::set_parked(&self.backups, backup_id, false);
                }
                let summary = format!("Undid the {} of {} {}", info.action, out.kind, out.name);
                if let Some(nid) = &out.backup_id {
                    self.tag(nid, &summary);
                }
                self.tag(backup_id, format!("{} (undone)", info.summary.unwrap_or_default()).trim());
                Ok(Applied { summary, backup_id: out.backup_id, path: info.path, note: None })
            }
        }
    }

    /// Which projects (their spelling in `.claude.json`) a toggle touches, and what to call them.
    fn mcp_target(&self, d: &Discovery, item: &SetupItem, project: Option<&str>, enabled: bool) -> Result<McpTarget, String> {
        if item.kind != ItemKind::McpServer {
            return Err("That is not an MCP server.".into());
        }
        let Some(SourceRef::JsonEntry { file, pointer }) = d.sources.get(&item.id) else {
            return Err("Atlas turns on and off the servers kept in your Claude settings. This one comes from somewhere else.".into());
        };
        if norm_key(&display(file)) != norm_key(&display(&self.inputs.root.claude_json)) {
            return Err("Atlas turns on and off the servers kept in your Claude settings. This one comes from a project file.".into());
        }
        let cj = fs::read(&self.inputs.root.claude_json).map_err(|_| "Claude's settings file can't be read.".to_string())?;
        let cj: Value = serde_json::from_slice(cj.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&cj)).map_err(|_| "Claude's settings file can't be read as JSON.".to_string())?;
        let raw_keys: Vec<String> = cj.get("projects").and_then(Value::as_object).map(|o| o.keys().cloned().collect()).unwrap_or_default();
        let disabled_in = |key: &str| cj.get("projects").and_then(|p| p.get(key)).and_then(|p| p.get("disabledMcpServers")).and_then(Value::as_array).is_some_and(|a| a.iter().any(|v| v.as_str() == Some(item.name.as_str())));
        let mut keys = Vec::new();
        let mut labels = Vec::new();
        let mut already = 0usize;
        let mut consider = |raw: &str, label: &str| {
            if disabled_in(raw) != enabled {
                already += 1;
            } else {
                keys.push(raw.to_string());
                labels.push(label.to_string());
            }
        };
        if pointer.first().map(String::as_str) == Some("projects") {
            let raw = pointer.get(1).ok_or("That server's place in the file is not clear.")?;
            consider(raw, item.scope_label.trim_start_matches("Local \u{b7} "));
        } else {
            let per = item.mcp.as_ref().map(|m| m.per_project.clone()).unwrap_or_default();
            let chosen: Vec<_> = match project {
                None if per.len() == 1 => per.clone(),
                None => {
                    let names: Vec<String> = per.iter().map(|p| p.project_name.clone()).collect();
                    return Err(format!("This server is in more than one project. Pass project (one of: {}) or \"all\".", names.join(", ")));
                }
                Some(p) if p.eq_ignore_ascii_case("all") => per.clone(),
                Some(p) => {
                    let pid = resolve_project(d, p).ok_or_else(|| format!("No project called \"{p}\"."))?;
                    per.iter().filter(|s| s.project_id == pid).cloned().collect()
                }
            };
            if chosen.is_empty() {
                return Err("That server is not in that project.".into());
            }
            for s in &chosen {
                let Some(proj) = d.snapshot.projects.iter().find(|p| p.id == s.project_id) else { continue };
                let want = norm_key(&proj.path);
                let Some(raw) = raw_keys.iter().find(|k| norm_key(k) == want) else { continue };
                consider(raw, &s.project_name);
            }
        }
        if keys.is_empty() {
            return Err(if already > 0 { format!("{} is already {} there.", item.name, if enabled { "on" } else { "off" }) } else { "Claude Code has not been used in that project yet.".into() });
        }
        Ok(McpTarget { keys, labels })
    }
}

struct McpTarget {
    keys: Vec<String>,
    labels: Vec<String>,
}

fn display(p: &Path) -> String {
    crate::setup::display_path(p)
}

fn kind_word(kind: &str) -> String {
    match kind {
        "outputStyle" => "output style".into(),
        "mcpServer" => "MCP server".into(),
        other => other.to_string(),
    }
}

/// A project's id from an id, a name (any case) or a path.
fn resolve_project(d: &Discovery, p: &str) -> Option<String> {
    let want = norm_key(p);
    d.snapshot.projects.iter().find(|x| x.id == p || x.name.eq_ignore_ascii_case(p) || norm_key(&x.path) == want).map(|x| x.id.clone())
}

fn brief(it: &SetupItem) -> ItemBrief {
    ItemBrief {
        id: it.id.clone(),
        kind: it.kind.as_str().into(),
        name: it.name.clone(),
        scope: scope_word(it.scope).into(),
        scope_label: it.scope_label.clone(),
        description: cut(&it.description, 200).0,
        path: it.path.clone(),
        enabled: if it.enabled.label.is_empty() { String::new() } else { it.enabled.label.clone() },
        editable: it.editable,
        deletable: it.deletable,
        locked: it.locked.clone(),
        has_secrets: it.has_secrets,
    }
}

fn parked_brief(b: &sw::BackupInfo) -> ItemBrief {
    ItemBrief {
        id: format!("{PARKED_PREFIX}{}", b.backup_id),
        kind: "hook".into(),
        name: b.name.clone(),
        scope: "user".into(),
        scope_label: "Global".into(),
        description: "Turned off from Claude. Turn it back on with toggle_hook.".into(),
        path: b.path.clone(),
        enabled: "Off".into(),
        editable: false,
        deletable: false,
        locked: None,
        has_secrets: false,
    }
}
