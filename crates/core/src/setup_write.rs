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
        let (item, src, cap) = self.plan_unit(id)?;
        if let Some(why) = cap.locked {
            return refuse(why);
        }
        if !cap.editable {
            return refuse("Atlas does not edit this kind of item.");
        }
        let (unit, language, folder_name) = match &src {
            SourceRef::File { path } => {
                let folder = (item.kind == ItemKind::Skill).then(|| path.parent().and_then(Path::file_name).map(|n| n.to_string_lossy().into_owned())).flatten();
                (Unit::Path { path: path.clone(), is_dir: false }, language_of_path(path).to_string(), folder)
            }
            SourceRef::JsonEntry { file, pointer } => (Unit::Entry { file: file.clone(), pointer: pointer.clone() }, "json".to_string(), None),
            SourceRef::Text(_) => return refuse("There is no file on this computer to edit."),
        };
        Ok(SavePlan { id: id.to_string(), name: item.name.clone(), kind: item.kind, unit, folder_name, language })
    }

    /// The raw (unmasked) text for the editor. Only for items Atlas may edit.
    pub fn read_raw(&self, id: &str, reveal: bool) -> Res<RawEdit> {
        let plan = self.save_plan(id)?;
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
        let plan = self.save_plan(id)?;
        Ok(validate(plan.kind, &plan.language, plan.folder_name.as_deref(), matches!(plan.unit, Unit::Entry { .. }), text))
    }
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
    let mut removed = remove_at(root, pointer)?;
    // Only for settings hooks: [.., "hooks", Event, gi, "hooks", hi]
    let n = pointer.len();
    if n >= 5 && pointer[n - 2] == "hooks" && pointer[0] == "hooks" {
        let group_ptr = &pointer[..n - 2];
        let group_hooks_empty = navigate(root, &pointer[..n - 1]).and_then(Value::as_array).is_some_and(Vec::is_empty);
        if group_hooks_empty {
            if let Some(r) = remove_at(root, group_ptr) {
                removed = r;
                let event_ptr = &pointer[..n - 3];
                if navigate(root, event_ptr).and_then(Value::as_array).is_some_and(Vec::is_empty) {
                    if let Some(r) = remove_at(root, event_ptr) {
                        removed = r;
                    }
                }
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// Copy a file or folder tree. Symlinks are followed for files and skipped for folders.
fn copy_tree(src: &Path, dst: &Path, depth: usize) -> io::Result<()> {
    let md = fs::metadata(src)?;
    if md.is_dir() {
        if depth > 24 {
            return Err(io::Error::other("folder is nested too deeply"));
        }
        fs::create_dir_all(dst)?;
        for e in fs::read_dir(src)? {
            let e = e?;
            let ft = e.file_type()?;
            if ft.is_symlink() && fs::metadata(e.path()).is_ok_and(|m| m.is_dir()) {
                return Err(io::Error::other("a folder link inside this folder"));
            }
            copy_tree(&e.path(), &dst.join(e.file_name()), depth + 1)?;
        }
    } else {
        let bytes = fs::read(src)?;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(dst)?;
        io::Write::write_all(&mut f, &bytes)?;
        f.sync_all()?;
        drop(f);
        if let Ok(t) = md.modified() {
            if let Ok(f) = fs::OpenOptions::new().write(true).open(dst) {
                let _ = f.set_modified(t);
            }
        }
    }
    Ok(())
}

/// (file count, a hash over names and bytes) of a file or folder.
fn tree_digest(p: &Path) -> io::Result<(u64, u64)> {
    fn walk(p: &Path, rel: &str, files: &mut u64, h: &mut u64) -> io::Result<()> {
        if fs::metadata(p)?.is_dir() {
            let mut names: Vec<_> = fs::read_dir(p)?.collect::<Result<Vec<_>, _>>()?;
            names.sort_by_key(|e| e.file_name());
            for e in names {
                walk(&e.path(), &format!("{rel}/{}", e.file_name().to_string_lossy()), files, h)?;
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
    walk(p, "", &mut files, &mut h)?;
    Ok((files, h))
}

fn payload_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "item".into())
}

// ---------------------------------------------------------------------------
// Delete and undo
// ---------------------------------------------------------------------------

pub fn apply_delete(plan: &DeletePlan, backups: &Path) -> Res<DeleteOutcome> {
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
                    },
                )?;
                Ok(())
            })();
            if let Err(e) = result {
                let _ = fs::remove_dir_all(&dir);
                return Err(e);
            }
            let removal = if md.is_dir() { fs::remove_dir_all(path) } else { fs::remove_file(path) };
            if let Err(e) = removal {
                // Partly removed folders are put back from the backup.
                if md.is_dir() && path.exists() {
                    let _ = restore_path(&copy, path, true);
                }
                let _ = fs::remove_dir_all(&dir);
                return Err(e.into());
            }
            Ok(DeleteOutcome { backup_id: id, name: plan.name.clone(), kind: plan.kind.as_str().into(), note: None })
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
        if let Ok(t) = fs::metadata(payload_copy).and_then(|m| m.modified()) {
            if let Ok(f) = fs::OpenOptions::new().write(true).open(dest) {
                let _ = f.set_modified(t);
            }
        }
    }
    Ok(())
}

/// Undo a delete from its backup. Refuses (changing nothing) if something else
/// now sits where the item was.
pub fn restore(backups: &Path, backup_id: &str) -> Res<UndoOutcome> {
    let (m, dir) = read_manifest(backups, backup_id)?;
    if m.action != "delete" {
        return refuse("Only a delete can be undone this way.");
    }
    match m.unit.as_str() {
        "path" => {
            let dest = PathBuf::from(m.path.clone().unwrap_or_default());
            check_write_allowed(&dest)?;
            if fs::symlink_metadata(&dest).is_ok() {
                return refuse("Something new is already there, so Atlas did not put the old one back over it.");
            }
            let copy = dir.join("payload").join(payload_name(&dest));
            restore_path(&copy, &dest, m.is_dir.unwrap_or(false))?;
        }
        "entry" => {
            let file = PathBuf::from(m.file.clone().unwrap_or_default());
            check_write_allowed(&file)?;
            let removed = m.removed.clone().ok_or_else(|| WriteError::Refused("That backup is incomplete.".into()))?;
            let current = fs::read(&file).map_err(|_| WriteError::Refused("The file is gone, so there is nothing to put it back into.".into()))?;
            if Some(stamp_of(&current)) == m.after_stamp {
                // Untouched since the delete: put the original file back, byte for byte.
                let before = fs::read(dir.join("file-before"))?;
                atomic_write(&file, &before)?;
            } else {
                // The file moved on: put just this entry back where it was.
                let style = detect_style(&current);
                let mut v = parse_json_bytes(&current).map_err(|e| WriteError::Refused(format!("The file can't be read as JSON ({e}).")))?;
                insert_back(&mut v, &removed).map_err(|e| WriteError::Refused(format!("Could not put it back: {e}. The original file is kept in Atlas's backups.")))?;
                atomic_write(&file, &render_json(&v, &style))?;
            }
        }
        _ => return refuse("That backup can't be read."),
    }
    Ok(UndoOutcome { name: m.name, kind: m.kind })
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
                            if kind == ItemKind::Skill {
                                if let (Some(Value::String(n)), Some(folder)) = (map.get("name"), folder_name) {
                                    if n != folder {
                                        out.push(Problem { message: format!("The skill's name must match its folder (\"{folder}\"), but it says \"{n}\"."), line: None });
                                    }
                                }
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
                fs::write(dir.join("file-before"), &old)?;
                let bytes = encode_like(text, current.bom, current.crlf);
                write_manifest(&dir, &save_manifest(&id, plan, path))?;
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
            if let Ok(bytes) = fs::read(&p) {
                if let Ok(v) = parse_json_bytes(&bytes) {
                    if v.get("mcpServers").and_then(Value::as_object).is_some_and(|m| m.contains_key(name)) {
                        return refuse(format!("You already have a server called {name}."));
                    }
                }
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
    let d = create_draft(kind, name, event, ctx)?;
    let item_kind = create_item_kind(kind);
    let is_entry = matches!(kind, "hook" | "mcpServer");
    if let Some(p) = validate(item_kind, &d.language, d.folder_name.as_deref(), is_entry, text).first() {
        return refuse(p.message.clone());
    }
    let target = PathBuf::from(&d.path);
    check_write_allowed(&target)?;
    let note = if is_entry {
        let entry: Value = serde_json::from_str(text).map_err(|e| WriteError::Refused(format!("Not valid JSON: {e}")))?;
        let before = fs::read(&target).ok();
        let style = before.as_deref().map(detect_style).unwrap_or_default();
        let mut root = match &before {
            Some(b) => parse_json_bytes(b).map_err(|e| WriteError::Refused(format!("The file can't be read as JSON ({e}), so nothing was changed.")))?,
            None => Value::Object(Map::new()),
        };
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
        write_manifest(&dir, &Manifest { version: 1, backup_id: id.clone(), created_ms: now_ms(), action: "create".into(), kind: kind.into(), name: d.name.clone(), unit: "path".into(), path: Some(d.path.clone()), is_dir: Some(false), file: None, removed: None, after_stamp: None, has_file_before: Some(before.is_some()) })?;
        if fs::read(&target).ok() != before {
            let _ = fs::remove_dir_all(&dir);
            return refuse("The file changed while Atlas was getting ready. Nothing was added; please try again.");
        }
        atomic_write(&target, &after)?;
        if fs::read(&target)? != after {
            return refuse("Something else changed the file at the same moment. Please check and try again.");
        }
        id
    } else {
        if target.exists() {
            return refuse("Something is already there, so Atlas did not overwrite it.");
        }
        let (id, dir) = new_backup(backups, &format!("create-{kind}-{name}"))?;
        write_manifest(&dir, &Manifest { version: 1, backup_id: id.clone(), created_ms: now_ms(), action: "create".into(), kind: kind.into(), name: d.name.clone(), unit: "path".into(), path: Some(d.path.clone()), is_dir: Some(false), file: None, removed: None, after_stamp: None, has_file_before: Some(false) })?;
        atomic_write(&target, &encode_like(text, false, false))?;
        id
    };
    Ok(DeleteOutcome { backup_id: note, name: d.name, kind: kind.into(), note: None })
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
