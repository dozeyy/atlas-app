//! The text behind one item, for the read-only viewer.
//!
//! Only ids the last discovery produced can be opened (the registry is the
//! allow-list), the shared deny list is applied again here, and secret values
//! are masked before the text leaves this module. `reveal` returns one value.

use std::fs;
use std::io::Read;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;

use super::secrets::{self, MaskedRange};
use super::{Discovery, SourceRef};
use crate::layout;

const FILE_CAP: usize = 1024 * 1024;
const JSON_FILE_CAP: u64 = 64 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    pub id: String,
    /// Masked: secret values are bullets.
    pub text: String,
    pub language: String,
    pub truncated: bool,
    pub masked_ranges: Vec<MaskedRange>,
    pub size: u64,
    /// "LF" | "CRLF"
    pub line_ending: String,
    pub bom: bool,
}

struct Raw {
    text: String,
    json: bool,
    language: &'static str,
    truncated: bool,
    size: u64,
    crlf: bool,
    bom: bool,
}

fn language_of(path: &Path) -> &'static str {
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

fn read_file_text(path: &Path) -> Result<(String, bool, u64), String> {
    let f = fs::File::open(path).map_err(|_| "The file can't be opened".to_string())?;
    let size = f.metadata().map(|m| m.len()).unwrap_or(0);
    let mut buf = Vec::new();
    f.take(FILE_CAP as u64 + 1).read_to_end(&mut buf).map_err(|_| "The file can't be read".to_string())?;
    let truncated = buf.len() > FILE_CAP;
    buf.truncate(FILE_CAP);
    if buf.iter().take(8192).any(|&b| b == 0) {
        return Err("This is a binary file".into());
    }
    if truncated {
        // Do not cut a UTF-8 sequence in half.
        for _ in 0..3 {
            if std::str::from_utf8(&buf).is_ok() {
                break;
            }
            buf.pop();
        }
    }
    Ok((String::from_utf8_lossy(&buf).into_owned(), truncated, size))
}

impl Discovery {
    fn raw(&self, id: &str) -> Result<Raw, String> {
        let src = self.sources.get(id).ok_or_else(|| "Unknown item (refresh the page)".to_string())?;
        match src {
            SourceRef::File { path } => {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if layout::is_denied_name(&name) {
                    return Err("This file is never shown".into());
                }
                let canon = fs::canonicalize(path).map_err(|_| "The file is gone".to_string())?;
                let cname = canon.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                if layout::is_denied_name(&cname) {
                    return Err("This file is never shown".into());
                }
                if let Ok(root) = fs::canonicalize(&self.root_dir)
                    && let Ok(rel) = canon.strip_prefix(&root)
                        && layout::is_denied(&rel.to_string_lossy().replace('\\', "/")) {
                            return Err("This file is never shown".into());
                        }
                let (mut text, truncated, size) = read_file_text(&canon)?;
                let bom = text.starts_with('\u{feff}');
                if bom {
                    text.remove(0);
                }
                let crlf = text.contains("\r\n");
                let language = language_of(path);
                Ok(Raw { json: language == "json", text, language, truncated, size, crlf, bom })
            }
            SourceRef::JsonEntry { file, pointer } => {
                let cname = file.file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                if cname == ".credentials.json" {
                    return Err("This file is never shown".into());
                }
                let md = fs::metadata(file).map_err(|_| "The file is gone".to_string())?;
                if md.len() > JSON_FILE_CAP {
                    return Err("The file is too large to open".into());
                }
                let bytes = fs::read(file).map_err(|_| "The file can't be read".to_string())?;
                let s = String::from_utf8_lossy(&bytes);
                let v: Value = serde_json::from_str(s.trim_start_matches('\u{feff}')).map_err(|_| "The file can't be read as JSON".to_string())?;
                let mut cur = &v;
                for seg in pointer {
                    cur = match cur {
                        Value::Object(m) => m.get(seg).ok_or_else(|| "This entry is gone".to_string())?,
                        Value::Array(a) => seg.parse::<usize>().ok().and_then(|i| a.get(i)).ok_or_else(|| "This entry is gone".to_string())?,
                        _ => return Err("This entry is gone".into()),
                    };
                }
                let text = serde_json::to_string_pretty(cur).map_err(|_| "Can't show this entry".to_string())?;
                let size = text.len() as u64;
                Ok(Raw { text, json: true, language: "json", truncated: false, size, crlf: false, bom: false })
            }
            SourceRef::Text(t) => Ok(Raw { text: t.clone(), json: true, language: "json", truncated: false, size: t.len() as u64, crlf: false, bom: false }),
        }
    }

    /// The masked text of an item.
    pub fn read_source(&self, id: &str) -> Result<SourceView, String> {
        let raw = self.raw(id)?;
        let masked = if raw.json { secrets::mask_json(&raw.text) } else { secrets::mask_plain(&raw.text) };
        Ok(SourceView {
            id: id.to_string(),
            text: masked.text,
            language: raw.language.to_string(),
            truncated: raw.truncated,
            masked_ranges: masked.ranges,
            size: raw.size,
            line_ending: if raw.crlf { "CRLF" } else { "LF" }.into(),
            bom: raw.bom,
        })
    }

    /// One masked value, by its index in the view `read_source` returned.
    pub fn reveal(&self, id: &str, index: usize) -> Result<String, String> {
        let raw = self.raw(id)?;
        secrets::reveal(&raw.text, raw.json, index).ok_or_else(|| "No such value".to_string())
    }
}
