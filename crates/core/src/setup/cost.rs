//! What each piece of the setup costs, so Will can see what to trim. Read only.
//!
//! Two kinds of cost:
//! - **Loaded** items ride in the prompt of every turn that runs where they apply: CLAUDE.md
//!   files (the project's, its parent folders' and the global one), rules without `paths`,
//!   the project's memory index, the active output style, and the one line each skill,
//!   command and helper adds to the listing. MCP tool names and server instructions are
//!   measured from recent transcripts because they are not on disk.
//! - **On demand** items cost something only when they run: a skill's body when it is
//!   invoked, a helper's prompt when it is spawned. Path-scoped rules load when a matching
//!   file is touched, which the transcripts do not say, so they show their size only.
//!
//! Dollars use the real cache price: the first turn of a transcript writes its prompt to the
//! cache, every later turn reads it. `turns * read price` is the floor, writes are added for
//! the turns that started a transcript. The token counts are an estimate: see
//! [`CHARS_PER_TOKEN`].

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::frontmatter;
use super::projects::{display_name, norm_key};
use super::{read_head, value_text, Discovery, EnabledKind, ItemKind, ScopeKind, SetupItem};
use crate::usage::costmix::{CostMix, Sample};

/// Characters per token for Claude's tokenizer on this kind of text (English prose, markdown,
/// code). Measured on claude-opus-5-5 against the real prompt sizes Claude Code recorded:
/// the first turn of 141 sessions regressed on the characters of CLAUDE.md files, listings
/// and rules gives 2.4 (95% interval 2.1 to 2.9, r^2 0.89), and tool results of 2.2 to 2.4
/// chars/token between consecutive calls agree. The usual rule of thumb of 3.5 would
/// understate every figure by a third. Good to about 20%: every number is shown as an
/// estimate. Another model family may tokenize differently.
pub const CHARS_PER_TOKEN: f64 = 2.4;

/// The window the dollar figures cover.
pub const WINDOW_DAYS: u32 = 7;

/// A memory index is cut at this many lines or bytes, whichever comes first.
const MEMORY_MAX_LINES: usize = 200;
const MEMORY_MAX_BYTES: usize = 25_000;
const READ_CAP: usize = 1024 * 1024;

fn tokens(chars: usize) -> u64 {
    (chars as f64 / CHARS_PER_TOKEN).round() as u64
}

// ---------------------------------------------------------------------------- output

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostRow {
    /// The setup item this is, when it is one (parent-folder files and MCP groups are not).
    pub id: Option<String>,
    pub name: String,
    /// `ItemKind::as_str` of the thing.
    pub kind: String,
    /// Where it lives ("Global", "Project - app", "Folder - Games").
    pub scope_label: String,
    /// Where it loads: "All chats", "Chats in app", "Chats under Games".
    pub loads_in: String,
    /// True when it loads in every chat.
    pub global: bool,
    pub path: Option<String>,
    /// Tokens added to every turn it loads in (0 = none).
    pub tokens: u64,
    /// Turns it loaded in during the window.
    pub turns: u64,
    pub usd_loaded: f64,
    /// Tokens it adds when it runs (0 = it never runs on demand).
    pub body_tokens: u64,
    /// Times it ran in the window; none when Atlas cannot tell (commands, path rules).
    pub uses: Option<u64>,
    pub usd_used: f64,
    /// `usd_loaded + usd_used`.
    pub usd_week: f64,
    /// From a real prompt (MCP) instead of counted from a file.
    pub measured: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostReport {
    pub window_days: u32,
    pub chars_per_token: f64,
    /// Turns in the window (all projects).
    pub turns: u64,
    /// Tokens that load on every turn of every chat.
    pub global_tokens: u64,
    pub usd_week: f64,
    /// Some turns could not be priced (an unknown model), or there is no usage yet.
    pub incomplete: bool,
    /// Most expensive first.
    pub rows: Vec<CostRow>,
}

// ---------------------------------------------------------------------------- MCP sample

/// Per server: characters of tool names and instructions in a real prompt.
#[derive(Debug, Clone, Default)]
pub struct McpSample {
    /// (project key, server -> chars), one per sampled transcript.
    pub projects: Vec<(String, BTreeMap<String, usize>)>,
}

const SAMPLE_LINES: usize = 150;
const SAMPLE_BYTES: usize = 3 * 1024 * 1024;

/// Read the start of each transcript for the MCP tool names and server instructions Claude Code
/// put in the prompt. Anything unreadable is skipped. Reads only; keeps nothing.
pub fn sample_mcp(samples: &[Sample]) -> McpSample {
    let mut out = McpSample::default();
    for s in samples {
        if let Some(m) = read_mcp(Path::new(&s.path)) {
            out.projects.push((s.project_key.clone(), m));
        }
    }
    out
}

fn read_mcp(path: &Path) -> Option<BTreeMap<String, usize>> {
    let mut r = BufReader::new(File::open(path).ok()?);
    let mut line = Vec::new();
    let (mut lines, mut bytes) = (0usize, 0usize);
    let mut names: HashSet<String> = HashSet::new();
    let mut instr: HashMap<String, usize> = HashMap::new();
    loop {
        line.clear();
        let n = r.read_until(b'\n', &mut line).ok()?;
        if n == 0 || lines >= SAMPLE_LINES || bytes >= SAMPLE_BYTES {
            break;
        }
        lines += 1;
        bytes += n;
        let tools = memchr::memmem::find(&line, b"deferred_tools_delta").is_some();
        let blocks = memchr::memmem::find(&line, b"mcp_instructions_delta").is_some();
        if !tools && !blocks {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(&line) else { continue };
        let a = &v["attachment"];
        let list = |k: &str| -> Vec<String> {
            a[k].as_array().map(|x| x.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
        };
        match a["type"].as_str() {
            Some("deferred_tools_delta") => {
                names.extend(list("addedNames"));
                names.extend(list("readdedNames"));
                for r in list("removedNames") {
                    names.remove(&r);
                }
            }
            Some("mcp_instructions_delta") => {
                let (added, texts) = (list("addedNames"), list("addedBlocks"));
                for (server, text) in added.iter().zip(texts.iter()) {
                    instr.insert(server.clone(), text.chars().count());
                }
                for r in list("removedNames") {
                    instr.remove(&r);
                }
            }
            _ => {}
        }
    }
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    for n in &names {
        if let Some((server, _tool)) = n.strip_prefix("mcp__").and_then(|r| r.split_once("__")) {
            *out.entry(server.to_string()).or_default() += n.len() + 1;
        }
    }
    for (server, chars) in instr {
        *out.entry(server).or_default() += chars;
    }
    Some(out)
}

// ---------------------------------------------------------------------------- scopes

/// Which chats an item loads in, by the folder a chat ran in (lower-cased, forward slashes).
#[derive(Debug, Clone)]
enum Reach {
    All,
    /// This folder and everything below it.
    Under(String),
    /// Exactly this folder.
    Exact(String),
}

impl Reach {
    fn matches(&self, key: &str) -> bool {
        match self {
            Reach::All => true,
            Reach::Exact(k) => key == k,
            Reach::Under(k) => key == k || key.strip_prefix(k.as_str()).is_some_and(|r| r.starts_with('/')),
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct Rate {
    turns: u64,
    /// Dollars one token costs across those turns.
    usd_per_token: f64,
}

struct Ctx<'a> {
    d: &'a Discovery,
    mix: &'a CostMix,
    /// project id -> (key, name)
    projects: HashMap<&'a str, (String, &'a str)>,
    avg_read: f64,
    avg_write: f64,
}

impl<'a> Ctx<'a> {
    fn new(d: &'a Discovery, mix: &'a CostMix) -> Self {
        let projects = d.snapshot.projects.iter().map(|p| (p.id.as_str(), (norm_key(&p.path), p.name.as_str()))).collect();
        let (mut turns, mut read, mut write) = (0f64, 0f64, 0f64);
        for g in &mix.groups {
            if let Some(p) = mix.prices.get(&g.model) {
                turns += g.turns as f64;
                read += g.turns as f64 * p.read;
                write += g.turns as f64 * p.write;
            }
        }
        let (avg_read, avg_write) = if turns > 0.0 { (read / turns, write / turns) } else { (0.0, 0.0) };
        Ctx { d, mix, projects, avg_read, avg_write }
    }

    fn rate(&self, reach: &Reach) -> Rate {
        let mut r = Rate::default();
        for g in &self.mix.groups {
            if !reach.matches(&g.project_key) {
                continue;
            }
            let Some(p) = self.mix.prices.get(&g.model) else { continue };
            let starts = g.starts.min(g.turns);
            r.turns += g.turns;
            r.usd_per_token += ((g.turns - starts) as f64 * p.read + starts as f64 * p.write) / 1e6;
        }
        r
    }

    /// Where an item applies, with the label for "loads in". None = Atlas cannot place it.
    fn reach_of(&self, it: &SetupItem, exact: bool) -> Option<(Reach, String)> {
        match it.scope {
            ScopeKind::User | ScopeKind::Plugin | ScopeKind::Synced | ScopeKind::Managed => Some((Reach::All, "All chats".into())),
            ScopeKind::Project | ScopeKind::Local => {
                let (key, name) = self.projects.get(it.project_id.as_deref()?)?;
                Some(if exact {
                    (Reach::Exact(key.clone()), format!("Chats in {name}"))
                } else {
                    (Reach::Under(key.clone()), format!("Chats in {name}"))
                })
            }
            ScopeKind::Connector => None,
        }
    }

    fn row(it: Option<&SetupItem>, name: String, kind: &str, scope_label: String, reach: &Reach, loads_in: String) -> CostRow {
        CostRow {
            id: it.map(|i| i.id.clone()),
            name,
            kind: kind.into(),
            scope_label,
            loads_in,
            global: matches!(reach, Reach::All),
            path: it.and_then(|i| i.path.clone()),
            tokens: 0,
            turns: 0,
            usd_loaded: 0.0,
            body_tokens: 0,
            uses: None,
            usd_used: 0.0,
            usd_week: 0.0,
            measured: false,
        }
    }

    fn load(&self, row: &mut CostRow, reach: &Reach, chars: usize) {
        let rate = self.rate(reach);
        row.tokens = tokens(chars);
        row.turns = rate.turns;
        row.usd_loaded = row.tokens as f64 * rate.usd_per_token;
    }

    /// Dollars of running something once: its text is written to the cache, then read back on
    /// each later turn of that transcript.
    fn run_cost(&self, body_tokens: u64, uses: u64, turns_after: f64) -> f64 {
        uses as f64 * body_tokens as f64 * (self.avg_write + turns_after * self.avg_read) / 1e6
    }
}

fn is_loaded(it: &SetupItem) -> bool {
    !it.backup
        && !it.worktree
        && !matches!(it.enabled.state, EnabledKind::Off | EnabledKind::Inactive | EnabledKind::Shadowed | EnabledKind::Rejected | EnabledKind::Pending)
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn file_text(it: &SetupItem, cap: usize) -> Option<String> {
    read_head(Path::new(it.path.as_deref()?), cap)
}

// ---------------------------------------------------------------------------- estimate

pub fn estimate(d: &Discovery, mix: &CostMix, mcp: &McpSample) -> CostReport {
    let cx = Ctx::new(d, mix);
    let mut rows: Vec<CostRow> = Vec::new();
    let items = &d.snapshot.items;

    for it in items.iter().filter(|i| is_loaded(i) && i.path.is_some()) {
        match it.kind {
            ItemKind::Instructions => cx.instruction(it, &mut rows),
            ItemKind::Rule => cx.rule(it, &mut rows),
            ItemKind::AutoMemory => cx.memory(it, &mut rows),
            ItemKind::OutputStyle => cx.style(it, &mut rows),
            ItemKind::Skill | ItemKind::Command | ItemKind::Agent => cx.listed(it, &mut rows),
            _ => {}
        }
    }
    cx.parent_folders(&mut rows);
    cx.mcp(mcp, &mut rows);

    rows.retain(|r| r.tokens > 0 || r.body_tokens > 0);
    for r in &mut rows {
        r.usd_week = r.usd_loaded + r.usd_used;
    }
    rows.sort_by(|a, b| b.usd_week.total_cmp(&a.usd_week).then(b.tokens.cmp(&a.tokens)).then_with(|| a.name.cmp(&b.name)));
    let turns = mix.total_turns();
    CostReport {
        window_days: mix.days,
        chars_per_token: CHARS_PER_TOKEN,
        turns,
        global_tokens: rows.iter().filter(|r| r.global).map(|r| r.tokens).sum(),
        usd_week: rows.iter().map(|r| r.usd_week).sum(),
        incomplete: turns == 0 || mix.unpriced_turns > 0,
        rows,
    }
}

impl Ctx<'_> {
    /// CLAUDE.md and CLAUDE.local.md. AGENTS.md is not read by Claude Code.
    fn instruction(&self, it: &SetupItem, rows: &mut Vec<CostRow>) {
        if it.name.eq_ignore_ascii_case("AGENTS.md") {
            return;
        }
        let Some((reach, loads)) = self.reach_of(it, false) else { return };
        let Some(text) = file_text(it, READ_CAP) else { return };
        let mut r = Self::row(Some(it), it.name.clone(), it.kind.as_str(), it.scope_label.clone(), &reach, loads);
        self.load(&mut r, &reach, text.chars().count());
        rows.push(r);
    }

    fn rule(&self, it: &SetupItem, rows: &mut Vec<CostRow>) {
        let Some((reach, loads)) = self.reach_of(it, false) else { return };
        let Some(text) = file_text(it, READ_CAP) else { return };
        let mut r = Self::row(Some(it), it.name.clone(), it.kind.as_str(), it.scope_label.clone(), &reach, loads);
        let chars = text.chars().count();
        if it.chips.is_empty() {
            self.load(&mut r, &reach, chars);
        } else {
            // Loads when a file matching `paths` is touched; the transcripts do not say when.
            r.body_tokens = tokens(chars);
        }
        rows.push(r);
    }

    /// Only the index (`MEMORY.md`) is loaded, cut at 200 lines or 25 KB; other memory files
    /// are read when Claude asks for them.
    fn memory(&self, it: &SetupItem, rows: &mut Vec<CostRow>) {
        if !it.name.eq_ignore_ascii_case("MEMORY.md") {
            return;
        }
        let Some((reach, loads)) = self.reach_of(it, true) else { return };
        let Some(text) = file_text(it, READ_CAP) else { return };
        let mut kept = String::new();
        for l in text.lines().take(MEMORY_MAX_LINES) {
            if kept.len() + l.len() + 1 > MEMORY_MAX_BYTES {
                break;
            }
            kept.push_str(l);
            kept.push('\n');
        }
        let mut r = Self::row(Some(it), it.name.clone(), it.kind.as_str(), it.scope_label.clone(), &reach, loads);
        self.load(&mut r, &reach, kept.chars().count());
        rows.push(r);
    }

    /// The style in use adds its text to the system prompt.
    fn style(&self, it: &SetupItem, rows: &mut Vec<CostRow>) {
        if it.enabled.state != EnabledKind::Active {
            return;
        }
        let Some((reach, loads)) = self.reach_of(it, false) else { return };
        let Some(text) = file_text(it, READ_CAP) else { return };
        let (_, body, _) = frontmatter::split(&text);
        let mut r = Self::row(Some(it), it.name.clone(), it.kind.as_str(), it.scope_label.clone(), &reach, loads);
        self.load(&mut r, &reach, body.chars().count());
        rows.push(r);
    }

    /// Skills, commands and helpers: one listing line on every turn, the body when they run.
    fn listed(&self, it: &SetupItem, rows: &mut Vec<CostRow>) {
        let Some((reach, loads)) = self.reach_of(it, false) else { return };
        let Some(text) = file_text(it, 512 * 1024) else { return };
        let meta = frontmatter::analyze(&text);
        let fm = meta.fm.as_ref();
        let field = |k: &str| fm.and_then(|m| m.get(k)).map(value_text).filter(|s| !s.is_empty());

        // The listing names plugin items `plugin:name`.
        let mut name = it.name.clone();
        if let Some(p) = it.plugin.as_deref().filter(|_| it.scope == ScopeKind::Plugin && !name.contains(':')) {
            name = format!("{p}:{name}");
        }
        // Claude.ai synced skills are all listed as `anthropic-skills:name`, whatever the
        // manifest calls their source (seen in a real skill listing).
        if it.scope == ScopeKind::Synced
            && let Some((_, base)) = name.split_once(':')
        {
            name = format!("anthropic-skills:{base}");
        }
        let desc = if it.kind == ItemKind::Command {
            Some(meta.description.clone()).filter(|s| !s.is_empty()).or_else(|| meta.first_line.clone()).unwrap_or_default()
        } else if meta.description.is_empty() {
            it.description.clone()
        } else {
            meta.description.clone()
        };

        let mut r = Self::row(Some(it), name.clone(), it.kind.as_str(), it.scope_label.clone(), &reach, loads);
        let hidden = truthy(fm.and_then(|m| m.get("disable-model-invocation")));
        if !hidden {
            // "- name: description - when_to_use" for skills, "- name: description (Tools: ...)" for helpers.
            let mut line = format!("- {name}: {desc}");
            match it.kind {
                ItemKind::Agent => line.push_str(&format!(" (Tools: {})", field("tools").unwrap_or_else(|| "All tools".into()))),
                _ => {
                    if let Some(w) = field("when_to_use") {
                        line.push_str(" - ");
                        line.push_str(&w);
                    }
                }
            }
            self.load(&mut r, &reach, line.chars().count() + 1);
        }

        let (_, body, _) = frontmatter::split(&text);
        r.body_tokens = tokens(body.chars().count());
        match it.kind {
            ItemKind::Skill | ItemKind::Agent => {
                let kind = if it.kind == ItemKind::Skill { "skill" } else { "agent" };
                let uses = self.mix.item_uses.get(&(kind.to_string(), name.to_lowercase())).copied().unwrap_or(0);
                // A skill is read for the rest of the chat it runs in; a helper's prompt for its whole run.
                let after = if it.kind == ItemKind::Skill { self.mix.avg_turns_main / 2.0 } else { self.mix.avg_turns_helper };
                r.uses = Some(uses);
                r.usd_used = self.run_cost(r.body_tokens, uses, after);
            }
            _ => {}
        }
        rows.push(r);
    }

    /// CLAUDE.md files in the folders above a project load in every chat below them.
    fn parent_folders(&self, rows: &mut Vec<CostRow>) {
        let known: HashSet<String> = self.d.snapshot.items.iter().filter_map(|i| i.path.as_deref()).map(norm_key).collect();
        let mut dirs: BTreeMap<String, std::path::PathBuf> = BTreeMap::new();
        for p in self.d.snapshot.projects.iter().filter(|p| !p.is_worktree) {
            let mut cur = Path::new(&p.path).parent();
            while let Some(dir) = cur {
                dirs.entry(norm_key(&dir.to_string_lossy())).or_insert_with(|| dir.to_path_buf());
                cur = dir.parent();
            }
        }
        for (key, dir) in dirs {
            for rel in ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"] {
                let file = dir.join(rel);
                let shown = file.to_string_lossy().into_owned();
                if known.contains(&norm_key(&shown)) {
                    continue;
                }
                let Some(text) = read_head(&file, READ_CAP) else { continue };
                let folder = display_name(&dir.to_string_lossy());
                let reach = Reach::Under(key.clone());
                let mut r = Self::row(None, rel.rsplit('/').next().unwrap_or(rel).to_string(), "instructions", format!("Folder \u{b7} {folder}"), &reach, format!("Chats under {folder}"));
                r.path = Some(shown);
                self.load(&mut r, &reach, text.chars().count());
                rows.push(r);
            }
        }
    }

    /// Tool names and server instructions as they stood in recent prompts.
    fn mcp(&self, sample: &McpSample, rows: &mut Vec<CostRow>) {
        // server -> (chars seen, projects seen in, usd, turns)
        let mut by: BTreeMap<&str, (usize, usize, f64, u64)> = BTreeMap::new();
        for (key, servers) in &sample.projects {
            let rate = self.rate(&Reach::Exact(key.clone()));
            for (server, &chars) in servers {
                let t = tokens(chars) as f64;
                let e = by.entry(server.as_str()).or_default();
                e.0 += chars;
                e.1 += 1;
                e.2 += t * rate.usd_per_token;
                e.3 += rate.turns;
            }
        }
        let mut other = (0usize, 0usize, 0f64, 0u64);
        for (server, (chars, n, usd, turns)) in by {
            let item = self
                .d
                .snapshot
                .items
                .iter()
                .find(|i| i.kind == ItemKind::McpServer && i.name == server && is_loaded(i));
            let mean = chars / n.max(1);
            match item {
                Some(it) => {
                    let mut r = Self::row(Some(it), it.name.clone(), "mcpServer", it.scope_label.clone(), &Reach::Exact(String::new()), "Chats that connect it".into());
                    r.global = false;
                    r.tokens = tokens(mean);
                    r.turns = turns;
                    r.usd_loaded = usd;
                    r.measured = true;
                    rows.push(r);
                }
                None => {
                    other.0 += mean;
                    other.1 += 1;
                    other.2 += usd;
                    other.3 = other.3.max(turns);
                }
            }
        }
        if other.1 > 0 {
            let reach = Reach::Exact(String::new());
            let mut r = Self::row(None, format!("Other connected tools ({})", other.1), "mcpServer", "Claude app and claude.ai".into(), &reach, "Chats that connect them".into());
            r.global = false;
            r.tokens = tokens(other.0);
            r.turns = other.3;
            r.usd_loaded = other.2;
            r.measured = true;
            rows.push(r);
        }
    }
}
