//! The data Setup hands to the page. Plain serde types, camelCase on the wire.
//! No file bodies live here: bodies come one at a time through `source`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    Skill,
    Agent,
    Command,
    Hook,
    HookScript,
    McpServer,
    Plugin,
    Settings,
    Permission,
    StatusLine,
    OutputStyle,
    Instructions,
    Rule,
    AutoMemory,
    AgentMemory,
    Workflow,
    Keybindings,
    Theme,
    Other,
}

impl ItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ItemKind::Skill => "skill",
            ItemKind::Agent => "agent",
            ItemKind::Command => "command",
            ItemKind::Hook => "hook",
            ItemKind::HookScript => "hookScript",
            ItemKind::McpServer => "mcpServer",
            ItemKind::Plugin => "plugin",
            ItemKind::Settings => "settings",
            ItemKind::Permission => "permission",
            ItemKind::StatusLine => "statusLine",
            ItemKind::OutputStyle => "outputStyle",
            ItemKind::Instructions => "instructions",
            ItemKind::Rule => "rule",
            ItemKind::AutoMemory => "autoMemory",
            ItemKind::AgentMemory => "agentMemory",
            ItemKind::Workflow => "workflow",
            ItemKind::Keybindings => "keybindings",
            ItemKind::Theme => "theme",
            ItemKind::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ScopeKind {
    /// The Claude folder (`~/.claude`): applies everywhere.
    User,
    /// A project's `.claude/` folder or root files.
    Project,
    /// Stored in `.claude.json` for one project (private to this machine).
    Local,
    Plugin,
    /// Skills synced from the claude.ai account.
    Synced,
    Managed,
    /// claude.ai connectors (names only).
    Connector,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EnabledKind {
    On,
    Off,
    /// Output style / status line currently in use.
    Active,
    Inactive,
    /// Loses to another definition of the same name.
    Shadowed,
    Approved,
    Rejected,
    Pending,
    /// A raw `skillOverrides` value.
    Custom,
    /// Not a thing that can be switched (files, rules...).
    None,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enabled {
    pub state: EnabledKind,
    pub label: String,
    pub raw: Option<String>,
}

impl Enabled {
    pub fn none() -> Self {
        Enabled { state: EnabledKind::None, label: String::new(), raw: None }
    }
    pub fn on() -> Self {
        Enabled { state: EnabledKind::On, label: "On".into(), raw: None }
    }
    pub fn off() -> Self {
        Enabled { state: EnabledKind::Off, label: "Off".into(), raw: None }
    }
    pub fn of(state: EnabledKind, label: &str) -> Self {
        Enabled { state, label: label.into(), raw: None }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictStatus {
    Overrides,
    Overridden,
    Conflict,
    Duplicate,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefinedIn {
    pub id: String,
    pub scope_label: String,
    pub winner: bool,
    pub is_self: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub status: ConflictStatus,
    pub label: String,
    /// Winner first.
    pub defined_in: Vec<DefinedIn>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DetailRow {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub project_id: String,
    pub project_name: String,
    pub on: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInfo {
    /// stdio | http | sse | ws | name only
    pub transport: String,
    /// `command args` or `url`. Never an env or header value.
    pub summary: String,
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    pub per_project: Vec<ProjectState>,
    /// Number of projects the server is on in (user and plugin servers).
    pub on_count: u32,
    pub total_projects: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupItem {
    pub id: String,
    pub kind: ItemKind,
    pub scope: ScopeKind,
    pub scope_label: String,
    pub project_id: Option<String>,
    pub plugin: Option<String>,
    pub name: String,
    pub description: String,
    pub path: Option<String>,
    pub link_target: Option<String>,
    pub size: Option<u64>,
    pub modified_ms: Option<i64>,
    pub enabled: Enabled,
    pub conflict: Option<Conflict>,
    pub chips: Vec<String>,
    pub warnings: Vec<String>,
    pub detail: Vec<DetailRow>,
    pub attachments: Vec<String>,
    pub used_by: Option<u32>,
    pub mcp: Option<McpInfo>,
    pub backup: bool,
    /// A project file seen while Sandbox Mode is on (the sandbox copies only `.claude`).
    pub real_project_file: bool,
    /// The source holds values that are masked in the viewer.
    pub has_secrets: bool,
    /// Belongs to an agent worktree: hidden unless the page asks.
    pub worktree: bool,
    /// Atlas can open this in the editor and save it.
    pub editable: bool,
    /// Atlas can delete it (with a backup and an Undo).
    pub deletable: bool,
    /// Why Atlas will not change it (shown instead of the delete control).
    pub locked: Option<String>,
    /// What it shadows by: same-name key (never serialised).
    #[serde(skip)]
    pub shadow_key: Option<String>,
}

impl SetupItem {
    pub fn new(kind: ItemKind, scope: ScopeKind, name: impl Into<String>) -> Self {
        SetupItem {
            id: String::new(),
            kind,
            scope,
            scope_label: String::new(),
            project_id: None,
            plugin: None,
            name: name.into(),
            description: String::new(),
            path: None,
            link_target: None,
            size: None,
            modified_ms: None,
            enabled: Enabled::none(),
            conflict: None,
            chips: Vec::new(),
            warnings: Vec::new(),
            detail: Vec::new(),
            attachments: Vec::new(),
            used_by: None,
            mcp: None,
            backup: false,
            real_project_file: false,
            has_secrets: false,
            worktree: false,
            editable: false,
            deletable: false,
            locked: None,
            shadow_key: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub is_home: bool,
    pub is_worktree: bool,
    pub parent_id: Option<String>,
    pub worktree_count: u32,
    pub item_count: u32,
    pub local_mcp_count: u32,
    /// Newest transcript activity, 0 when unknown.
    pub last_activity_ms: i64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HiddenCounts {
    pub worktrees: u32,
    pub missing_projects: u32,
    /// Existing folders with no Claude files at all.
    pub empty_projects: u32,
    pub backups: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    pub dir: String,
    pub dir_exists: bool,
    pub claude_json: String,
    /// ok | missing | stale (unreadable right now, last good copy used) | unreadable
    pub claude_json_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupSnapshot {
    /// Bumped by the live layer on every refresh.
    pub version: u64,
    pub root: RootStatus,
    pub items: Vec<SetupItem>,
    /// Projects worth showing (exist and have something) plus worktrees and missing ones, flagged.
    pub projects: Vec<Project>,
    pub hidden: HiddenCounts,
    pub elapsed_ms: u64,
}

/// FNV-1a 64: stable across runs and platforms, no dependency.
pub fn fnv1a64(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// `<kind>:<16 hex>` from the normalised path and a JSON pointer.
pub fn item_id(kind: ItemKind, norm_path: &str, pointer: &str) -> String {
    format!("{}:{:016x}", kind.as_str(), fnv1a64(&format!("{norm_path}#{pointer}")))
}
