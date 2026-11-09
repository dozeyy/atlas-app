//! The receipt scan: one pass over a chat's transcript files that records what the numbers cannot
//! say, which tool results put how much into the conversation, how each helper ended, and how
//! many turns each thread took. Streamed like every other transcript read; what is kept is tool
//! names, file paths and counts. No message text, no command lines, no prompts.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;
use std::marker::PhantomData;
use std::path::PathBuf;

use memchr::memmem;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};

use super::reader::{open_read_only, read_lines, Item, ReadStats, LINE_CAP};

/// Bump when the scan's shape or meaning changes (a stored scan is then ignored).
pub const SCAN_VERSION: u32 = 1;

/// Results smaller than this many estimated tokens are not kept one by one.
const KEEP_MIN_TOKENS: u64 = 400;
/// The most results kept per thread; the biggest win.
const KEEP_MAX: usize = 4_000;

/// One transcript file of a chat and whose thread it is.
#[derive(Debug, Clone)]
pub struct ScanFile {
    pub path: PathBuf,
    /// `None` for the main conversation, the helper's id for a helper's file.
    pub agent_id: Option<String>,
}

/// One tool result that went into a thread's conversation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultScan {
    /// `Read`, `Bash`, `Grep`, `Agent`, `mcp__x__y`, ...
    pub tool: String,
    /// For `Read` (and file tools): the file.
    pub path: Option<String>,
    /// Estimated tokens (bytes / 4).
    pub tokens: u64,
    /// How many assistant turns this thread had taken when it arrived.
    pub turn: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadScan {
    pub agent_id: Option<String>,
    /// Distinct assistant messages in the thread's files.
    pub turns: u32,
    /// `stop_reason` of the thread's last assistant line.
    pub last_stop: Option<String>,
    /// The last assistant line was an API error message.
    pub last_api_error: bool,
    /// The user interrupted the thread at some point.
    pub interrupted: bool,
    pub results: Vec<ResultScan>,
}

/// A "task finished" record Claude Code wrote into a transcript for one helper.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub agent_id: String,
    /// `completed`, `failed` or `killed`.
    pub status: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub version: u32,
    /// At least one transcript file could be read.
    pub readable: bool,
    pub threads: Vec<ThreadScan>,
    pub notices: Vec<Notice>,
}

// ---------------------------------------------------------------- tolerant JSON shapes

/// A list of blocks; a plain string or anything else reads as an empty list.
struct Blocks<T>(Vec<T>);

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Blocks<T> {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V<T>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for V<T> {
            type Value = Blocks<T>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a list of blocks or a string")
            }
            fn visit_str<E: de::Error>(self, _: &str) -> Result<Self::Value, E> {
                Ok(Blocks(Vec::new()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                let mut v = Vec::new();
                while let Some(x) = a.next_element::<T>()? {
                    v.push(x);
                }
                Ok(Blocks(v))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                while a.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(Blocks(Vec::new()))
            }
        }
        d.deserialize_any(V(PhantomData))
    }
}

/// The byte length of a text that is either one string or a list of `{type,text}` blocks.
struct TextLen(usize);

impl<'de> Deserialize<'de> for TextLen {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = TextLen;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a string or a list of text blocks")
            }
            fn visit_str<E: de::Error>(self, s: &str) -> Result<Self::Value, E> {
                Ok(TextLen(s.len()))
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                #[derive(Deserialize)]
                struct Part {
                    #[serde(default)]
                    text: Option<TextLen>,
                }
                let mut n = 0;
                while let Some(p) = a.next_element::<Part>()? {
                    n += p.text.map_or(0, |t| t.0);
                }
                Ok(TextLen(n))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                while a.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(TextLen(0))
            }
        }
        d.deserialize_any(V)
    }
}

#[derive(Deserialize)]
struct ToolInput<'a> {
    #[serde(borrow, default)]
    file_path: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    notebook_path: Option<Cow<'a, str>>,
}

#[derive(Deserialize)]
struct ABlock<'a> {
    #[serde(rename = "type", borrow, default)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    input: Option<ToolInput<'a>>,
}

#[derive(Deserialize)]
struct AMsg<'a> {
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    stop_reason: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    content: Option<Blocks<ABlock<'a>>>,
}

#[derive(Deserialize)]
struct ALine<'a> {
    #[serde(borrow, default)]
    message: Option<AMsg<'a>>,
    #[serde(rename = "isApiErrorMessage", default)]
    api_error: Option<bool>,
}

#[derive(Deserialize)]
struct UBlock<'a> {
    #[serde(rename = "type", borrow, default)]
    ty: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    tool_use_id: Option<Cow<'a, str>>,
    #[serde(default)]
    content: Option<TextLen>,
}

#[derive(Deserialize)]
struct UMsg<'a> {
    #[serde(borrow, default)]
    content: Option<Blocks<UBlock<'a>>>,
}

#[derive(Deserialize)]
struct ULine<'a> {
    #[serde(borrow, default)]
    message: Option<UMsg<'a>>,
}

// ---------------------------------------------------------------- the pass

fn est_tokens(bytes: usize) -> u64 {
    (bytes as u64).div_ceil(4)
}

/// Every `<task-notification>` in a raw line: which helper, how it ended.
fn notices_in(line: &[u8], out: &mut Vec<Notice>) {
    let open = memmem::Finder::new(b"<task-notification>");
    let mut from = 0;
    while let Some(i) = open.find(&line[from..]) {
        let start = from + i + 19;
        // The id and status sit at the top of the record; never look further than this.
        let window = &line[start..line.len().min(start + 2_000)];
        let tag = |name: &[u8]| -> Option<String> {
            let mut o = b"<".to_vec();
            o.extend_from_slice(name);
            o.push(b'>');
            let mut c = b"</".to_vec();
            c.extend_from_slice(name);
            c.push(b'>');
            let a = memmem::find(window, &o)? + o.len();
            let b = memmem::find(&window[a..], &c)?;
            std::str::from_utf8(&window[a..a + b]).ok().map(|s| s.trim().to_string())
        };
        if let (Some(id), Some(status)) = (tag(b"task-id"), tag(b"status"))
            && !id.is_empty()
            && id.len() < 80
        {
            out.push(Notice { agent_id: id, status });
        }
        from = start;
    }
}

fn scan_one(file: &ScanFile, stats: &ReadStats, notices: &mut Vec<Notice>) -> Option<ThreadScan> {
    let f = open_read_only(&file.path).ok()?;
    let mut t = ThreadScan { agent_id: file.agent_id.clone(), ..Default::default() };
    let mut uses: HashMap<String, (String, Option<String>)> = HashMap::new();
    let mut last_id = String::new();
    let _ = read_lines(f, 0, LINE_CAP, stats, |item, _| {
        let Item::Line(line) = item else { return true };
        if memmem::find(line, b"<task-notification>").is_some() {
            notices_in(line, notices);
        }
        // Only Claude Code's own marker: a user line whose text (or plain content) starts with it.
        // A file or tool result that quotes the marker carries it escaped mid-string, which these miss.
        if memmem::find(line, br#""type":"user""#).is_some()
            && (memmem::find(line, br#""text":"[Request interrupted by user"#).is_some()
                || memmem::find(line, br#""content":"[Request interrupted by user"#).is_some())
        {
            t.interrupted = true;
        }
        if memmem::find(line, br#""type":"assistant""#).is_some() {
            let Ok(l) = serde_json::from_slice::<ALine>(line) else { return true };
            let api_error = l.api_error == Some(true);
            t.last_api_error = api_error;
            if let Some(m) = l.message {
                t.last_stop = m.stop_reason.map(|s| s.into_owned());
                if !api_error
                    && let Some(id) = m.id.as_deref()
                    && id != last_id
                {
                    last_id.clear();
                    last_id.push_str(id);
                    t.turns += 1;
                }
                for b in m.content.map(|c| c.0).unwrap_or_default() {
                    if b.ty.as_deref() == Some("tool_use")
                        && let Some(id) = b.id
                    {
                        let path = b.input.and_then(|i| i.file_path.or(i.notebook_path)).map(|p| p.into_owned());
                        uses.insert(id.into_owned(), (b.name.map(|n| n.into_owned()).unwrap_or_else(|| "tool".into()), path));
                    }
                }
            }
        } else if memmem::find(line, br#""tool_result""#).is_some() && memmem::find(line, br#""type":"user""#).is_some() {
            let Ok(l) = serde_json::from_slice::<ULine>(line) else { return true };
            let blocks = l.message.and_then(|m| m.content).map(|c| c.0).unwrap_or_default();
            for b in blocks {
                if b.ty.as_deref() != Some("tool_result") {
                    continue;
                }
                let tokens = est_tokens(b.content.map_or(0, |c| c.0));
                let (tool, path) = b
                    .tool_use_id
                    .as_deref()
                    .and_then(|id| uses.get(id).cloned())
                    .unwrap_or_else(|| ("tool".to_string(), None));
                if tokens >= KEEP_MIN_TOKENS {
                    t.results.push(ResultScan { tool, path, tokens, turn: t.turns });
                }
            }
        }
        true
    });
    if t.results.len() > KEEP_MAX {
        t.results.sort_by_key(|r| std::cmp::Reverse(r.tokens));
        t.results.truncate(KEEP_MAX);
    }
    Some(t)
}

/// Scan every file of a chat. Files that cannot be opened are skipped; `readable` says whether any could.
pub fn scan_files(files: &[ScanFile], stats: &ReadStats) -> Scan {
    let mut threads: Vec<ThreadScan> = Vec::new();
    let mut notices: Vec<Notice> = Vec::new();
    let mut readable = false;
    for f in files {
        let Some(t) = scan_one(f, stats, &mut notices) else { continue };
        readable = true;
        match threads.iter_mut().find(|x| x.agent_id == t.agent_id) {
            Some(x) => {
                let offset = x.turns;
                x.turns += t.turns;
                // A later file with no assistant turn says nothing about how the thread ended.
                if t.turns > 0 || t.last_stop.is_some() {
                    x.last_stop = t.last_stop;
                    x.last_api_error = t.last_api_error;
                }
                x.interrupted |= t.interrupted;
                x.results.extend(t.results.into_iter().map(|mut r| {
                    r.turn += offset;
                    r
                }));
            }
            None => threads.push(t),
        }
    }
    // One notice per helper; the last one written wins.
    let mut last: HashMap<String, String> = HashMap::new();
    for n in notices {
        last.insert(n.agent_id, n.status);
    }
    let mut notices: Vec<Notice> = last.into_iter().map(|(agent_id, status)| Notice { agent_id, status }).collect();
    notices.sort_by(|a, b| a.agent_id.cmp(&b.agent_id));
    Scan { version: SCAN_VERSION, readable, threads, notices }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_read_the_id_and_status_only() {
        let line = br#"{"type":"queue-operation","content":"<task-notification>\n<task-id>a1b2</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<output-file>C:\\x</output-file>\n<status>failed</status>\n<summary>nope</summary></task-notification>"}"#;
        let mut out = Vec::new();
        notices_in(line, &mut out);
        assert_eq!(out, vec![Notice { agent_id: "a1b2".into(), status: "failed".into() }]);
    }

    #[test]
    fn a_tool_result_is_sized_by_its_text_whether_string_or_blocks() {
        let s: ULine = serde_json::from_str(
            r#"{"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"12345678"},{"type":"tool_result","tool_use_id":"t2","content":[{"type":"text","text":"1234"},{"type":"image","source":{}},{"type":"text","text":"56"}]}]}}"#,
        )
        .unwrap();
        let b = s.message.unwrap().content.unwrap().0;
        assert_eq!(b[0].content.as_ref().unwrap().0, 8);
        assert_eq!(b[1].content.as_ref().unwrap().0, 6);
        let plain: ULine = serde_json::from_str(r#"{"message":{"content":"hello"}}"#).unwrap();
        assert!(plain.message.unwrap().content.unwrap().0.is_empty());
    }
}
