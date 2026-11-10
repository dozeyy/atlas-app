//! Setup write path (outside `setup/`, which stays read only by construction): the only code that changes the user's Claude setup.
//!
//! Every change is the same three steps: **back up** what is about to change into
//! Atlas's own backups folder, **change it** (an atomic write for files and JSON
//! entries, a remove for a deleted file or folder), then **check** the result by
//! reading it back. A delete can be undone byte for byte (`restore`); a save keeps
//! the previous version in the backup. Nothing here runs unless the user pressed
//! Delete or Save, and in debug builds `fsutil::check_write_allowed` refuses the
//! real Claude folder before any step touches the disk.
//!
//! The functions are split in two: `Discovery` methods turn an item id into a plan
//! (what exactly to change; the id registry is the allow-list), and the `apply_*`
//! functions carry a plan out. Tests build plans by hand.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::setup::capability::{capability, Capability};
use crate::setup::frontmatter;
use crate::setup::model::{fnv1a64, ItemKind, SetupItem};
use crate::setup::secrets;
use crate::setup::{Discovery, SourceRef};
use crate::fsutil::{atomic_write, check_write_allowed};

static COUNTER: AtomicU64 = AtomicU64::new(0);

struct RawText {
    text: String,
    bom: bool,
    crlf: bool,
    stamp: String,
    has_secrets: bool,
}

fn language_of_path(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref() {
        Some("md" | "markdown") => "markdown",
        Some("json" | "jsonc") => "json",
        Some("js" | "mjs" | "cjs") => "javascript",
        Some("ts") => "typescript",
        Some("sh" | "bash") => "shell",
        Some("ps1") => "powershell",
        Some("py") => "python",
        Some("yml" | "yaml") => "yaml",
        Some("toml") => "toml",
        _ => "text",
    }
}

/// (text without BOM and with LF endings, had a BOM, used CRLF)
fn strip_bom_and_eol(s: &str) -> (String, bool, bool) {
    let bom = s.starts_with('\u{feff}');
    let t = if bom { &s[3..] } else { s };
    let crlf = t.contains("\r\n");
    (if crlf { t.replace("\r\n", "\n") } else { t.to_string() }, bom, crlf)
}

const EDIT_CAP: u64 = 1024 * 1024;

// ---------------------------------------------------------------------------
// Errors and outcomes
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum WriteError {
    /// Something to tell the user in plain words; nothing was changed.
    Refused(String),
    /// The file changed on disk since the editor opened it.
    Conflict,
    Io(io::Error),
}

impl From<io::Error> for WriteError {
    fn from(e: io::Error) -> Self {
        if e.kind() == io::ErrorKind::PermissionDenied && e.to_string().starts_with("refused:") {
            WriteError::Refused(e.to_string())
        } else {
            WriteError::Io(e)
        }
    }
}

impl WriteError {
    pub fn message(&self) -> String {
        match self {
            WriteError::Refused(m) => m.clone(),
            WriteError::Conflict => "This changed on disk since you opened it.".into(),
            WriteError::Io(e) => format!("Atlas could not finish: {e}"),
        }
    }
}

type Res<T> = Result<T, WriteError>;

fn refuse<T>(m: impl Into<String>) -> Res<T> {
    Err(WriteError::Refused(m.into()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteOutcome {
    pub backup_id: String,
    pub name: String,
    pub kind: String,
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoOutcome {
    pub name: String,
    pub kind: String,
    /// The safety backup a wider restore (`restore_any`) made of what it replaced.
    pub backup_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveOutcome {
    pub backup_id: Option<String>,
    /// Stamp of what is on disk now (for the next conflict check).
    pub stamp: String,
    pub note: Option<String>,
}

/// One thing wrong with the text, with a 1-based line when known.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Problem {
    pub message: String,
    pub line: Option<u32>,
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Unit {
    /// A file, or a whole folder (a skill).
    Path { path: PathBuf, is_dir: bool },
    /// One entry inside a JSON file.
    Entry { file: PathBuf, pointer: Vec<String> },
}

#[derive(Debug, Clone)]
pub struct DeletePlan {
    pub id: String,
    pub name: String,
    pub kind: ItemKind,
    pub unit: Unit,
}

#[derive(Debug, Clone)]
pub struct SavePlan {
    pub id: String,
    pub name: String,
    pub kind: ItemKind,
    pub unit: Unit,
    /// For skills: the folder name the frontmatter name must equal.
    pub folder_name: Option<String>,
    pub language: String,
}

impl Discovery {
    fn plan_unit(&self, id: &str) -> Res<(SetupItem, SourceRef, Capability)> {
        let item = self.item(id).cloned().ok_or_else(|| WriteError::Refused("Unknown item. Refresh the page and try again.".into()))?;
        let src = self.sources.get(id).cloned().ok_or_else(|| WriteError::Refused("Unknown item. Refresh the page and try again.".into()))?;
        let cap = capability(&item, Some(&src));
        Ok((item, src, cap))
    }

    pub fn delete_plan(&self, id: &str) -> Res<DeletePlan> {
        let (item, src, cap) = self.plan_unit(id)?;
        if let Some(why) = cap.locked {
            return refuse(why);
        }
        if !cap.deletable {
            return refuse("Atlas does not remove this kind of item.");
        }
        let unit = match (&item.kind, &src) {
            (ItemKind::Skill, SourceRef::File { path }) => {
                let dir = path.parent().ok_or_else(|| WriteError::Refused("This skill has no folder.".into()))?.to_path_buf();
                Unit::Path { path: dir, is_dir: true }
            }
            (_, SourceRef::File { path }) => Unit::Path { path: path.clone(), is_dir: false },
            (_, SourceRef::JsonEntry { file, pointer }) => Unit::Entry { file: file.clone(), pointer: pointer.clone() },
            _ => return refuse("Atlas does not remove this kind of item."),
        };
        Ok(DeletePlan { id: id.to_string(), name: item.name.clone(), kind: item.kind, unit })
    }

    pub fn save_plan(&self, id: &str) -> Res<SavePlan> {
        self.save_plan_file(id, None)
    }

    /// Like `save_plan`, but `file` (a path relative to the skill's folder, as listed by
    /// `skill_files`) picks one of a skill's supporting files instead of its SKILL.md.
    pub fn save_plan_file(&self, id: &str, file: Option<&str>) -> Res<SavePlan> {
        let (item, src, cap) = self.plan_unit(id)?;
        if let Some(why) = cap.locked {
            return refuse(why);
        }
        if !cap.editable {
            return refuse("Atlas does not edit this kind of item.");
        }
        let (unit, language, folder_name) = match &src {
            SourceRef::File { path } => {
                let target = match file {
                    Some(rel) if item.kind == ItemKind::Skill => {
                        let dir = path.parent().ok_or_else(|| WriteError::Refused("This skill has no folder.".into()))?;
                        safe_join(dir, rel)?
                    }
                    Some(_) => return refuse("Only a skill has more than one file."),
                    None => {
                        // SKILL.md itself may be a link to a file outside the skill.
                        if item.kind == ItemKind::Skill
                            && let Some(dir) = path.parent()
                        {
                            inside(dir, path)?;
                        }
                        path.clone()
                    }
                };
                let folder = (item.kind == ItemKind::Skill && target == *path).then(|| path.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned())).flatten();
                let language = language_of_path(&target).to_string();
                (Unit::Path { path: target, is_dir: false }, language, folder)
            }
            SourceRef::JsonEntry { .. } if file.is_some() => return refuse("Only a skill has more than one file."),
            SourceRef::JsonEntry { file, pointer } => (Unit::Entry { file: file.clone(), pointer: pointer.clone() }, "json".to_string(), None),
            SourceRef::Text(_) => return refuse("There is no file on this computer to edit."),
        };
        Ok(SavePlan { id: id.to_string(), name: item.name.clone(), kind: item.kind, unit, folder_name, language })
    }

    /// The raw (unmasked) text for the editor. Only for items Atlas may edit.
    pub fn read_raw(&self, id: &str, reveal: bool) -> Res<RawEdit> {
        self.read_raw_file(id, None, reveal)
    }

    pub fn read_raw_file(&self, id: &str, file: Option<&str>, reveal: bool) -> Res<RawEdit> {
        let plan = self.save_plan_file(id, file)?;
        let raw = read_unit_text(&plan.unit).map_err(WriteError::Refused)?;
        let hidden = raw.has_secrets && !reveal;
        Ok(RawEdit {
            id: id.to_string(),
            text: if hidden { String::new() } else { raw.text },
            needs_reveal: hidden,
            language: plan.language,
            stamp: raw.stamp,
            line_ending: if raw.crlf { "CRLF" } else { "LF" }.into(),
            bom: raw.bom,
            path: unit_display(&plan.unit),
            has_secrets: raw.has_secrets,
            folder_name: plan.folder_name,
        })
    }

    pub fn validate_text(&self, id: &str, text: &str) -> Res<Vec<Problem>> {
        self.validate_text_file(id, None, text)
    }

    pub fn validate_text_file(&self, id: &str, file: Option<&str>, text: &str) -> Res<Vec<Problem>> {
        let plan = self.save_plan_file(id, file)?;
        Ok(validate(plan.kind, &plan.language, plan.folder_name.as_deref(), matches!(plan.unit, Unit::Entry { .. }), text))
    }

    /// The files in a skill's folder: SKILL.md first, then the rest by path. Read only.
    pub fn skill_files(&self, id: &str) -> Res<Vec<SkillFile>> {
        let (item, src, _) = self.plan_unit(id)?;
        let SourceRef::File { path } = &src else { return Ok(Vec::new()) };
        if item.kind != ItemKind::Skill {
            return Ok(Vec::new());
        }
        let dir = path.parent().ok_or_else(|| WriteError::Refused("This skill has no folder.".into()))?;
        let main = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut out = Vec::new();
        walk_skill(dir, "", 0, &mut out);
        out.sort_by(|a, b| (b.rel == main).cmp(&(a.rel == main)).then_with(|| a.rel.to_lowercase().cmp(&b.rel.to_lowercase())));
        for f in &mut out {
            f.main = f.rel == main;
        }
        Ok(out)
    }

    /// The file on disk behind an item (or one of a skill's files) for "Show in folder" and
    /// "Open in editor". Only what the scan found, so never a path the page made up.
    pub fn file_target(&self, id: &str, file: Option<&str>) -> Res<PathBuf> {
        let (item, src, _) = self.plan_unit(id)?;
        let path = match &src {
            SourceRef::File { path } => match file {
                Some(rel) if item.kind == ItemKind::Skill => safe_join(path.parent().ok_or_else(|| WriteError::Refused("This skill has no folder.".into()))?, rel)?,
                Some(_) => return refuse("Only a skill has more than one file."),
                None => {
                    if item.kind == ItemKind::Skill
                        && let Some(dir) = path.parent()
                    {
                        inside(dir, path)?;
                    }
                    path.clone()
                }
            },
            SourceRef::JsonEntry { file, .. } => file.clone(),
            SourceRef::Text(_) => return refuse("There is no file on this computer for this."),
        };
        if !path.is_file() {
            return refuse("The file is gone.");
        }
        // The OS opener gets a vetted, canonical, absolute path and nothing else.
        crate::fsutil::vet_open_path(&path).map_err(WriteError::Refused)
    }

    /// Copy a skill into the user's own skills folder under a new name. The copy is built
    /// beside its final place and moved in whole, and nothing existing is ever replaced.
    pub fn duplicate_skill(&self, id: &str, new_name: &str, root: &Path) -> Res<DuplicateOutcome> {
        let (item, src, _) = self.plan_unit(id)?;
        let SourceRef::File { path } = &src else { return refuse("This skill has no folder to copy.") };
        if item.kind != ItemKind::Skill {
            return refuse("Only a skill can be duplicated.");
        }
        let name = new_name.trim();
        if !valid_name(name) {
            return refuse("Use lowercase letters, numbers and dashes for the name, like my-helper.");
        }
        let src_dir = path.parent().ok_or_else(|| WriteError::Refused("This skill has no folder.".into()))?;
        let skills = root.join("skills");
        let dest = skills.join(name);
        // `symlink_metadata`: a dangling link at `dest` is "something there" too.
        let taken = |d: &Path| fs::symlink_metadata(d).is_ok();
        if taken(&dest) {
            return refuse(format!("You already have a skill called {name}."));
        }
        check_write_allowed(&dest)?;
        let (files, bytes) = tree_size(src_dir);
        if files > DUP_MAX_FILES || bytes > DUP_MAX_BYTES {
            return refuse("This skill is too big to copy here.");
        }
        fs::create_dir_all(&skills)?;
        remove_stale_copies(&skills);
        let tmp = skills.join(format!("{COPY_PREFIX}{}-{}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed) % 10_000));
        check_write_allowed(&tmp)?;
        let built = (|| -> Res<()> {
            copy_tree(src_dir, &tmp, 0)?;
            let main = tmp.join(path.file_name().unwrap_or_default());
            if main.is_file() {
                // Bytes, not lossy text: a file that is not UTF-8 is refused, never rewritten
                // with replacement characters.
                let old = String::from_utf8(fs::read(&main)?).map_err(|_| WriteError::Refused("SKILL.md is not plain UTF-8 text, so Atlas cannot rename the copy safely.".into()))?;
                fs::write(&main, with_skill_name(&old, name))?;
            }
            // Last look: on some systems a rename onto an empty folder would replace it.
            if taken(&dest) {
                return refuse(format!("You already have a skill called {name}."));
            }
            fs::rename(&tmp, &dest)?;
            Ok(())
        })();
        if built.is_err() {
            let _ = fs::remove_dir_all(&tmp);
        }
        built?;
        Ok(DuplicateOutcome { name: name.to_string(), path: crate::setup::display_path(&dest.join(path.file_name().unwrap_or_default())) })
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillFile {
    /// Path inside the skill's folder, always with `/`.
    pub rel: String,
    pub size: u64,
    pub language: String,
    /// SKILL.md itself.
    pub main: bool,
    /// Text Atlas will open in the editor.
    pub editable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateOutcome {
    pub name: String,
    pub path: String,
}

const COPY_PREFIX: &str = ".atlas-copy-";
/// A half-made copy older than this was left by a crash; the next duplicate removes it.
const STALE_COPY_MS: u64 = 10 * 60 * 1000;

/// Remove `.atlas-copy-<ms>-<n>` folders a crashed duplicate left behind. Young ones (another
/// duplicate may be running) and names that do not parse are left alone.
fn remove_stale_copies(skills: &Path) {
    let Ok(rd) = fs::read_dir(skills) else { return };
    let now = now_ms();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix(COPY_PREFIX) else { continue };
        let Some(ms) = rest.split('-').next().and_then(|s| s.parse::<u64>().ok()) else { continue };
        let path = e.path();
        if now.saturating_sub(ms) > STALE_COPY_MS && e.file_type().is_ok_and(|t| t.is_dir()) && check_write_allowed(&path).is_ok() {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

const SKILL_FILES_MAX: usize = 80;
const SKILL_DEPTH_MAX: usize = 4;
const DUP_MAX_FILES: u64 = 400;
const DUP_MAX_BYTES: u64 = 16 * 1024 * 1024;

/// Extensions Atlas treats as text without opening the file (the editor still refuses a
/// file with binary content when it is opened).
fn is_text_name(name: &str) -> bool {
    match Path::new(name).extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
        None => true,
        Some(e) => matches!(e.as_str(), "md" | "markdown" | "txt" | "json" | "jsonc" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "sh" | "bash" | "ps1" | "py" | "yml" | "yaml" | "toml" | "csv" | "html" | "css" | "xml" | "ini" | "cfg" | "rb" | "go" | "rs" | "lua"),
    }
}

fn walk_skill(dir: &Path, rel: &str, depth: usize, out: &mut Vec<SkillFile>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        if out.len() >= SKILL_FILES_MAX {
            return;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        let here = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        if ft.is_dir() {
            if depth < SKILL_DEPTH_MAX && name != ".git" && name != "node_modules" {
                walk_skill(&e.path(), &here, depth + 1, out);
            }
        } else if ft.is_file() {
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            out.push(SkillFile { language: language_of_path(&e.path()).to_string(), editable: is_text_name(&name) && size <= EDIT_CAP, rel: here, size, main: false });
        }
    }
}

/// (file count, bytes) of what `copy_tree` will actually copy: links out of the folder do
/// not count, because they are not copied.
fn tree_size(p: &Path) -> (u64, u64) {
    let (mut files, mut bytes) = (0, 0);
    let Ok(root) = fs::canonicalize(p) else { return (0, 0) };
    let mut stack = vec![p.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            match copy_kind(&e.path(), &ft, &root) {
                Ok(CopyKind::Dir) => stack.push(e.path()),
                Ok(CopyKind::File) => {
                    // `metadata` follows a link inside the folder, as the copy does.
                    files += 1;
                    bytes += fs::metadata(e.path()).map(|m| m.len()).unwrap_or(0);
                }
                // A folder link is refused by the copy itself.
                Ok(CopyKind::Skip) | Err(_) => {}
            }
            if files > DUP_MAX_FILES || bytes > DUP_MAX_BYTES {
                return (files, bytes);
            }
        }
    }
    (files, bytes)
}

/// `dir` + `rel`, refusing anything that could leave `dir`: an absolute path, `..`, a
/// drive, or a link that points elsewhere.
pub fn safe_join(dir: &Path, rel: &str) -> Res<PathBuf> {
    let bad = || WriteError::Refused("That file is not inside this skill.".into());
    if rel.is_empty() || rel.contains('\0') {
        return Err(bad());
    }
    let mut out = dir.to_path_buf();
    for part in rel.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') {
            return Err(bad());
        }
        out.push(part);
    }
    inside(dir, &out)?;
    Ok(out)
}

/// Refuses `file` when it resolves (through a link) to somewhere outside `dir`. A file that
/// does not exist yet cannot be checked and passes; reading or writing it fails on its own.
pub fn inside(dir: &Path, file: &Path) -> Res<()> {
    if let (Ok(real), Ok(base)) = (fs::canonicalize(file), fs::canonicalize(dir))
        && !real.starts_with(&base)
    {
        return Err(WriteError::Refused("That file is not inside this skill.".into()));
    }
    Ok(())
}

/// Sets `name:` in a SKILL.md's frontmatter (adds it when missing). Text with no
/// frontmatter is returned as it was.
pub fn with_skill_name(text: &str, name: &str) -> String {
    let (bom, body) = match text.strip_prefix('\u{feff}') {
        Some(b) => ("\u{feff}", b),
        None => ("", text),
    };
    let lines: Vec<&str> = body.split_inclusive('\n').collect();
    if lines.first().is_none_or(|l| l.trim_end() != "---") {
        return text.to_string();
    }
    let eol = |l: &str| if l.ends_with("\r\n") { "\r\n" } else { "\n" };
    let mut out = String::from(bom);
    let mut done = false;
    let mut closed = false;
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim_end();
        if i > 0 && !closed && t == "---" {
            closed = true;
            if !done {
                out.push_str(&format!("name: {name}{}", eol(l)));
                done = true;
            }
        }
        let is_name = i > 0 && !closed && !done && t.strip_prefix("name").is_some_and(|r| r.trim_start().starts_with(':'));
        if is_name {
            out.push_str(&format!("name: {name}{}", eol(l)));
            done = true;
        } else {
            out.push_str(l);
        }
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawEdit {
    pub id: String,
    pub text: String,
    pub language: String,
    pub stamp: String,
    pub line_ending: String,
    pub bom: bool,
    pub path: String,
    pub has_secrets: bool,
    /// The text holds secrets and was left out: ask again with `reveal`.
    pub needs_reveal: bool,
    pub folder_name: Option<String>,
}

fn unit_display(u: &Unit) -> String {
    match u {
        Unit::Path { path, .. } => crate::setup::display_path(path),
        Unit::Entry { file, .. } => crate::setup::display_path(file),
    }
}

// ---------------------------------------------------------------------------
// Reading the text to edit, and its stamp
// ---------------------------------------------------------------------------

fn stamp_of(bytes: &[u8]) -> String {
    format!("{:016x}", fnv1a64(&String::from_utf8_lossy(bytes)))
}

fn read_unit_text(u: &Unit) -> Result<RawText, String> {
    match u {
        Unit::Path { path, .. } => {
            let md = fs::metadata(path).map_err(|_| "The file is gone.".to_string())?;
            if md.len() > EDIT_CAP {
                return Err("This file is too large to edit here.".into());
            }
            let bytes = fs::read(path).map_err(|_| "The file can't be read.".to_string())?;
            if bytes.iter().take(8192).any(|&b| b == 0) {
                return Err("This is a binary file.".into());
            }
            let stamp = stamp_of(&bytes);
            let (text, bom, crlf) = strip_bom_and_eol(&String::from_utf8_lossy(&bytes));
            let language = language_of_path(path);
            let has_secrets = if language == "json" { !secrets::mask_json(&text).ranges.is_empty() } else { !secrets::mask_plain(&text).ranges.is_empty() };
            Ok(RawText { text, bom, crlf, stamp, has_secrets })
        }
        Unit::Entry { file, pointer } => {
            let bytes = fs::read(file).map_err(|_| "The file is gone.".to_string())?;
            let v = parse_json_bytes(&bytes).map_err(|e| format!("The file can't be read as JSON ({e})."))?;
            let entry = navigate(&v, pointer).ok_or_else(|| "This entry is gone.".to_string())?;
            let text = serde_json::to_string_pretty(entry).map_err(|_| "Can't show this entry.".to_string())?;
            let has_secrets = !secrets::mask_json(&text).ranges.is_empty();
            Ok(RawText { stamp: stamp_of(text.as_bytes()), text, bom: false, crlf: false, has_secrets })
        }
    }
}

// ---------------------------------------------------------------------------
// JSON files: parse, edit one entry, write back in the file's own style
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Style {
    bom: bool,
    crlf: bool,
    indent: Vec<u8>,
    trailing_newline: bool,
}

impl Default for Style {
    fn default() -> Self {
        Style { bom: false, crlf: false, indent: b"  ".to_vec(), trailing_newline: true }
    }
}

fn detect_style(bytes: &[u8]) -> Style {
    let bom = bytes.starts_with(&[0xEF, 0xBB, 0xBF]);
    let body = if bom { &bytes[3..] } else { bytes };
    let crlf = body.windows(2).any(|w| w == b"\r\n");
    let mut indent = b"  ".to_vec();
    for line in body.split(|&b| b == b'\n') {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        let ws = line.iter().take_while(|&&b| b == b' ' || b == b'\t').count();
        if ws > 0 && ws < line.len() {
            indent = line[..ws].to_vec();
            break;
        }
    }
    Style { bom, crlf, indent, trailing_newline: body.ends_with(b"\n") }
}

fn parse_json_bytes(bytes: &[u8]) -> Result<Value, String> {
    let s = String::from_utf8_lossy(bytes);
    serde_json::from_str(s.trim_start_matches('\u{feff}')).map_err(|e| format!("line {}, column {}", e.line(), e.column()))
}

fn render_json(v: &Value, st: &Style) -> Vec<u8> {
    use serde::Serialize;
    let mut buf = Vec::new();
    let fmt = serde_json::ser::PrettyFormatter::with_indent(&st.indent);
    let mut ser = serde_json::Serializer::with_formatter(&mut buf, fmt);
    v.serialize(&mut ser).expect("a Value always serialises");
    let mut s = String::from_utf8(buf).expect("serde_json writes UTF-8");
    if st.crlf {
        s = s.replace('\n', "\r\n");
    }
    if st.trailing_newline {
        s.push_str(if st.crlf { "\r\n" } else { "\n" });
    }
    let mut out = Vec::with_capacity(s.len() + 3);
    if st.bom {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(s.as_bytes());
    out
}

fn navigate<'a>(v: &'a Value, pointer: &[String]) -> Option<&'a Value> {
    let mut cur = v;
    for seg in pointer {
        cur = match cur {
            Value::Object(m) => m.get(seg)?,
            Value::Array(a) => a.get(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

fn navigate_mut<'a>(v: &'a mut Value, pointer: &[String]) -> Option<&'a mut Value> {
    let mut cur = v;
    for seg in pointer {
        cur = match cur {
            Value::Object(m) => m.get_mut(seg)?,
            Value::Array(a) => a.get_mut(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

/// Where a removed value sat, so it can go back to the same place.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Removed {
    /// Pointer of the highest thing removed (may be shorter than asked: empty parents go too).
    pointer: Vec<String>,
    index: usize,
    parent_is_array: bool,
    value: Value,
}

fn remove_at(root: &mut Value, pointer: &[String]) -> Option<Removed> {
    let (last, parent_ptr) = pointer.split_last()?;
    let parent = navigate_mut(root, parent_ptr)?;
    match parent {
        Value::Object(m) => {
            let index = m.keys().position(|k| k == last)?;
            let value = m.shift_remove(last)?;
            Some(Removed { pointer: pointer.to_vec(), index, parent_is_array: false, value })
        }
        Value::Array(a) => {
            let index = last.parse::<usize>().ok()?;
            if index >= a.len() {
                return None;
            }
            let value = a.remove(index);
            Some(Removed { pointer: pointer.to_vec(), index, parent_is_array: true, value })
        }
        _ => None,
    }
}

/// Remove an entry; when it was the last child of a hook group or event, remove
/// the emptied parents too (`hooks.<Event>[i].hooks[j]` -> group -> event).
fn remove_entry(root: &mut Value, pointer: &[String]) -> Option<Removed> {
    // Only for settings hooks: [.., "hooks", Event, gi, "hooks", hi]
    let n = pointer.len();
    let hooks_shape = n >= 5 && pointer[n - 2] == "hooks" && pointer[0] == "hooks";
    // What a parent held before its last child went, so a restore puts back the whole group
    // (not a group emptied by this very removal).
    let group_before = if hooks_shape { navigate(root, &pointer[..n - 2]).cloned() } else { None };
    let event_before = if hooks_shape { navigate(root, &pointer[..n - 3]).cloned() } else { None };
    let mut removed = remove_at(root, pointer)?;
    if hooks_shape {
        let group_ptr = &pointer[..n - 2];
        let group_hooks_empty = navigate(root, &pointer[..n - 1]).and_then(Value::as_array).is_some_and(Vec::is_empty);
        if group_hooks_empty
            && let Some(r) = remove_at(root, group_ptr) {
                removed = Removed { value: group_before.unwrap_or(r.value.clone()), ..r };
                let event_ptr = &pointer[..n - 3];
                if navigate(root, event_ptr).and_then(Value::as_array).is_some_and(Vec::is_empty)
                    && let Some(r) = remove_at(root, event_ptr) {
                        removed = Removed { value: event_before.unwrap_or(r.value.clone()), ..r };
                    }
            }
    }
    Some(removed)
}

fn insert_back(root: &mut Value, r: &Removed) -> Result<(), String> {
    let (last, parent_ptr) = r.pointer.split_last().ok_or("nothing to put back")?;
    let parent = navigate_mut(root, parent_ptr).ok_or("the place it came from is gone")?;
    match parent {
        Value::Object(m) => {
            if m.contains_key(last) {
                return Err("something with the same name is already there".into());
            }
            let at = r.index.min(m.len());
            m.shift_insert(at, last.clone(), r.value.clone());
        }
        Value::Array(a) => {
            // Putting back what is already there would run it twice.
            if a.contains(&r.value) {
                return Err("the same entry is already there".into());
            }
            let at = r.index.min(a.len());
            a.insert(at, r.value.clone());
        }
        _ => return Err("the place it came from changed shape".into()),
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    backup_id: String,
    created_ms: u64,
    /// delete | save | create
    action: String,
    kind: String,
    name: String,
    /// path | entry
    unit: String,
    /// path: the file or folder that was backed up
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_dir: Option<bool>,
    /// entry: file, where, what
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    removed: Option<Removed>,
    /// entry: stamp of the file bytes right after the delete (exact undo when unchanged)
    #[serde(skip_serializing_if = "Option::is_none")]
    after_stamp: Option<String>,
    /// entry: the whole file as it was (`file-before`)
    #[serde(skip_serializing_if = "Option::is_none")]
    has_file_before: Option<bool>,
    /// Who made the change: `user` (the app), `assistant` or `mcp`. Absent in older backups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    /// One plain line about what changed (set by `tag_backup`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    summary: Option<String>,
    /// Stamp of the file bytes right after a save or create (exact undo only when unchanged).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saved_stamp: Option<String>,
    /// SHA-256 of the file right after a save or create (how History matches it to this change).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    saved_sha: Option<String>,
    /// A hook turned off from a tool: its entry sits in this backup until it is turned back on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parked: Option<bool>,
    /// An entry delete that has been put back: a second restore is refused (it would duplicate
    /// the entry). A hook that is parked again by a later toggle gets a fresh backup, not this one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    restored: Option<bool>,
    /// A folder created from the Library: (path inside it, SHA-256) of each file it holds, so
    /// History can say "Installed from the Library" for exactly those versions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    files: Option<Vec<(String, String)>>,
    /// A plugin installed or removed from the Library: what Undo needs to put it back as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    lib: Option<LibOp>,
}

/// One Library plugin change (install or uninstall), kept in its backup so History can undo it:
/// undo of an install is an uninstall, undo of an uninstall is an install of the same commit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibOp {
    /// install | uninstall
    pub op: String,
    /// `name@marketplace`
    pub id: String,
    /// `owner/repo` the plugin came from ("" when not known).
    pub repo: String,
    /// The commit that was installed (or that was installed when it was removed); "" when not known.
    pub sha: String,
    /// The checked files' hash, to compare again after a reinstall.
    pub tree_hash: String,
    /// This change has been undone (a second undo is refused).
    #[serde(default)]
    pub undone: bool,
}

/// Record what Undo needs on a Library plugin backup (and tag it, as `tag_backup` does).
pub fn tag_library_op(backups: &Path, id: &str, summary: &str, op: LibOp) {
    tag_backup(backups, id, "library", summary);
    let Ok((mut m, dir)) = read_manifest(backups, id) else { return };
    m.lib = Some(op);
    let _ = write_manifest(&dir, &m);
}

/// The Library plugin change a backup holds, when it holds one.
pub fn library_op(backups: &Path, id: &str) -> Option<LibOp> {
    read_manifest(backups, id).ok().and_then(|(m, _)| m.lib)
}

/// Mark a Library backup as undone (its summary says so, and it can't be undone twice).
pub fn mark_library_undone(backups: &Path, id: &str) {
    let Ok((mut m, dir)) = read_manifest(backups, id) else { return };
    if let Some(l) = m.lib.as_mut() {
        l.undone = true;
    }
    let s = m.summary.clone().unwrap_or_default();
    m.summary = Some(format!("{s} (undone)").chars().take(240).collect());
    let _ = write_manifest(&dir, &m);
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn slug(s: &str) -> String {
    let t: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    t.trim_matches('-').chars().take(40).collect()
}

fn new_backup(backups: &Path, label: &str) -> io::Result<(String, PathBuf)> {
    fs::create_dir_all(backups)?;
    let id = format!("{:013}-{:04}-{}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed) % 10_000, slug(label));
    let dir = backups.join(&id);
    fs::create_dir(&dir)?;
    Ok((id, dir))
}

fn write_manifest(dir: &Path, m: &Manifest) -> io::Result<()> {
    atomic_write(&dir.join("manifest.json"), serde_json::to_string_pretty(m).expect("manifest serialises").as_bytes())
}

fn read_manifest(backups: &Path, id: &str) -> Res<(Manifest, PathBuf)> {
    if id.contains(['/', '\\']) || id.contains("..") || id.is_empty() {
        return refuse("That backup id is not valid.");
    }
    let dir = backups.join(id);
    let bytes = fs::read(dir.join("manifest.json")).map_err(|_| WriteError::Refused("That backup is gone.".into()))?;
    let m: Manifest = serde_json::from_slice(&bytes).map_err(|_| WriteError::Refused("That backup can't be read.".into()))?;
    Ok((m, dir))
}

/// What a copy does with one thing found inside a folder it is copying.
enum CopyKind {
    Dir,
    File,
    /// Left out: a link to something outside the folder (a key, a token file), a link that
    /// leads nowhere, or something that is neither a file nor a folder.
    Skip,
}

/// Decides what copying `p` does. `root` is the canonical folder being copied. A link to a
/// file inside it is copied as that file; a link to a folder is refused; a link out of `root`
/// is never followed. The size check and the checksum use this too, so all three agree.
fn copy_kind(p: &Path, ft: &fs::FileType, root: &Path) -> io::Result<CopyKind> {
    if ft.is_symlink() {
        let Ok(real) = fs::canonicalize(p) else { return Ok(CopyKind::Skip) };
        if !real.starts_with(root) {
            return Ok(CopyKind::Skip);
        }
        if real.is_dir() {
            return Err(io::Error::other("a folder link inside this folder"));
        }
        return Ok(if real.is_file() { CopyKind::File } else { CopyKind::Skip });
    }
    Ok(if ft.is_dir() {
        CopyKind::Dir
    } else if ft.is_file() {
        CopyKind::File
    } else {
        CopyKind::Skip
    })
}

/// Copy a file or folder tree (never following a link out of the tree; see `copy_kind`).
fn copy_tree(src: &Path, dst: &Path, depth: usize) -> io::Result<()> {
    let root = fs::canonicalize(src)?;
    copy_inside(src, dst, depth, &root)
}

fn copy_inside(src: &Path, dst: &Path, depth: usize, root: &Path) -> io::Result<()> {
    let md = fs::metadata(src)?;
    if md.is_dir() {
        if depth > 24 {
            return Err(io::Error::other("folder is nested too deeply"));
        }
        fs::create_dir_all(dst)?;
        for e in fs::read_dir(src)? {
            let e = e?;
            if matches!(copy_kind(&e.path(), &e.file_type()?, root)?, CopyKind::Skip) {
                continue;
            }
            copy_inside(&e.path(), &dst.join(e.file_name()), depth + 1, root)?;
        }
    } else {
        let bytes = fs::read(src)?;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
        io::Write::write_all(&mut f, &bytes)?;
        f.sync_all()?;
        drop(f);
        if let Ok(t) = md.modified()
            && let Ok(f) = fs::OpenOptions::new().write(true).open(dst) {
                let _ = f.set_modified(t);
            }
    }
    Ok(())
}

/// (file count, a hash over names and bytes) of a file or folder.
fn tree_digest(p: &Path) -> io::Result<(u64, u64)> {
    fn walk(p: &Path, rel: &str, files: &mut u64, h: &mut u64, root: &Path) -> io::Result<()> {
        if fs::metadata(p)?.is_dir() {
            let mut names: Vec<_> = fs::read_dir(p)?.collect::<Result<Vec<_>, _>>()?;
            names.sort_by_key(|e| e.file_name());
            for e in names {
                if matches!(copy_kind(&e.path(), &e.file_type()?, root)?, CopyKind::Skip) {
                    continue;
                }
                walk(&e.path(), &format!("{rel}/{}", e.file_name().to_string_lossy()), files, h, root)?;
            }
        } else {
            *files += 1;
            let bytes = fs::read(p)?;
            *h ^= fnv1a64(rel).rotate_left(7) ^ fnv1a64(&String::from_utf8_lossy(&bytes)).rotate_left(13);
            *h = h.wrapping_mul(0x100000001b3).wrapping_add(bytes.len() as u64);
        }
        Ok(())
    }
    let (mut files, mut h) = (0, 0xcbf29ce484222325);
    let root = fs::canonicalize(p)?;
    walk(p, "", &mut files, &mut h, &root)?;
    Ok((files, h))
}

fn payload_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "item".into())
}

// ---------------------------------------------------------------------------
// Delete and undo
// ---------------------------------------------------------------------------

pub fn apply_delete(plan: &DeletePlan, backups: &Path) -> Res<DeleteOutcome> {
    apply_delete_with(plan, backups, false)
}

/// Delete, keeping a backup. With `to_trash` a file or folder also goes to the OS trash (so it
/// is recoverable even if Atlas's backups are wiped); if the trash can't take it, it is removed
/// the plain way (the backup still holds it) and the outcome says so.
pub fn apply_delete_with(plan: &DeletePlan, backups: &Path, to_trash: bool) -> Res<DeleteOutcome> {
    match &plan.unit {
        Unit::Path { path, is_dir } => {
            check_write_allowed(path)?;
            let md = fs::symlink_metadata(path).map_err(|_| WriteError::Refused("It is already gone.".into()))?;
            if md.file_type().is_symlink() {
                return refuse("This is a link to somewhere else, so Atlas leaves it alone.");
            }
            if *is_dir != md.is_dir() {
                return refuse("What is on disk is not what Atlas expected. Refresh the page and try again.");
            }
            let (id, dir) = new_backup(backups, &format!("delete-{}", plan.name))?;
            let payload = dir.join("payload");
            fs::create_dir(&payload)?;
            let copy = payload.join(payload_name(path));
            let result = (|| -> Res<()> {
                copy_tree(path, &copy, 0)?;
                // The copy must match before anything is removed.
                if tree_digest(path)? != tree_digest(&copy)? {
                    return refuse("The backup did not match the original, so nothing was deleted.");
                }
                write_manifest(
                    &dir,
                    &Manifest {
                        version: 1,
                        backup_id: id.clone(),
                        created_ms: now_ms(),
                        action: "delete".into(),
                        kind: plan.kind.as_str().into(),
                        name: plan.name.clone(),
                        unit: "path".into(),
                        path: Some(path.to_string_lossy().into_owned()),
                        is_dir: Some(*is_dir),
                        file: None,
                        removed: None,
                        after_stamp: None,
                        has_file_before: None,
                        ..Default::default()
                    },
                )?;
                Ok(())
            })();
            if let Err(e) = result {
                let _ = fs::remove_dir_all(&dir);
                return Err(e);
            }
            let mut note = None;
            let trashed = to_trash && trash::delete(path).is_ok() && fs::symlink_metadata(path).is_err();
            if to_trash && !trashed {
                note = Some("The computer's trash could not take it, so it was removed. Atlas's backup still has it.".to_string());
            }
            let removal = if trashed {
                Ok(())
            } else if md.is_dir() {
                fs::remove_dir_all(path)
            } else {
                fs::remove_file(path)
            };
            if let Err(e) = removal {
                // Partly removed folders are put back from the backup.
                if md.is_dir() && path.exists() {
                    let _ = restore_path(&copy, path, true);
                }
                let _ = fs::remove_dir_all(&dir);
                return Err(e.into());
            }
            Ok(DeleteOutcome { backup_id: id, name: plan.name.clone(), kind: plan.kind.as_str().into(), note })
        }
        Unit::Entry { file, pointer } => {
            check_write_allowed(file)?;
            let before = fs::read(file).map_err(|_| WriteError::Refused("The file is gone.".into()))?;
            let style = detect_style(&before);
            let mut v = parse_json_bytes(&before).map_err(|e| WriteError::Refused(format!("The file can't be read as JSON ({e}), so nothing was changed.")))?;
            let reformatted = render_json(&v, &style) != before;
            let removed = remove_entry(&mut v, pointer).ok_or_else(|| WriteError::Refused("This entry is already gone.".into()))?;
            let after = render_json(&v, &style);
            let (id, dir) = new_backup(backups, &format!("delete-{}", plan.name))?;
            let result = (|| -> Res<()> {
                fs::write(dir.join("file-before"), &before)?;
                write_manifest(
                    &dir,
                    &Manifest {
                        version: 1,
                        backup_id: id.clone(),
                        created_ms: now_ms(),
                        action: "delete".into(),
                        kind: plan.kind.as_str().into(),
                        name: plan.name.clone(),
                        unit: "entry".into(),
                        path: None,
                        is_dir: None,
                        file: Some(file.to_string_lossy().into_owned()),
                        removed: Some(removed),
                        after_stamp: Some(stamp_of(&after)),
                        has_file_before: Some(true),
                        ..Default::default()
                    },
                )?;
                Ok(())
            })();
            if let Err(e) = result {
                let _ = fs::remove_dir_all(&dir);
                return Err(e);
            }
            // Re-read right before writing: if the file moved on, start again from the fresh copy.
            let now = fs::read(file)?;
            if now != before {
                let _ = fs::remove_dir_all(&dir);
                return refuse("The file changed while Atlas was getting ready. Nothing was deleted; please try again.");
            }
            atomic_write(file, &after)?;
            let check = fs::read(file)?;
            if check != after {
                return refuse("Claude changed the file at the same moment, so the delete may not have stuck. Please check and try again.");
            }
            let note = reformatted.then(|| "The file's spacing was tidied while saving.".to_string());
            Ok(DeleteOutcome { backup_id: id, name: plan.name.clone(), kind: plan.kind.as_str().into(), note })
        }
    }
}

fn restore_path(payload_copy: &Path, dest: &Path, is_dir: bool) -> Res<()> {
    check_write_allowed(dest)?;
    if is_dir {
        let parent = dest.parent().ok_or_else(|| WriteError::Refused("No folder to put it back in.".into()))?;
        fs::create_dir_all(parent)?;
        let tmp = parent.join(format!(".{}.atlas-restore-{}-{}", payload_name(dest), std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed)));
        let r = copy_tree(payload_copy, &tmp, 0).and_then(|_| {
            if tree_digest(payload_copy)? != tree_digest(&tmp)? {
                return Err(io::Error::other("the restored copy did not match"));
            }
            fs::rename(&tmp, dest)
        });
        if let Err(e) = r {
            let _ = fs::remove_dir_all(&tmp);
            return Err(e.into());
        }
    } else {
        let bytes = fs::read(payload_copy)?;
        atomic_write(dest, &bytes)?;
        if let Ok(t) = fs::metadata(payload_copy).and_then(|m| m.modified())
            && let Ok(f) = fs::OpenOptions::new().write(true).open(dest) {
                let _ = f.set_modified(t);
            }
    }
    Ok(())
}

/// Where Atlas may write when it puts something back: the Claude folder, `.claude.json`, and the
/// Claude files of the projects it knows. The target of a restore comes from a manifest file on
/// disk, so it is checked against this before anything is written (a crafted manifest cannot
/// drop a file somewhere else).
#[derive(Debug, Clone)]
pub struct Confine {
    root: PathBuf,
    claude_json: PathBuf,
    projects: Vec<PathBuf>,
}

/// Files a project keeps outside its `.claude` folder that Atlas manages.
const PROJECT_FILES: [&str; 4] = ["CLAUDE.md", "CLAUDE.local.md", ".mcp.json", "AGENTS.md"];

impl Confine {
    pub fn new(root: &Path, claude_json: &Path, projects: impl IntoIterator<Item = PathBuf>) -> Confine {
        Confine { root: root.to_path_buf(), claude_json: claude_json.to_path_buf(), projects: projects.into_iter().collect() }
    }

    /// The folders and files of one discovery run.
    pub fn from_discovery(root: &Path, claude_json: &Path, d: &Discovery) -> Confine {
        Confine::new(root, claude_json, d.snapshot.projects.iter().map(|p| PathBuf::from(&p.path)))
    }

    pub fn allows(&self, target: &Path) -> bool {
        use crate::fsutil::{path_inside, same_place};
        if path_inside(target, &self.root) || same_place(target, &self.claude_json) {
            return true;
        }
        self.projects.iter().any(|p| {
            path_inside(target, &p.join(".claude"))
                || (target.file_name().and_then(|n| n.to_str()).is_some_and(|n| PROJECT_FILES.contains(&n)) && target.parent().is_some_and(|d| same_place(d, p)))
        })
    }

    fn check(&self, target: &Path) -> Res<()> {
        if self.allows(target) {
            Ok(())
        } else {
            refuse("That backup points outside the Claude folder and your projects, so Atlas will not write there.")
        }
    }
}

/// Is the server entry Claude Code's command stored the one Atlas asked for? The fields that
/// decide what runs or where it connects must match: `type` (a command entry without one is
/// `stdio`), `command`, `args`, `url`, `env` and `headers` (missing and `{}`/`[]` are the same).
/// Other fields the command adds on its own are allowed.
pub(crate) fn cli_entry_matches(stored: &Value, asked: &Value) -> bool {
    let kind = |e: &Value| match e.get("type").and_then(Value::as_str) {
        Some(t) => Some(t.to_ascii_lowercase()),
        None => e.get("command").map(|_| "stdio".to_string()),
    };
    let field = |e: &Value, k: &str, empty: Value| e.get(k).filter(|v| !v.is_null()).cloned().unwrap_or(empty);
    let empty_obj = || Value::Object(serde_json::Map::new());
    kind(stored) == kind(asked)
        && ["command", "url"].iter().all(|k| field(stored, k, Value::Null) == field(asked, k, Value::Null))
        && field(stored, "args", Value::Array(vec![])) == field(asked, "args", Value::Array(vec![]))
        && ["env", "headers"].iter().all(|k| field(stored, k, empty_obj()) == field(asked, k, empty_obj()))
}

/// Size and modified time of a file, for the "did it move?" look right before a swap.
pub(crate) type FileSig = Option<(u64, Option<SystemTime>)>;

pub(crate) fn file_sig(p: &Path) -> FileSig {
    let m = fs::metadata(p).ok()?;
    Some((m.len(), m.modified().ok()))
}

/// Replace `file` (a JSON file Claude Code also writes) with `after`, which was made from
/// `before`: back `before` up first, look again right before the swap (size, time and bytes must
/// be what they were when `before` was read, or nothing is written), write atomically, read it
/// back, and when `touched` names the one top-level key that changed, prove every other key is
/// still what `before` had. Returns the backup id.
#[allow(clippy::too_many_arguments)]
fn guarded_swap(file: &Path, backups: &Path, label: &str, kind: &str, name: &str, before: &[u8], sig: FileSig, after: &[u8], touched: Option<&str>) -> Res<String> {
    let (id, dir) = new_backup(backups, label)?;
    let staged = (|| -> Res<()> {
        fs::write(dir.join("file-before"), before)?;
        write_manifest(
            &dir,
            &Manifest {
                version: 1,
                backup_id: id.clone(),
                created_ms: now_ms(),
                action: "restore".into(),
                kind: kind.into(),
                name: name.into(),
                unit: "path".into(),
                path: Some(file.to_string_lossy().into_owned()),
                is_dir: Some(false),
                has_file_before: Some(true),
                ..Default::default()
            },
        )?;
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    if file_sig(file) != sig || fs::read(file).ok().as_deref() != Some(before) {
        let _ = fs::remove_dir_all(&dir);
        return refuse("The file changed while Atlas was getting ready. Nothing was changed; please try again.");
    }
    if let Err(e) = atomic_write(file, after) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e.into());
    }
    let back = fs::read(file)?;
    let intact = match touched {
        None => true,
        Some(key) => match (parse_json_bytes(before).ok(), parse_json_bytes(&back).ok()) {
            (Some(Value::Object(old)), Some(Value::Object(new))) => old.iter().filter(|(k, _)| k.as_str() != key).all(|(k, v)| new.get(k) == Some(v)),
            _ => false,
        },
    };
    if back != after || !intact {
        return refuse("Something changed the file at the same moment, so Atlas cannot be sure the change stuck. Its earlier copy is in Atlas's backups. Please check the file.");
    }
    Ok(id)
}

/// Undo a delete from its backup. Refuses (changing nothing) if something else now sits where
/// the item was, if the target is outside what Atlas manages, or if the entry was already put
/// back (a second restore would run a hook twice).
pub fn restore(backups: &Path, backup_id: &str, confine: &Confine) -> Res<UndoOutcome> {
    let (mut m, dir) = read_manifest(backups, backup_id)?;
    if m.action != "delete" {
        return refuse("Only a delete can be undone this way.");
    }
    let mut new_backup_id = None;
    match m.unit.as_str() {
        "path" => {
            let dest = PathBuf::from(m.path.clone().unwrap_or_default());
            confine.check(&dest)?;
            check_write_allowed(&dest)?;
            if fs::symlink_metadata(&dest).is_ok() {
                return refuse("Something new is already there, so Atlas did not put the old one back over it.");
            }
            let copy = dir.join("payload").join(payload_name(&dest));
            restore_path(&copy, &dest, m.is_dir.unwrap_or(false))?;
        }
        "entry" => {
            let file = PathBuf::from(m.file.clone().unwrap_or_default());
            confine.check(&file)?;
            check_write_allowed(&file)?;
            if m.restored == Some(true) {
                return refuse("That was already put back. Putting it back again would add it twice.");
            }
            let removed = m.removed.clone().ok_or_else(|| WriteError::Refused("That backup is incomplete.".into()))?;
            let sig = file_sig(&file);
            let current = fs::read(&file).map_err(|_| WriteError::Refused("The file is gone, so there is nothing to put it back into.".into()))?;
            let after = if Some(stamp_of(&current)) == m.after_stamp {
                // Untouched since the delete: put the original file back, byte for byte.
                fs::read(dir.join("file-before"))?
            } else {
                // The file moved on: put just this entry back where it was.
                let style = detect_style(&current);
                let mut v = parse_json_bytes(&current).map_err(|e| WriteError::Refused(format!("The file can't be read as JSON ({e}).")))?;
                insert_back(&mut v, &removed).map_err(|e| WriteError::Refused(format!("Could not put it back: {e}. The original file is kept in Atlas's backups.")))?;
                render_json(&v, &style)
            };
            let top = removed.pointer.first().cloned();
            // A safety copy of what is replaced, a last look before the swap and a read-back.
            new_backup_id = Some(guarded_swap(&file, backups, &format!("restore-{}", m.name), &m.kind, &m.name, &current, sig, &after, top.as_deref())?);
            m.restored = Some(true);
            let _ = write_manifest(&dir, &m);
        }
        _ => return refuse("That backup can't be read."),
    }
    Ok(UndoOutcome { name: m.name, kind: m.kind, backup_id: new_backup_id })
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

pub fn validate(kind: ItemKind, language: &str, folder_name: Option<&str>, is_entry: bool, text: &str) -> Vec<Problem> {
    let mut out = Vec::new();
    match language {
        "json" => match serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) {
            Err(e) => out.push(Problem { message: format!("Not valid JSON: {}", json_reason(&e)), line: Some(e.line() as u32) }),
            Ok(v) => {
                if is_entry {
                    match (&v, kind) {
                        (Value::Object(m), ItemKind::McpServer) => {
                            if !m.contains_key("command") && !m.contains_key("url") {
                                out.push(Problem { message: "A server needs a \"command\" or a \"url\".".into(), line: None });
                            }
                        }
                        (Value::Object(m), ItemKind::Hook) => {
                            // A single hook, or a whole group { matcher, hooks: [...] } (new hooks are groups).
                            let ok = match m.get("hooks") {
                                Some(Value::Array(list)) => !list.is_empty() && list.iter().all(|h| h.get("type").is_some_and(Value::is_string)),
                                Some(_) => false,
                                None => m.get("type").is_some_and(Value::is_string),
                            };
                            if !ok {
                                out.push(Problem { message: "A hook needs a \"type\" such as \"command\".".into(), line: None });
                            }
                        }
                        (Value::Object(_), _) => {}
                        _ => out.push(Problem { message: "This needs to be a JSON object { ... }.".into(), line: None }),
                    }
                } else if kind == ItemKind::Settings && !v.is_object() {
                    out.push(Problem { message: "A settings file needs to be a JSON object { ... }.".into(), line: None });
                }
            }
        },
        "markdown" => {
            let t = text.trim_start_matches('\u{feff}');
            let has_fence = t.lines().next().is_some_and(|l| l.trim_end() == "---");
            if has_fence {
                let (fm, _body, closed) = frontmatter::split(t);
                if !closed {
                    out.push(Problem { message: "The frontmatter is not closed: add a --- line after it.".into(), line: Some(1) });
                } else if let Some(y) = fm {
                    match frontmatter::parse_yaml(y) {
                        Err(e) => out.push(Problem { message: format!("The frontmatter can't be read: {e}"), line: None }),
                        Ok(map) => {
                            if kind == ItemKind::Skill
                                && let (Some(Value::String(n)), Some(folder)) = (map.get("name"), folder_name)
                                    && n != folder {
                                        out.push(Problem { message: format!("The skill's name must match its folder (\"{folder}\"), but it says \"{n}\"."), line: None });
                                    }
                        }
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn json_reason(e: &serde_json::Error) -> String {
    let s = e.to_string();
    // "expected value at line 3 column 5" -> keep the words, the line is reported apart.
    s.split(" at line ").next().unwrap_or(&s).to_string() + &format!(" (line {}, column {})", e.line(), e.column())
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/// Back up, write atomically, read back. `expected_stamp` is what the editor
/// loaded; if the thing on disk is different now, `Conflict` (unless `force`).
pub fn apply_save(plan: &SavePlan, text: &str, expected_stamp: &str, force: bool, backups: &Path) -> Res<SaveOutcome> {
    let target = match &plan.unit {
        Unit::Path { path, .. } => path.clone(),
        Unit::Entry { file, .. } => file.clone(),
    };
    check_write_allowed(&target)?;
    let problems = validate(plan.kind, &plan.language, plan.folder_name.as_deref(), matches!(plan.unit, Unit::Entry { .. }), text);
    if let Some(p) = problems.first() {
        return refuse(p.message.clone());
    }
    let current = read_unit_text(&plan.unit).map_err(WriteError::Refused)?;
    if current.stamp != expected_stamp && !force {
        return Err(WriteError::Conflict);
    }
    let (id, dir) = new_backup(backups, &format!("save-{}", plan.name))?;
    let outcome = (|| -> Res<SaveOutcome> {
        match &plan.unit {
            Unit::Path { path, .. } => {
                let old = fs::read(path)?;
                // The stamp was checked a moment ago; check what is about to be backed up too.
                if !force && stamp_of(&old) != expected_stamp {
                    return Err(WriteError::Conflict);
                }
                fs::write(dir.join("file-before"), &old)?;
                let bytes = encode_like(text, current.bom, current.crlf);
                write_manifest(&dir, &save_manifest(&id, plan, path))?;
                // Last look before the swap: the backup must be of exactly what is replaced.
                if fs::read(path)? != old {
                    return Err(WriteError::Conflict);
                }
                atomic_write(path, &bytes)?;
                let back = fs::read(path)?;
                if back != bytes {
                    return refuse("The file on disk is not what Atlas just wrote. Something else changed it at the same time.");
                }
                Ok(SaveOutcome { backup_id: Some(id.clone()), stamp: stamp_of(&back), note: None })
            }
            Unit::Entry { file, pointer } => {
                let before = fs::read(file)?;
                fs::write(dir.join("file-before"), &before)?;
                let style = detect_style(&before);
                let mut root = parse_json_bytes(&before).map_err(|e| WriteError::Refused(format!("The file can't be read as JSON ({e}).")))?;
                let new_entry: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| WriteError::Refused(format!("Not valid JSON: {e}")))?;
                *navigate_mut(&mut root, pointer).ok_or_else(|| WriteError::Refused("This entry is gone.".into()))? = new_entry.clone();
                let after = render_json(&root, &style);
                write_manifest(&dir, &save_manifest(&id, plan, file))?;
                if fs::read(file)? != before {
                    return refuse("The file changed while Atlas was getting ready. Nothing was saved; please try again.");
                }
                atomic_write(file, &after)?;
                if fs::read(file)? != after {
                    return refuse("Claude changed the file at the same moment, so the save may not have stuck. Please check and try again.");
                }
                let shown = serde_json::to_string_pretty(&new_entry).unwrap_or_default();
                Ok(SaveOutcome { backup_id: Some(id.clone()), stamp: stamp_of(shown.as_bytes()), note: None })
            }
        }
    })();
    if outcome.is_err() {
        // Nothing was changed on failure; the half-made backup is only clutter.
        let _ = fs::remove_dir_all(&dir);
    }
    outcome
}

/// What a file looked like when a sheet opened, for the "did it change?" check of
/// `apply_append`: the same stamp `apply_save` uses, or `review_rule::MISSING_STAMP` when the
/// file is not there yet.
pub fn file_stamp(file: &Path) -> String {
    match fs::read(file) {
        Ok(b) => stamp_of(&b),
        Err(_) => crate::review_rule::MISSING_STAMP.to_string(),
    }
}

/// Add `text` under `heading` at the end of a Markdown file (the heading is added when missing)
/// without touching any other byte: the BOM, line endings and every other section stay exactly
/// as they were. `expected_stamp` is the stamp read when the user opened the sheet; a file that
/// moved since gives `Conflict` and nothing is written. A file that does not exist yet (stamp
/// `missing`) is created holding just the heading and the text. Backs the old bytes up first,
/// looks again right before the swap, writes atomically, reads back, and tags the backup so
/// History shows it and Undo (`restore_any`) puts the file back byte for byte (or removes a
/// file this made).
#[allow(clippy::too_many_arguments)]
pub fn apply_append(file: &Path, kind: &str, name: &str, heading: &str, text: &str, expected_stamp: &str, summary: &str, backups: &Path) -> Res<SaveOutcome> {
    check_write_allowed(file)?;
    if text.trim().is_empty() {
        return refuse("There is nothing to add.");
    }
    let before = match fs::read(file) {
        Ok(b) => Some(b),
        Err(e) if e.kind() == io::ErrorKind::NotFound => None,
        Err(_) => return refuse("The file can't be read."),
    };
    if let Some(b) = &before {
        if b.len() as u64 > EDIT_CAP {
            return refuse("This file is too large to edit here.");
        }
        if b.iter().take(8192).any(|&c| c == 0) {
            return refuse("This is a binary file.");
        }
    }
    let now = match &before {
        Some(b) => stamp_of(b),
        None => crate::review_rule::MISSING_STAMP.to_string(),
    };
    if now != expected_stamp {
        return Err(WriteError::Conflict);
    }
    let sig = file_sig(file);
    let after = match &before {
        Some(b) => crate::review_rule::append_under_heading(b, heading, text),
        None => crate::review_rule::new_instructions_text(text).into_bytes(),
    };
    let (id, dir) = new_backup(backups, &format!("save-{name}"))?;
    let outcome = (|| -> Res<SaveOutcome> {
        if let Some(b) = &before {
            fs::write(dir.join("file-before"), b)?;
        }
        write_manifest(
            &dir,
            &Manifest {
                version: 1,
                backup_id: id.clone(),
                created_ms: now_ms(),
                action: if before.is_some() { "save" } else { "create" }.into(),
                kind: kind.into(),
                name: name.into(),
                unit: "path".into(),
                path: Some(file.to_string_lossy().into_owned()),
                is_dir: Some(false),
                has_file_before: Some(before.is_some()),
                ..Default::default()
            },
        )?;
        // Last look: the backup must be of exactly what is replaced.
        if file_sig(file) != sig || fs::read(file).ok() != before {
            return Err(WriteError::Conflict);
        }
        atomic_write(file, &after)?;
        let back = fs::read(file)?;
        if back != after {
            return refuse("The file on disk is not what Atlas just wrote. Something else changed it at the same time.");
        }
        Ok(SaveOutcome { backup_id: Some(id.clone()), stamp: stamp_of(&back), note: None })
    })();
    match &outcome {
        Ok(_) => tag_backup(backups, &id, "user", summary),
        // Nothing was changed on failure; the half-made backup is only clutter.
        Err(_) => {
            let _ = fs::remove_dir_all(&dir);
        }
    }
    outcome
}

fn save_manifest(id: &str, plan: &SavePlan, file: &Path) -> Manifest {
    Manifest {
        version: 1,
        backup_id: id.to_string(),
        created_ms: now_ms(),
        action: "save".into(),
        kind: plan.kind.as_str().into(),
        name: plan.name.clone(),
        unit: "path".into(),
        path: Some(file.to_string_lossy().into_owned()),
        is_dir: Some(false),
        file: None,
        removed: None,
        after_stamp: None,
        has_file_before: Some(true),
        ..Default::default()
    }
}

/// The editor works in LF without a BOM; the file keeps its own line endings and BOM.
pub fn encode_like(text: &str, bom: bool, crlf: bool) -> Vec<u8> {
    let lf = text.replace("\r\n", "\n");
    let body = if crlf { lf.replace('\n', "\r\n") } else { lf };
    let mut out = Vec::with_capacity(body.len() + 3);
    if bom {
        out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    out.extend_from_slice(body.as_bytes());
    out
}

// ---------------------------------------------------------------------------
// Create (the checklist's do-it buttons)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub kind: String,
    pub name: String,
    pub title: String,
    /// Where it will be written.
    pub path: String,
    pub language: String,
    pub text: String,
    pub folder_name: Option<String>,
    /// A line saying where it goes, in plain words.
    pub where_note: String,
}

#[derive(Debug, Clone, Copy)]
pub struct CreateCtx<'a> {
    pub root: &'a Path,
    pub claude_json: &'a Path,
}

pub const CREATE_KINDS: &[&str] = &["instructions", "skill", "agent", "command", "rule", "outputStyle", "hook", "mcpServer"];
pub const HOOK_EVENTS: &[&str] = &["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SessionStart", "Notification", "SubagentStop", "PreCompact"];

fn valid_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 64 && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_') && !n.starts_with(['-', '_'])
}

pub fn create_draft(kind: &str, name: &str, event: Option<&str>, ctx: &CreateCtx) -> Res<Draft> {
    let name = name.trim();
    let needs_name = !matches!(kind, "instructions" | "hook");
    if needs_name && !valid_name(name) {
        return refuse("Use lowercase letters, numbers and dashes for the name, like my-helper.");
    }
    let root = ctx.root;
    let md = "markdown".to_string();
    let d = match kind {
        "instructions" => {
            let p = root.join("CLAUDE.md");
            if p.exists() {
                return refuse("You already have a CLAUDE.md. Open it from Instructions to change it.");
            }
            draft(kind, "CLAUDE.md", "Your instructions for Claude", &p, &md, "# How I like to work\n\nWrite a few lines Claude should always know about you.\n\n- I prefer short, plain answers.\n- Ask me before big changes.\n- My main projects live in ...\n".into(), None, "Claude reads this at the start of every session, in every project.")
        }
        "skill" => {
            let p = root.join("skills").join(name).join("SKILL.md");
            if p.exists() {
                return refuse(format!("You already have a skill called {name}."));
            }
            draft(kind, name, &format!("New skill: {name}"), &p, &md, format!("---\nname: {name}\ndescription: Say in one sentence what this does and when Claude should use it.\n---\n\n# {name}\n\nWrite the steps Claude should follow.\n\n1. First ...\n2. Then ...\n"), Some(name.to_string()), "A folder in your Claude folder, available in every project.")
        }
        "agent" => {
            let p = root.join("agents").join(format!("{name}.md"));
            if p.exists() {
                return refuse(format!("You already have an agent called {name}."));
            }
            draft(kind, name, &format!("New agent: {name}"), &p, &md, format!("---\nname: {name}\ndescription: Say when Claude should hand work to this agent.\n---\n\nYou are a careful helper. Describe how this agent should work, what it checks, and how it reports back.\n"), None, "A file in your Claude folder, available in every project.")
        }
        "command" => {
            let p = root.join("commands").join(format!("{name}.md"));
            if p.exists() {
                return refuse(format!("You already have a command called {name}."));
            }
            draft(kind, name, &format!("New command: /{name}"), &p, &md, "---\ndescription: What this command does\n---\n\nWrite the prompt that runs when you type this command.\n".into(), None, "Type it with a slash in any project.")
        }
        "rule" => {
            let p = root.join("rules").join(format!("{name}.md"));
            if p.exists() {
                return refuse(format!("You already have a rule called {name}."));
            }
            draft(kind, name, &format!("New rule: {name}"), &p, &md, "# A rule for Claude\n\n- Write one clear thing Claude should always do, or never do.\n".into(), None, "A rule file Claude reads in every project.")
        }
        "outputStyle" => {
            let p = root.join("output-styles").join(format!("{name}.md"));
            if p.exists() {
                return refuse(format!("You already have an output style called {name}."));
            }
            draft(kind, name, &format!("New output style: {name}"), &p, &md, format!("---\nname: {name}\ndescription: How Claude should word its replies\n---\n\nKeep replies short and friendly. Lead with the answer, then the reason.\n"), None, "Pick it any time with /output-style.")
        }
        "hook" => {
            let ev = event.unwrap_or("PostToolUse");
            if !HOOK_EVENTS.contains(&ev) {
                return refuse("That is not a hook event Claude knows.");
            }
            let p = root.join("settings.json");
            let text = "{\n  \"matcher\": \"Edit|Write\",\n  \"hooks\": [\n    {\n      \"type\": \"command\",\n      \"command\": \"echo A file was changed\"\n    }\n  ]\n}\n".to_string();
            draft(kind, ev, &format!("New hook on {ev}"), &p, "json", text, None, "Added to your settings.json. It runs the command whenever the event happens.")
        }
        "mcpServer" => {
            let p = ctx.claude_json.to_path_buf();
            if let Ok(bytes) = fs::read(&p)
                && let Ok(v) = parse_json_bytes(&bytes)
                    && v.get("mcpServers").and_then(Value::as_object).is_some_and(|m| m.contains_key(name)) {
                        return refuse(format!("You already have a server called {name}."));
                    }
            draft(kind, name, &format!("Connect MCP server: {name}"), &p, "json", "{\n  \"type\": \"stdio\",\n  \"command\": \"npx\",\n  \"args\": [\"-y\", \"@modelcontextprotocol/server-memory\"]\n}\n".into(), None, "Added to your user servers, available in every project.")
        }
        _ => return refuse("Atlas cannot make that kind of item."),
    };
    Ok(d)
}

#[allow(clippy::too_many_arguments)]
fn draft(kind: &str, name: &str, title: &str, path: &Path, language: &str, text: String, folder: Option<String>, note: &str) -> Draft {
    Draft { kind: kind.into(), name: name.into(), title: title.into(), path: crate::setup::display_path(path), language: language.into(), text, folder_name: folder, where_note: note.into() }
}

fn create_item_kind(kind: &str) -> ItemKind {
    match kind {
        "instructions" => ItemKind::Instructions,
        "skill" => ItemKind::Skill,
        "agent" => ItemKind::Agent,
        "command" => ItemKind::Command,
        "rule" => ItemKind::Rule,
        "outputStyle" => ItemKind::OutputStyle,
        "hook" => ItemKind::Hook,
        _ => ItemKind::McpServer,
    }
}

/// What is wrong with `text` as the content of a new item (empty = fine). Writes nothing.
pub fn validate_draft(kind: &str, name: &str, event: Option<&str>, text: &str, ctx: &CreateCtx) -> Res<Vec<Problem>> {
    let d = create_draft(kind, name, event, ctx)?;
    let is_entry = matches!(kind, "hook" | "mcpServer");
    Ok(validate(create_item_kind(kind), &d.language, d.folder_name.as_deref(), is_entry, text))
}

/// Write a new item from the editor's text. Never replaces an existing file.
pub fn create_apply(kind: &str, name: &str, event: Option<&str>, text: &str, ctx: &CreateCtx, backups: &Path) -> Res<DeleteOutcome> {
    create_apply_with(kind, name, event, text, ctx, backups, None)
}

/// What registers an MCP server through Claude Code's own command (`claude mcp add-json`):
/// given the name and the server's JSON. `Err` means "could not", and the guarded file edit runs
/// instead. `.claude.json` belongs to Claude Code, which rewrites it all the time, so its own
/// command is the safest way in.
pub type McpAdder<'a> = &'a dyn Fn(&str, &Value) -> Result<(), String>;

/// `create_apply`, with an optional `McpAdder` used for `mcpServer` (Atlas backs the file up
/// first, lets the command do the write, then proves the entry is there and no other server
/// changed).
pub fn create_apply_with(kind: &str, name: &str, event: Option<&str>, text: &str, ctx: &CreateCtx, backups: &Path, adder: Option<McpAdder>) -> Res<DeleteOutcome> {
    let d = create_draft(kind, name, event, ctx)?;
    let item_kind = create_item_kind(kind);
    let is_entry = matches!(kind, "hook" | "mcpServer");
    if let Some(p) = validate(item_kind, &d.language, d.folder_name.as_deref(), is_entry, text).first() {
        return refuse(p.message.clone());
    }
    let target = PathBuf::from(&d.path);
    check_write_allowed(&target)?;
    let mut cli_note: Option<String> = None;
    let note = if is_entry {
        let entry: Value = serde_json::from_str(text).map_err(|e| WriteError::Refused(format!("Not valid JSON: {e}")))?;
        let sig = file_sig(&target);
        let before = fs::read(&target).ok();
        let style = before.as_deref().map(detect_style).unwrap_or_default();
        let mut root = match &before {
            Some(b) => parse_json_bytes(b).map_err(|e| WriteError::Refused(format!("The file can't be read as JSON ({e}), so nothing was changed.")))?,
            None => Value::Object(Map::new()),
        };
        let old_servers = root.get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_default();
        let entry_for_cli = entry.clone();
        let obj = root.as_object_mut().ok_or_else(|| WriteError::Refused("The file is not a JSON object.".into()))?;
        if kind == "hook" {
            let ev = event.unwrap_or("PostToolUse");
            let hooks = obj.entry("hooks").or_insert_with(|| Value::Object(Map::new()));
            let arr = hooks.as_object_mut().ok_or_else(|| WriteError::Refused("\"hooks\" in the file is not an object.".into()))?.entry(ev).or_insert_with(|| Value::Array(vec![]));
            arr.as_array_mut().ok_or_else(|| WriteError::Refused("That hook event in the file is not a list.".into()))?.push(entry);
        } else {
            let servers = obj.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
            let m = servers.as_object_mut().ok_or_else(|| WriteError::Refused("\"mcpServers\" in the file is not an object.".into()))?;
            if m.contains_key(name) {
                return refuse(format!("You already have a server called {name}."));
            }
            m.insert(name.to_string(), entry);
        }
        let after = render_json(&root, &style);
        let (id, dir) = new_backup(backups, &format!("create-{kind}-{name}"))?;
        if let Some(b) = &before {
            fs::write(dir.join("file-before"), b)?;
        }
        write_manifest(&dir, &Manifest { version: 1, backup_id: id.clone(), created_ms: now_ms(), action: "create".into(), kind: kind.into(), name: d.name.clone(), unit: "path".into(), path: Some(d.path.clone()), is_dir: Some(false), file: None, removed: None, after_stamp: None, has_file_before: Some(before.is_some()), ..Default::default() })?;
        if file_sig(&target) != sig || fs::read(&target).ok() != before {
            let _ = fs::remove_dir_all(&dir);
            return refuse("The file changed while Atlas was getting ready. Nothing was added; please try again.");
        }
        let mut by_command = false;
        if kind == "mcpServer"
            && let Some(add) = adder
            && add(name, &entry_for_cli).is_ok()
        {
            // The command did the write: prove the entry is there and no other server moved.
            let now = fs::read(&target).ok().and_then(|b| parse_json_bytes(&b).ok());
            let servers = now.as_ref().and_then(|v| v.get("mcpServers")).and_then(Value::as_object);
            // The command may store the entry in its own form (extra or reordered fields): what
            // matters is that the server is there with the same command and args, and that no
            // other server moved.
            let added = servers.and_then(|s| s.get(name));
            let ok = added.is_some_and(|e| cli_entry_matches(e, &entry_for_cli))
                && servers.is_some_and(|s| old_servers.iter().all(|(k, v)| s.get(k) == Some(v)));
            if !ok {
                return refuse("Claude Code's command ran, but the file does not show the new server as expected. Atlas's earlier copy is in its backups. Please check .claude.json.");
            }
            if added != Some(&entry_for_cli) {
                cli_note = Some("Claude Code saved the server in its own form, so the entry may look a little different from what was shown. The command and arguments are the same.".into());
            }
            by_command = true;
        }
        if !by_command {
            // Re-check right before the swap (the command may have run and failed).
            if file_sig(&target) != sig || fs::read(&target).ok() != before {
                let _ = fs::remove_dir_all(&dir);
                return refuse("The file changed while Atlas was getting ready. Nothing was added; please try again.");
            }
            atomic_write(&target, &after)?;
            if fs::read(&target)? != after {
                return refuse("Something else changed the file at the same moment. Please check and try again.");
            }
        }
        id
    } else {
        if target.exists() {
            return refuse("Something is already there, so Atlas did not overwrite it.");
        }
        let (id, dir) = new_backup(backups, &format!("create-{kind}-{name}"))?;
        write_manifest(&dir, &Manifest { version: 1, backup_id: id.clone(), created_ms: now_ms(), action: "create".into(), kind: kind.into(), name: d.name.clone(), unit: "path".into(), path: Some(d.path.clone()), is_dir: Some(false), file: None, removed: None, after_stamp: None, has_file_before: Some(false), ..Default::default() })?;
        atomic_write(&target, &encode_like(text, false, false))?;
        id
    };
    Ok(DeleteOutcome { backup_id: note, name: d.name, kind: kind.into(), note: cli_note })
}

// ---------------------------------------------------------------------------
// Library installs: a skill folder, a single file kept byte for byte, a plugin snapshot
// ---------------------------------------------------------------------------

/// A stamp of a folder's names and bytes (a skill folder as it was installed).
fn folder_stamp(p: &Path) -> io::Result<String> {
    let (files, h) = tree_digest(p)?;
    Ok(format!("dir:{files}:{h:x}"))
}

/// (path inside `root` with `/`, SHA-256) of every file under it, sorted.
fn file_shas(root: &Path) -> io::Result<Vec<(String, String)>> {
    fn walk(dir: &Path, rel: &str, out: &mut Vec<(String, String)>, depth: usize) -> io::Result<()> {
        if depth > 24 {
            return Ok(());
        }
        let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let here = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let ft = e.file_type()?;
            if ft.is_dir() {
                walk(&e.path(), &here, out, depth + 1)?;
            } else if ft.is_file() {
                out.push((here, crate::history::store::sha_hex(&fs::read(e.path())?)));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(root, "", &mut out, 0)?;
    Ok(out)
}

/// Copy a skill folder from `src_dir` (a folder with a SKILL.md) into `<root>/skills/<name>`,
/// byte for byte. Built beside its final place and moved in whole with one rename; nothing
/// existing is replaced. The backup is a `create` of a folder: undoing it (`restore_any`) removes
/// the folder only while it is exactly what was installed.
pub fn install_skill_folder(src_dir: &Path, name: &str, ctx: &CreateCtx, backups: &Path) -> Res<DeleteOutcome> {
    if !valid_name(name) {
        return refuse("Use lowercase letters, numbers and dashes for the name, like my-helper.");
    }
    let skills = ctx.root.join("skills");
    let dest = skills.join(name);
    let taken = |d: &Path| fs::symlink_metadata(d).is_ok();
    if taken(&dest) {
        return refuse(format!("You already have a skill called {name}."));
    }
    check_write_allowed(&dest)?;
    let bytes = fs::read(src_dir.join("SKILL.md")).map_err(|_| WriteError::Refused("This skill has no SKILL.md.".into()))?;
    if std::str::from_utf8(&bytes).is_err() {
        return refuse("SKILL.md is not plain UTF-8 text, so Atlas did not install it.");
    }
    let (files, size) = tree_size(src_dir);
    if files > DUP_MAX_FILES || size > DUP_MAX_BYTES {
        return refuse("This skill is too big to copy here.");
    }
    fs::create_dir_all(&skills)?;
    remove_stale_copies(&skills);
    let tmp = skills.join(format!("{COPY_PREFIX}{}-{}", now_ms(), COUNTER.fetch_add(1, Ordering::Relaxed) % 10_000));
    check_write_allowed(&tmp)?;
    let built = (|| -> Res<(String, Vec<(String, String)>)> {
        copy_tree(src_dir, &tmp, 0)?;
        if tree_digest(src_dir)? != tree_digest(&tmp)? {
            return refuse("The copy did not match the original, so nothing was installed.");
        }
        Ok((folder_stamp(&tmp)?, file_shas(&tmp)?))
    })();
    let (stamp, list) = match built {
        Ok(x) => x,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(e);
        }
    };
    let (id, bdir) = match new_backup(backups, &format!("create-skill-{name}")) {
        Ok(x) => x,
        Err(e) => {
            let _ = fs::remove_dir_all(&tmp);
            return Err(e.into());
        }
    };
    let manifest = Manifest {
        version: 1,
        backup_id: id.clone(),
        created_ms: now_ms(),
        action: "create".into(),
        kind: "skill".into(),
        name: name.into(),
        unit: "path".into(),
        path: Some(dest.to_string_lossy().into_owned()),
        is_dir: Some(true),
        has_file_before: Some(false),
        saved_stamp: Some(stamp),
        files: Some(list),
        ..Default::default()
    };
    let moved = write_manifest(&bdir, &manifest).map_err(WriteError::from).and_then(|_| {
        // Last look: on some systems a rename onto an empty folder would replace it.
        if taken(&dest) {
            return refuse(format!("You already have a skill called {name}."));
        }
        fs::rename(&tmp, &dest).map_err(WriteError::from)
    });
    if let Err(e) = moved {
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&bdir);
        return Err(e);
    }
    Ok(DeleteOutcome { backup_id: id, name: name.into(), kind: "skill".into(), note: None })
}

/// Write one agent, command or output style exactly as it is (the bytes are not tidied: no line
/// ending or BOM change). Only text is accepted. Never replaces anything.
pub fn create_apply_bytes(kind: &str, name: &str, bytes: &[u8], ctx: &CreateCtx, backups: &Path) -> Res<DeleteOutcome> {
    if !matches!(kind, "agent" | "command" | "outputStyle") {
        return refuse("Atlas copies only agents, commands and output styles this way.");
    }
    let d = create_draft(kind, name, None, ctx)?;
    if std::str::from_utf8(bytes).is_err() {
        return refuse("That file is not plain UTF-8 text, so Atlas did not install it.");
    }
    let target = PathBuf::from(&d.path);
    check_write_allowed(&target)?;
    if fs::symlink_metadata(&target).is_ok() {
        return refuse("Something is already there, so Atlas did not overwrite it.");
    }
    let (id, dir) = new_backup(backups, &format!("create-{kind}-{name}"))?;
    let made = write_manifest(&dir, &Manifest { version: 1, backup_id: id.clone(), created_ms: now_ms(), action: "create".into(), kind: kind.into(), name: d.name.clone(), unit: "path".into(), path: Some(d.path.clone()), is_dir: Some(false), has_file_before: Some(false), ..Default::default() })
        .and_then(|_| atomic_write(&target, bytes));
    if let Err(e) = made {
        let _ = fs::remove_dir_all(&dir);
        return Err(e.into());
    }
    Ok(DeleteOutcome { backup_id: id, name: d.name, kind: kind.into(), note: None })
}

/// A backup of files another program is about to change (Claude Code's plugin command): the
/// primary file (`file-before`) and any others (under `payload/<name>`). Not restorable by
/// `restore_any` (action `library`): a plugin is undone by uninstalling it. Returns the id.
pub fn snapshot_files(backups: &Path, label: &str, kind: &str, name: &str, primary: &Path, others: &[(&str, &Path)]) -> io::Result<String> {
    let (id, dir) = new_backup(backups, label)?;
    let made = (|| -> io::Result<()> {
        let before = fs::read(primary).ok();
        if let Some(b) = &before {
            fs::write(dir.join("file-before"), b)?;
        }
        for (n, p) in others {
            if let Ok(b) = fs::read(p) {
                let payload = dir.join("payload");
                fs::create_dir_all(&payload)?;
                fs::write(payload.join(n), b)?;
            }
        }
        write_manifest(&dir, &Manifest { version: 1, backup_id: id.clone(), created_ms: now_ms(), action: "library".into(), kind: kind.into(), name: name.into(), unit: "path".into(), path: Some(primary.to_string_lossy().into_owned()), is_dir: Some(false), has_file_before: Some(before.is_some()), ..Default::default() })
    })();
    if let Err(e) = made {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(id)
}

/// Remove a backup made for a change that did not happen.
pub fn drop_backup(backups: &Path, id: &str) {
    if !id.is_empty() && !id.contains(['/', '\\']) && !id.contains("..") {
        let _ = fs::remove_dir_all(backups.join(id));
    }
}

/// Which backups exist, newest first (for a future History screen and tests).
pub fn list_backups(backups: &Path) -> Vec<(String, String, String, String)> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(backups) else { return out };
    for e in rd.flatten() {
        let id = e.file_name().to_string_lossy().into_owned();
        if let Ok((m, _)) = read_manifest(backups, &id) {
            out.push((id, m.action, m.kind, m.name));
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}

// ---------------------------------------------------------------------------
// Who made a change, a wider restore, and one-key edits of shared JSON files
// ---------------------------------------------------------------------------

/// One backup as the MCP server and the History screens list it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub backup_id: String,
    pub created_ms: u64,
    /// delete | save | create | restore
    pub action: String,
    pub kind: String,
    pub name: String,
    /// user | assistant | mcp (`user` for backups made before provenance was recorded).
    pub source: String,
    pub summary: Option<String>,
    /// The file or folder the change touched.
    pub path: Option<String>,
    /// `restore_any` can put this back.
    pub can_restore: bool,
    /// A hook that was turned off and is waiting here to be turned back on.
    pub parked: bool,
}

/// Record who made a backup's change and a plain line about it, and (for a save, create or
/// restore) the stamp of the file right after, so a later restore knows nothing moved on.
/// Best effort: a backup that cannot be tagged is still a valid backup.
pub fn tag_backup(backups: &Path, id: &str, source: &str, summary: &str) {
    let Ok((mut m, dir)) = read_manifest(backups, id) else { return };
    m.source = Some(source.to_string());
    m.summary = Some(summary.chars().take(240).collect());
    // The file as it is right after the change: a save, create or restore of a file, or a delete
    // of one entry inside a JSON file (the file itself stays).
    let after = match (m.action.as_str(), m.unit.as_str()) {
        ("save" | "create" | "restore" | "library", _) => m.path.clone(),
        ("delete", "entry") => m.file.clone(),
        _ => None,
    };
    if let Some(p) = after
        && let Ok(bytes) = fs::read(&p)
    {
        if m.action != "delete" && m.action != "library" {
            m.saved_stamp = Some(stamp_of(&bytes));
        }
        m.saved_sha = Some(crate::history::store::sha_hex(&bytes));
    }
    let _ = write_manifest(&dir, &m);
}

/// The files a backup holds, as (name, bytes): the saved copy of the file and everything under
/// `payload`. Used to check what a restore would bring back before it does. Anything that can't
/// be read plainly (a link, a huge file, too many files) comes back under a name that is not
/// markdown, so the caller treats it as "might be code".
pub fn backup_files(backups: &Path, backup_id: &str) -> Vec<(String, Vec<u8>)> {
    const MAX_FILES: usize = 400;
    const MAX_BYTES: u64 = 2 * 1024 * 1024;
    fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, Vec<u8>)>, depth: usize) {
        let Ok(rd) = fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            let rel = p.strip_prefix(base).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default();
            let Ok(md) = fs::symlink_metadata(&p) else { continue };
            if out.len() >= MAX_FILES || depth > 12 || md.file_type().is_symlink() || (md.is_file() && md.len() > MAX_BYTES) {
                out.push((format!("{rel}.unreadable"), Vec::new()));
            } else if md.is_dir() {
                walk(base, &p, out, depth + 1);
            } else if let Ok(b) = fs::read(&p) {
                out.push((rel, b));
            }
        }
    }
    let Ok((m, dir)) = read_manifest(backups, backup_id) else { return vec![("manifest.unreadable".into(), Vec::new())] };
    let mut out = Vec::new();
    if let Ok(b) = fs::read(dir.join("file-before")) {
        let name = m.path.as_deref().or(m.file.as_deref()).map(|p| payload_name(Path::new(p))).unwrap_or_else(|| "file-before".into());
        out.push((name, b));
    }
    let payload = dir.join("payload");
    walk(&payload, &payload, &mut out, 0);
    out
}

/// Backups, newest first, at most `limit`.
pub fn list_backups_detailed(backups: &Path, limit: usize) -> Vec<BackupInfo> {
    let mut ids: Vec<String> = fs::read_dir(backups).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    ids.sort_by(|a, b| b.cmp(a));
    let mut out = Vec::new();
    for id in ids {
        if out.len() >= limit {
            break;
        }
        let Ok((m, _)) = read_manifest(backups, &id) else { continue };
        let can_restore = match m.action.as_str() {
            "delete" => true,
            "save" | "create" | "restore" => m.saved_stamp.is_some(),
            // A Library plugin install or removal is undone through Claude Code's own command
            // (`library::install::undo_plugin_backup`), once.
            "library" => m.lib.as_ref().is_some_and(|l| !l.undone),
            _ => false,
        };
        out.push(BackupInfo {
            backup_id: m.backup_id,
            created_ms: m.created_ms,
            action: m.action,
            kind: m.kind,
            name: m.name,
            source: m.source.unwrap_or_else(|| "user".into()),
            summary: m.summary,
            path: m.path.or(m.file),
            can_restore,
            parked: m.parked.unwrap_or(false),
        });
    }
    out
}

/// Undo any backup: a delete is put back (as `restore` does); a save, create or restore is
/// reverted to the file as it was before, but only while the file is still exactly what that
/// change left (anything newer is never overwritten). What is replaced is backed up first, so
/// the undo can itself be undone.
pub fn restore_any(backups: &Path, backup_id: &str, confine: &Confine) -> Res<UndoOutcome> {
    restore_any_with(backups, backup_id, confine, false)
}

/// `restore_any`; `to_trash` also sends a folder that an undo removes to the OS trash (the
/// backup still holds it, so the undo can be undone).
pub fn restore_any_with(backups: &Path, backup_id: &str, confine: &Confine, to_trash: bool) -> Res<UndoOutcome> {
    let (m, dir) = read_manifest(backups, backup_id)?;
    match m.action.as_str() {
        "delete" => restore(backups, backup_id, confine),
        // A folder made from the Library: removed only while it is exactly what was installed.
        // The removal is a delete with a backup of its own, so undoing this undo puts it back.
        "create" if m.is_dir == Some(true) => {
            let path = PathBuf::from(m.path.clone().unwrap_or_default());
            confine.check(&path)?;
            check_write_allowed(&path)?;
            let Some(saved) = m.saved_stamp.clone() else {
                return refuse("That backup is too old to undo safely. Its saved copy is still in Atlas's backups folder.");
            };
            let md = fs::symlink_metadata(&path).map_err(|_| WriteError::Refused("That folder is already gone.".into()))?;
            if md.file_type().is_symlink() || !md.is_dir() {
                return refuse("What is on disk is not what Atlas installed, so it was left alone.");
            }
            if folder_stamp(&path).ok().as_deref() != Some(saved.as_str()) {
                return refuse("That folder has changed since it was installed, so Atlas did not remove it.");
            }
            let plan = DeletePlan { id: String::new(), name: m.name.clone(), kind: create_item_kind(&m.kind), unit: Unit::Path { path, is_dir: true } };
            let out = apply_delete_with(&plan, backups, to_trash)?;
            tag_backup(backups, &out.backup_id, "library", &format!("Removed {} (undo of an install)", m.name));
            Ok(UndoOutcome { name: m.name, kind: m.kind, backup_id: Some(out.backup_id) })
        }
        "save" | "create" | "restore" => {
            let path = PathBuf::from(m.path.clone().unwrap_or_default());
            confine.check(&path)?;
            check_write_allowed(&path)?;
            let Some(saved) = m.saved_stamp.clone() else {
                return refuse("That backup is too old to undo safely. Its saved copy is still in Atlas's backups folder.");
            };
            let current = fs::read(&path).ok();
            match &current {
                Some(c) if stamp_of(c) == saved => {}
                Some(_) => return refuse("That file has changed since, so Atlas did not put the older version back over it."),
                None => return refuse("That file is already gone."),
            }
            let had_before = m.has_file_before.unwrap_or(false);
            let before = if had_before { Some(fs::read(dir.join("file-before")).map_err(|_| WriteError::Refused("The saved copy is missing.".into()))?) } else { None };
            // Back up what is about to be replaced, so this undo can be undone.
            let (nid, ndir) = new_backup(backups, &format!("restore-{}", m.name))?;
            let result = (|| -> Res<()> {
                fs::write(ndir.join("file-before"), current.as_deref().unwrap_or_default())?;
                write_manifest(
                    &ndir,
                    &Manifest {
                        version: 1,
                        backup_id: nid.clone(),
                        created_ms: now_ms(),
                        action: "restore".into(),
                        kind: m.kind.clone(),
                        name: m.name.clone(),
                        unit: "path".into(),
                        path: Some(path.to_string_lossy().into_owned()),
                        is_dir: Some(false),
                        has_file_before: Some(true),
                        ..Default::default()
                    },
                )?;
                // Last look: if the file moved since it was read, write nothing.
                if fs::read(&path).ok() != current {
                    return refuse("That file changed while Atlas was getting ready. Nothing was changed; please try again.");
                }
                match &before {
                    Some(bytes) => atomic_write(&path, bytes)?,
                    None => {
                        fs::remove_file(&path)?;
                        // A skill made by Atlas leaves an empty folder behind: remove it if it is empty.
                        if m.kind == "skill"
                            && let Some(parent) = path.parent()
                        {
                            let _ = fs::remove_dir(parent);
                        }
                    }
                }
                Ok(())
            })();
            if let Err(e) = result {
                let _ = fs::remove_dir_all(&ndir);
                return Err(e);
            }
            Ok(UndoOutcome { name: m.name, kind: m.kind, backup_id: Some(nid) })
        }
        "library" => refuse("A plugin from the Library is undone through Claude Code's own command, not by putting files back."),
        _ => refuse("That backup can't be undone this way."),
    }
}

/// Change a few top-level keys of a big JSON file that Claude Code also writes (`.claude.json`),
/// touching nothing else: back the file up, make the edit on a parsed copy, look again right
/// before the swap (abort if the file moved on), write atomically, read it back, and prove every
/// other top-level key is the same value as before. `touched` names the top-level keys `edit`
/// may change. Returns the backup id. A missing file counts as `{}`.
pub fn edit_json_keys(file: &Path, backups: &Path, label: &str, kind: &str, name: &str, touched: &[&str], edit: impl FnOnce(&mut Value) -> Res<()>) -> Res<String> {
    check_write_allowed(file)?;
    let sig = file_sig(file);
    let before = fs::read(file).ok();
    let style = before.as_deref().map(detect_style).unwrap_or_default();
    let mut root = match &before {
        Some(b) => parse_json_bytes(b).map_err(|e| WriteError::Refused(format!("The file can't be read as JSON ({e}), so nothing was changed.")))?,
        None => Value::Object(Map::new()),
    };
    if !root.is_object() {
        return refuse("The file is not a JSON object, so nothing was changed.");
    }
    let original = root.clone();
    edit(&mut root)?;
    // Guard against an edit that strayed: every key outside `touched` must be exactly as it was.
    let (Some(old), Some(new)) = (original.as_object(), root.as_object()) else { return refuse("The file is not a JSON object.") };
    for (k, v) in old {
        if !touched.contains(&k.as_str()) && new.get(k) != Some(v) {
            return refuse("Atlas stopped: the edit would have changed something it should not touch, so nothing was written.");
        }
    }
    for k in new.keys() {
        if !touched.contains(&k.as_str()) && !old.contains_key(k) {
            return refuse("Atlas stopped: the edit would have added something it should not touch, so nothing was written.");
        }
    }
    let after = render_json(&root, &style);
    let (id, dir) = new_backup(backups, label)?;
    let staged = (|| -> Res<()> {
        if let Some(b) = &before {
            fs::write(dir.join("file-before"), b)?;
        }
        write_manifest(
            &dir,
            &Manifest {
                version: 1,
                backup_id: id.clone(),
                created_ms: now_ms(),
                action: "save".into(),
                kind: kind.into(),
                name: name.into(),
                unit: "path".into(),
                path: Some(file.to_string_lossy().into_owned()),
                is_dir: Some(false),
                has_file_before: Some(before.is_some()),
                ..Default::default()
            },
        )?;
        Ok(())
    })();
    if let Err(e) = staged {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    // Last look: Claude Code rewrites this file all the time. If it moved, start over, never merge.
    if file_sig(file) != sig || fs::read(file).ok() != before {
        let _ = fs::remove_dir_all(&dir);
        return refuse("Claude Code changed the file while Atlas was getting ready. Nothing was changed; please try again.");
    }
    if let Err(e) = atomic_write(file, &after) {
        let _ = fs::remove_dir_all(&dir);
        return Err(e.into());
    }
    let back = fs::read(file)?;
    let intact = parse_json_bytes(&back).ok().and_then(|v| v.as_object().cloned()).is_some_and(|m| old.iter().filter(|(k, _)| !touched.contains(&k.as_str())).all(|(k, v)| m.get(k) == Some(v)));
    if back != after || !intact {
        return refuse("Something changed the file at the same moment, so Atlas cannot be sure the change stuck. Please check it.");
    }
    tag_backup(backups, &id, "user", "");
    Ok(id)
}

/// One change made by someone other than the user at the keyboard, for History to attribute.
#[derive(Debug, Clone)]
pub struct Provenance {
    pub created_ms: u64,
    /// delete | save | create | restore
    pub action: String,
    pub source: String,
    /// The file the change touched (slash or backslash as stored).
    pub path: String,
    /// SHA-256 of the file after a save, create or restore.
    pub saved_sha: Option<String>,
    /// A folder created from the Library: each file in it (full path) and its SHA-256.
    pub files: Vec<(String, String)>,
    /// The plain sentence a Library change was tagged with ("Installed x from the Library").
    pub summary: Option<String>,
    /// For a Library plugin change: (plugin id, `install` or `uninstall`).
    pub plugin_op: Option<(String, String)>,
}

/// Changes made by the MCP server or the assistant since `since_ms`, newest first.
pub fn provenance(backups: &Path, since_ms: u64) -> Vec<Provenance> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(backups) else { return out };
    for e in rd.flatten() {
        let id = e.file_name().to_string_lossy().into_owned();
        let Ok((m, _)) = read_manifest(backups, &id) else { continue };
        let source = m.source.clone().unwrap_or_default();
        if source.is_empty() || source == "user" || m.created_ms < since_ms {
            continue;
        }
        let Some(path) = m.path.clone().or(m.file.clone()) else { continue };
        let files = m.files.iter().flatten().map(|(rel, sha)| (format!("{}/{rel}", path.trim_end_matches(['/', '\\'])), sha.clone())).collect();
        let plugin_op = m.lib.as_ref().filter(|_| m.kind == "plugin").map(|l| (l.id.clone(), l.op.clone()));
        out.push(Provenance { created_ms: m.created_ms, action: m.action, source, path, saved_sha: m.saved_sha, files, summary: m.summary, plugin_op });
    }
    out.sort_by_key(|p| std::cmp::Reverse(p.created_ms));
    out
}

/// Mark a delete backup as a parked hook (or clear the mark once it is back).
pub fn set_parked(backups: &Path, id: &str, parked: bool) {
    let Ok((mut m, dir)) = read_manifest(backups, id) else { return };
    m.parked = parked.then_some(true);
    let _ = write_manifest(&dir, &m);
}

/// Hooks that were turned off and can be turned back on, newest first.
pub fn list_parked(backups: &Path) -> Vec<BackupInfo> {
    list_backups_detailed(backups, usize::MAX).into_iter().filter(|b| b.parked && b.action == "delete").collect()
}

/// A kind of item Atlas renames: whether `id` can be, and why not.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub kind: String,
    pub old_name: String,
    pub new_name: String,
    /// Where the renamed item now lives.
    pub new_path: String,
    /// The backup of the old one (Undo puts the old one back; the new one is then removed by hand).
    pub backup_id: String,
}

/// Rename a skill (user folder only), agent, command, rule or output style: the new one is
/// written first and never over anything, then the old one is deleted with a backup. If the
/// delete fails, the new copy is removed again, so a failure leaves things as they were.
pub fn rename_item(d: &Discovery, id: &str, new_name: &str, root: &Path, backups: &Path) -> Res<RenameOutcome> {
    let (item, src, _) = d.plan_unit(id)?;
    let new_name = new_name.trim();
    if !valid_name(new_name) {
        return refuse("Use lowercase letters, numbers and dashes for the name, like my-helper.");
    }
    if new_name == item.name {
        return refuse("That is already its name.");
    }
    let plan = d.delete_plan(id)?;
    match (item.kind, &src) {
        (ItemKind::Skill, SourceRef::File { .. }) => {
            if item.scope != crate::setup::ScopeKind::User {
                return refuse("Atlas renames skills in your own Claude folder only.");
            }
            let dup = d.duplicate_skill(id, new_name, root)?;
            match apply_delete(&plan, backups) {
                Ok(o) => Ok(RenameOutcome { kind: "skill".into(), old_name: item.name, new_name: dup.name, new_path: dup.path, backup_id: o.backup_id }),
                Err(e) => {
                    if let Some(dir) = Path::new(&dup.path).parent() {
                        let _ = fs::remove_dir_all(dir);
                    }
                    Err(e)
                }
            }
        }
        (ItemKind::Agent | ItemKind::Command | ItemKind::Rule | ItemKind::OutputStyle, SourceRef::File { path }) => {
            let dir = path.parent().ok_or_else(|| WriteError::Refused("This has no folder.".into()))?;
            let ext = path.extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "md".into());
            let target = dir.join(format!("{new_name}.{ext}"));
            check_write_allowed(&target)?;
            if fs::symlink_metadata(&target).is_ok() {
                return refuse(format!("You already have something called {new_name}."));
            }
            let text = String::from_utf8(fs::read(path)?).map_err(|_| WriteError::Refused("That file is not plain UTF-8 text, so Atlas cannot rename it safely.".into()))?;
            let new_text = if matches!(item.kind, ItemKind::Agent | ItemKind::OutputStyle) { with_skill_name(&text, new_name) } else { text };
            atomic_write(&target, new_text.as_bytes())?;
            match apply_delete(&plan, backups) {
                Ok(o) => Ok(RenameOutcome { kind: item.kind.as_str().into(), old_name: item.name, new_name: new_name.into(), new_path: crate::setup::display_path(&target), backup_id: o.backup_id }),
                Err(e) => {
                    let _ = fs::remove_file(&target);
                    Err(e)
                }
            }
        }
        _ => refuse("Atlas can rename skills, agents, commands, rules and output styles."),
    }
}

#[cfg(test)]
mod cli_entry_tests {
    use super::cli_entry_matches;
    use serde_json::json;

    #[test]
    fn a_command_entry_may_gain_fields_but_not_change_what_runs() {
        let asked = json!({"command": "node", "args": ["x.js"]});
        assert!(cli_entry_matches(&json!({"type": "stdio", "command": "node", "args": ["x.js"], "env": {}}), &asked));
        assert!(!cli_entry_matches(&json!({"command": "node", "args": ["y.js"]}), &asked));
        assert!(!cli_entry_matches(&json!({"command": "node", "args": ["x.js"], "env": {"A": "1"}}), &asked));
        assert!(!cli_entry_matches(&json!({"type": "http", "command": "node", "args": ["x.js"]}), &asked));
    }

    #[test]
    fn http_and_sse_entries_are_compared_on_type_url_env_and_headers() {
        let asked = json!({"type": "http", "url": "https://a.example/mcp", "env": {}});
        assert!(cli_entry_matches(&json!({"type": "http", "url": "https://a.example/mcp"}), &asked), "a missing env equals an empty one");
        assert!(!cli_entry_matches(&json!({"type": "http", "url": "https://evil.example/mcp"}), &asked));
        assert!(!cli_entry_matches(&json!({"type": "sse", "url": "https://a.example/mcp"}), &asked));
        assert!(!cli_entry_matches(&json!({"type": "http", "url": "https://a.example/mcp", "env": {"K": "v"}}), &asked));
        assert!(!cli_entry_matches(&json!({"type": "http", "url": "https://a.example/mcp", "headers": {"Authorization": "x"}}), &asked));
        assert!(!cli_entry_matches(&json!({}), &asked));
    }
}
