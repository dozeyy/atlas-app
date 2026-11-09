//! What the engine remembers about the chats that are running: one `Session` per chat,
//! one `FileTrack` per transcript file (the chat's own and each helper's), all fed one
//! line at a time through `facts`. Nothing here keeps a line; only the few facts.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::facts::{Desc, Facts, Parsed, Role, clean};
use super::model::{Doing, NowChat, NowFile, NowHelper, NowLast, NowStep};
use crate::search::mask::mask_secrets;
use crate::usage::naming::{AgentMeta, agent_id_of_stem, agent_name};
use crate::usage::pricing::{Basis, Counts, PriceTable};
use crate::usage::reader::{Item, LINE_CAP, ReadStats, open_read_only, read_lines};

/// Tool calls kept per chat (the page shows the last `SHOWN_STEPS`).
const MAX_STEPS: usize = 24;
pub const SHOWN_STEPS: usize = 8;
const MAX_FILES: usize = 6;
const MAX_PENDING: usize = 32;
/// A helper that finished stays on the page this long, so its last move is seen.
const HELPER_LINGER_MS: i64 = 8_000;
/// How far back the last-finished chat is read for its title and project.
const TAIL_BYTES: u64 = 2 * 1024 * 1024;
const META_TRIES: u8 = 20;

pub fn mtime_ms(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

struct Row {
    tokens: u64,
    cost: Option<f64>,
}

struct Pend {
    id: String,
    desc: Desc,
}

pub struct FileTrack {
    pub path: PathBuf,
    pub is_sub: bool,
    pub agent_id: String,
    pub offset: u64,
    pub mtime_ms: i64,
    rows: HashMap<String, Row>,
    tokens: u64,
    cost: f64,
    unpriced: u32,
    pending: Vec<Pend>,
    ended: bool,
    first_ts: Option<i64>,
    last_ts: Option<i64>,
    name: Option<String>,
    meta_tries: u8,
}

impl FileTrack {
    pub fn new(path: PathBuf, is_sub: bool) -> FileTrack {
        let agent_id = if is_sub {
            path.file_stem().and_then(|s| s.to_str()).map(agent_id_of_stem).unwrap_or_default()
        } else {
            String::new()
        };
        FileTrack {
            path,
            is_sub,
            agent_id,
            offset: 0,
            mtime_ms: 0,
            rows: HashMap::new(),
            tokens: 0,
            cost: 0.0,
            unpriced: 0,
            pending: Vec::new(),
            ended: false,
            first_ts: None,
            last_ts: None,
            name: None,
            meta_tries: 0,
        }
    }

    fn reset(&mut self) {
        let (path, is_sub) = (self.path.clone(), self.is_sub);
        let (name, tries) = (self.name.take(), self.meta_tries);
        *self = FileTrack::new(path, is_sub);
        self.name = name;
        self.meta_tries = tries;
    }

    /// A helper's name comes from the little file beside its transcript. It can show up a
    /// moment after the transcript does, so it is asked for a few times.
    fn find_name(&mut self) {
        if !self.is_sub || self.name.is_some() || self.meta_tries >= META_TRIES {
            return;
        }
        self.meta_tries += 1;
        let mut buf = Vec::new();
        let p = self.path.with_extension("meta.json");
        let Ok(f) = open_read_only(&p) else { return };
        if f.take(64 * 1024).read_to_end(&mut buf).is_err() {
            return;
        }
        if let Some(m) = AgentMeta::parse(&buf) {
            let (name, _) = agent_name(m.description.as_deref(), m.agent_type.as_deref(), None);
            self.name = Some(mask(&clean(&name, 40)));
        }
    }
}

struct StepRec {
    /// The first call's id: stays put while the same call repeats, so the page never re-animates it.
    id: String,
    /// The newest repeat's id: its result is the one that marks the step done.
    latest: String,
    /// How many identical calls in a row this step stands for.
    count: u32,
    desc: Desc,
    ts_ms: i64,
    done: bool,
    /// The helper's agent id, `None` for the chat itself.
    by: Option<String>,
}

pub struct Session {
    pub id: String,
    pub seq: u64,
    pub files: Vec<FileTrack>,
    folder_hint: String,
    cwd: Option<String>,
    custom_title: Option<String>,
    agent_title: Option<String>,
    model: Option<String>,
    prompt_ts: Option<i64>,
    steps: VecDeque<StepRec>,
    touched: Vec<NowFile>,
}

fn mask(s: &str) -> String {
    mask_secrets(s).into_owned()
}

impl Session {
    pub fn new(id: String, seq: u64, folder_hint: String) -> Session {
        Session {
            id,
            seq,
            files: Vec::new(),
            folder_hint,
            cwd: None,
            custom_title: None,
            agent_title: None,
            model: None,
            prompt_ts: None,
            steps: VecDeque::new(),
            touched: Vec::new(),
        }
    }

    pub fn file_index(&self, path: &Path) -> Option<usize> {
        self.files.iter().position(|f| f.path == path)
    }

    /// Start tracking a file (idempotent); returns its index.
    pub fn add_file(&mut self, path: &Path, is_sub: bool) -> usize {
        if let Some(i) = self.file_index(path) {
            return i;
        }
        let mut f = FileTrack::new(path.to_path_buf(), is_sub);
        f.mtime_ms = std::fs::metadata(path).map(|m| mtime_ms(&m)).unwrap_or(0);
        self.files.push(f);
        self.files.len() - 1
    }

    pub fn newest_write_ms(&self) -> i64 {
        self.files.iter().map(|f| f.mtime_ms).max().unwrap_or(0)
    }

    /// Read what has been appended to file `fi` since last time.
    pub fn read_file(&mut self, fi: usize, facts: &Facts, prices: &PriceTable, stats: &ReadStats) -> io::Result<()> {
        let path = self.files[fi].path.clone();
        let file = open_read_only(&path)?;
        let meta = file.metadata()?;
        self.files[fi].mtime_ms = mtime_ms(&meta);
        if meta.len() < self.files[fi].offset {
            self.files[fi].reset(); // replaced or truncated: begin again
        }
        let start = self.files[fi].offset;
        if meta.len() == start {
            self.files[fi].find_name();
            return Ok(());
        }
        let committed = read_lines(file, start, LINE_CAP, stats, |item, _| {
            if let Item::Line(l) = item {
                self.feed(fi, l, facts, prices);
            }
            true
        })?;
        self.files[fi].offset = committed;
        self.files[fi].find_name();
        Ok(())
    }

    fn feed(&mut self, fi: usize, line: &[u8], facts: &Facts, prices: &PriceTable) {
        let Some(p) = facts.parse(line) else { return };
        let is_sub = self.files[fi].is_sub;
        if let Some(t) = p.ts_ms {
            let f = &mut self.files[fi];
            f.first_ts.get_or_insert(t);
            f.last_ts = Some(f.last_ts.map_or(t, |o| o.max(t)));
        }
        if let Some(c) = &p.cwd
            && (!is_sub || self.cwd.is_none())
        {
            self.cwd = Some(c.clone());
        }
        match p.role {
            Role::Title => {
                if !is_sub && let Some((custom, t)) = p.title {
                    if custom {
                        self.custom_title = Some(mask(&t));
                    } else {
                        self.agent_title = Some(mask(&t));
                    }
                }
            }
            Role::Prompt => {
                self.abandon(fi);
                if p.interrupted {
                    self.files[fi].ended = true;
                } else {
                    self.files[fi].ended = false;
                    if !is_sub {
                        self.prompt_ts = p.ts_ms.or(self.prompt_ts);
                    }
                }
            }
            Role::Result => {
                if p.interrupted {
                    self.abandon(fi);
                    self.files[fi].ended = true;
                }
                for id in &p.result_ids {
                    self.files[fi].pending.retain(|x| &x.id != id);
                    if let Some(s) = self.steps.iter_mut().rev().find(|s| &s.latest == id) {
                        s.done = true;
                    }
                }
            }
            Role::Assistant => self.assistant(fi, p, prices),
            Role::Other => {
                if p.interrupted {
                    self.abandon(fi);
                    self.files[fi].ended = true;
                }
            }
        }
    }

    /// Whatever was open when a new prompt (or a stop) came in is not coming back.
    fn abandon(&mut self, fi: usize) {
        let by = self.by_of(fi);
        self.files[fi].pending.clear();
        for s in self.steps.iter_mut().filter(|s| s.by == by) {
            s.done = true;
        }
    }

    fn by_of(&self, fi: usize) -> Option<String> {
        let f = &self.files[fi];
        f.is_sub.then(|| f.agent_id.clone())
    }

    fn assistant(&mut self, fi: usize, p: Parsed, prices: &PriceTable) {
        let is_sub = self.files[fi].is_sub;
        if let Some(m) = p.usage {
            if !is_sub && !m.model.is_empty() {
                self.model = Some(m.model.clone());
            }
            let counts = Counts {
                input: m.input,
                output: m.output,
                cw5m: m.cw5m,
                cw1h: m.cw1h,
                cr: m.cr,
                web_search: m.web_search,
            };
            let tier = prices.price_tier(&m.model, &counts);
            let cost = prices.cost(
                &Basis { model: &m.model, speed: &m.speed, geo: &m.geo, service_tier: &m.service_tier, price_tier: tier },
                &counts,
            );
            let row = Row { tokens: m.input + m.output + m.cw5m + m.cw1h, cost };
            let f = &mut self.files[fi];
            let key = if m.key.is_empty() { format!("#{}", f.rows.len()) } else { m.key.clone() };
            if let Some(old) = f.rows.insert(key, Row { tokens: row.tokens, cost: row.cost }) {
                f.tokens = f.tokens.saturating_sub(old.tokens);
                match old.cost {
                    Some(c) => f.cost = (f.cost - c).max(0.0),
                    None => f.unpriced = f.unpriced.saturating_sub(1),
                }
            }
            f.tokens += row.tokens;
            match row.cost {
                Some(c) => f.cost += c,
                None => f.unpriced += 1,
            }
        }
        let ts = p.ts_ms.unwrap_or(0);
        if p.tools.is_empty() {
            let end = matches!(p.stop_reason.as_deref(), Some("end_turn" | "stop_sequence" | "max_tokens" | "refusal"));
            self.files[fi].ended = end;
            return;
        }
        self.files[fi].ended = false;
        let by = self.by_of(fi);
        for t in p.tools {
            if let Some((path, edited)) = t.touched {
                self.touch(path, edited);
            }
            let f = &mut self.files[fi];
            if f.pending.len() >= MAX_PENDING {
                f.pending.remove(0);
            }
            f.pending.push(Pend { id: t.id.clone(), desc: t.desc.clone() });
            // The same call again straight after itself (a script polling, a retry) is one step
            // with a count, not a new step, so the trail does not slide in every few hundred ms.
            if let Some(last) = self.steps.back_mut().filter(|s| s.by == by && s.desc == t.desc) {
                if last.latest != t.id {
                    last.count += 1;
                    last.latest = t.id;
                }
                last.ts_ms = ts;
                last.done = false;
                continue;
            }
            self.steps.push_back(StepRec { id: t.id.clone(), latest: t.id, count: 1, desc: t.desc, ts_ms: ts, done: false, by: by.clone() });
            if self.steps.len() > MAX_STEPS {
                self.steps.pop_front();
            }
        }
    }

    fn touch(&mut self, path: String, edited: bool) {
        let was = self.touched.iter().position(|f| f.path == path).map(|i| self.touched.remove(i));
        let edited = edited || was.is_some_and(|w| w.edited);
        self.touched.insert(0, NowFile { path, edited });
        self.touched.truncate(MAX_FILES);
    }

    // ------------------------------------------------------------------ what the page gets

    fn main(&self) -> Option<&FileTrack> {
        self.files.iter().find(|f| !f.is_sub)
    }

    pub fn title(&self) -> Option<String> {
        self.custom_title.clone().or_else(|| self.agent_title.clone())
    }

    pub fn project(&self) -> String {
        let from_cwd = self.cwd.as_deref().and_then(|c| {
            let c = c.replace('\\', "/");
            c.trim_end_matches('/').rsplit('/').next().map(str::to_string)
        });
        let name = from_cwd.filter(|s| !s.is_empty()).unwrap_or_else(|| self.folder_hint.clone());
        mask(&clean(&name, 40))
    }

    pub fn last(&self) -> NowLast {
        NowLast {
            session_id: self.id.clone(),
            title: self.title(),
            project: self.project(),
            model: self.model.clone(),
            ended_ms: self.newest_write_ms(),
            tokens: Some(self.files.iter().map(|f| f.tokens).sum()),
        }
    }

    fn helper_view(&self, f: &FileTrack, now: i64) -> NowHelper {
        let doing = if f.ended {
            None
        } else {
            Some(doing_of(&f.pending).unwrap_or_else(|| Doing { kind: "think".into(), verb: "Thinking".into(), target: None }))
        };
        NowHelper {
            id: f.agent_id.clone(),
            name: f.name.clone().unwrap_or_else(|| "Helper".to_string()),
            doing,
            tokens: f.tokens,
            cost_usd: (f.rows.len() as u32 > f.unpriced).then_some(f.cost),
            started_ms: f.first_ts,
            done: f.ended || now - f.mtime_ms > 30_000,
        }
    }

    pub fn chat(&self, now: i64, window_ms: i64) -> NowChat {
        let main = self.main();
        let helpers: Vec<NowHelper> = self
            .files
            .iter()
            .filter(|f| f.is_sub && now - f.mtime_ms <= window_ms)
            .map(|f| (f, self.helper_view(f, now)))
            .filter(|(f, h)| !h.done || (f.ended && now - f.mtime_ms <= HELPER_LINGER_MS))
            .map(|(_, h)| h)
            .collect();
        let out = helpers.iter().filter(|h| !h.done).count();

        let pending: &[Pend] = main.map_or(&[][..], |m| m.pending.as_slice());
        let doing = if pending.iter().any(|p| p.desc.kind == "ask") {
            wait_doing("ask", "Waiting for you")
        } else if !pending.is_empty() && pending.iter().all(|p| p.desc.kind == "helper") && out > 0 {
            let verb = if out == 1 { "Waiting on a helper".to_string() } else { format!("Waiting on {out} helpers") };
            wait_doing("helper", &verb)
        } else if let Some(d) = doing_of(pending) {
            d
        } else if main.is_some_and(|m| m.ended) {
            wait_doing("wait", "Waiting for you")
        } else if main.is_none() && let Some(h) = helpers.iter().find(|h| !h.done).and_then(|h| h.doing.clone()) {
            h
        } else {
            Doing { kind: "think".into(), verb: "Thinking".into(), target: None }
        };
        let waiting = matches!(doing.kind.as_str(), "wait" | "ask");

        let (mut tokens, mut cost, mut unpriced, mut rows) = (0u64, 0f64, 0u32, 0usize);
        for f in &self.files {
            tokens += f.tokens;
            cost += f.cost;
            unpriced += f.unpriced;
            rows += f.rows.len();
        }
        let started = self.prompt_ts.or_else(|| main.and_then(|m| m.first_ts));
        let worked = match (self.prompt_ts, main.and_then(|m| m.last_ts)) {
            (Some(a), Some(b)) if waiting && b >= a => Some(b - a),
            _ => None,
        };
        let name_of = |by: &Option<String>| -> Option<String> {
            let id = by.as_ref()?;
            let n = self.files.iter().find(|f| f.is_sub && &f.agent_id == id).and_then(|f| f.name.clone());
            Some(n.unwrap_or_else(|| "Helper".to_string()))
        };
        let skip = self.steps.len().saturating_sub(SHOWN_STEPS);
        let steps = self
            .steps
            .iter()
            .skip(skip)
            .map(|s| NowStep {
                id: s.id.clone(),
                kind: s.desc.kind.to_string(),
                verb: s.desc.verb.clone(),
                target: s.desc.target.clone(),
                ts_ms: s.ts_ms,
                done: s.done,
                count: s.count,
                by: name_of(&s.by),
            })
            .collect();
        NowChat {
            session_id: self.id.clone(),
            title: self.title(),
            project: self.project(),
            model: self.model.clone(),
            state: if waiting { "waiting" } else { "working" }.to_string(),
            started_ms: started,
            worked_ms: worked,
            last_write_ms: self.newest_write_ms(),
            doing,
            tokens,
            cost_usd: (rows as u32 > unpriced).then_some(cost),
            unpriced: unpriced > 0,
            helpers,
            files: self.touched.clone(),
            steps,
        }
    }
}

fn wait_doing(kind: &str, verb: &str) -> Doing {
    Doing { kind: kind.to_string(), verb: verb.to_string(), target: None }
}

/// Edit and write read as one thing.
fn group_key(kind: &str) -> &str {
    match kind {
        "write" => "edit",
        k => k,
    }
}

/// What a set of open tool calls amounts to: the newest one, or "Reading 3 files" when
/// several of the same kind are out at once.
fn doing_of(pending: &[Pend]) -> Option<Doing> {
    let last = pending.last()?;
    if last.desc.kind == "ask" {
        return Some(wait_doing("ask", "Waiting for you"));
    }
    let key = group_key(last.desc.kind);
    let n = pending.iter().filter(|p| group_key(p.desc.kind) == key).count();
    if n > 1 {
        let verb = match key {
            "read" => format!("Reading {n} files"),
            "edit" => format!("Editing {n} files"),
            "run" => format!("Running {n} commands"),
            "search" => format!("Running {n} searches"),
            "web" => format!("Fetching {n} pages"),
            "helper" => format!("Starting {n} helpers"),
            "tool" => format!("Using {n} tools"),
            _ => last.desc.verb.clone(),
        };
        let kind = if key == "edit" { "edit" } else { last.desc.kind };
        return Some(Doing { kind: kind.to_string(), verb, target: None });
    }
    Some(Doing { kind: last.desc.kind.to_string(), verb: last.desc.verb.clone(), target: last.desc.target.clone() })
}

/// The last-finished chat, read from the end of its transcript only.
pub fn tail_last(path: &Path, id: &str, folder_hint: &str, facts: &Facts, prices: &PriceTable, stats: &ReadStats) -> Option<NowLast> {
    let size = std::fs::metadata(path).ok()?.len();
    let start = size.saturating_sub(TAIL_BYTES);
    let mut s = Session::new(id.to_string(), 0, folder_hint.to_string());
    let fi = s.add_file(path, false);
    s.files[fi].offset = start;
    let file = open_read_only(path).ok()?;
    let mut first = start > 0;
    read_lines(file, start, LINE_CAP, stats, |item, _| {
        if let Item::Line(l) = item {
            if first {
                first = false; // began mid-line
            } else {
                s.feed(fi, l, facts, prices);
            }
        }
        true
    })
    .ok()?;
    // A copied file (a restore) has a fresh write time: the chat ended at its last entry.
    let last = s.last();
    let ended_ms = s.files[fi].last_ts.map_or(last.ended_ms, |t| t.min(last.ended_ms));
    // Only the end of the file was read: a token total would be a fraction of the real one.
    Some(NowLast { tokens: None, ended_ms, ..last })
}

/// How far back `last_entry_ms` looks for a stamped line.
const ENTRY_TAIL_BYTES: u64 = 256 * 1024;

/// The timestamp of the newest stamped line, read from the end of the file only. `None` when
/// the end holds no stamped line (one huge line, or a file of untimed records).
pub fn last_entry_ms(path: &Path) -> Option<i64> {
    use std::io::{Seek, SeekFrom};
    let mut file = open_read_only(path).ok()?;
    let size = file.metadata().ok()?.len();
    let start = size.saturating_sub(ENTRY_TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    file.take(ENTRY_TAIL_BYTES).read_to_end(&mut buf).ok()?;
    let mut lines = buf.split(|b| *b == b'\n');
    if start > 0 {
        lines.next(); // began mid-line
    }
    #[derive(serde::Deserialize)]
    struct Stamp {
        timestamp: Option<String>,
    }
    let lines: Vec<&[u8]> = lines.collect();
    lines.iter().rev().find_map(|l| {
        let l = l.strip_suffix(b"\r").unwrap_or(l);
        if l.is_empty() {
            return None;
        }
        serde_json::from_slice::<Stamp>(l).ok()?.timestamp.as_deref().and_then(crate::usage::time::parse_iso_ms)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn prompt(ts: &str) -> String {
        format!(r#"{{"type":"user","timestamp":"{ts}","cwd":"C:\\p\\app","message":{{"role":"user","content":"do it"}}}}"#)
    }
    fn tool(id: &str, name: &str, input: &str, ts: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","cwd":"C:\\p\\app","requestId":"r{id}","message":{{"id":"m{id}","model":"claude-opus-5-5","stop_reason":"tool_use","content":[{{"type":"tool_use","id":"{id}","name":"{name}","input":{input}}}],"usage":{{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}}}}"#
        )
    }
    fn result(id: &str) -> String {
        format!(r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","tool_use_id":"{id}","content":"x"}}]}}}}"#)
    }
    fn end(ts: &str) -> String {
        format!(
            r#"{{"type":"assistant","timestamp":"{ts}","requestId":"rend","message":{{"id":"mend","model":"claude-opus-5-5","stop_reason":"end_turn","content":[{{"type":"text","text":"done"}}],"usage":{{"input_tokens":1,"output_tokens":1}}}}}}"#
        )
    }

    fn session(lines: &[String]) -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s1.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        for l in lines {
            writeln!(f, "{l}").unwrap();
        }
        let mut s = Session::new("s1".into(), 1, "proj".into());
        let fi = s.add_file(&p, false);
        s.read_file(fi, &Facts::new(), &PriceTable::seed(), &ReadStats::default()).unwrap();
        (dir, s)
    }

    #[test]
    fn a_chat_in_the_middle_of_work_shows_its_tool_and_totals() {
        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            tool("t1", "Read", r#"{"file_path":"C:\\p\\app\\src\\a.ts"}"#, "2026-11-08T10:00:01.000Z"),
            result("t1"),
            tool("t2", "Edit", r#"{"file_path":"C:\\p\\app\\src\\a.ts","old_string":"A","new_string":"B"}"#, "2026-11-08T10:00:02.000Z"),
        ]);
        let c = s.chat(now_after(), i64::MAX / 4);
        assert_eq!(c.state, "working");
        assert_eq!((c.doing.verb.as_str(), c.doing.target.as_deref()), ("Editing", Some("src/a.ts")));
        assert_eq!(c.project, "app");
        assert_eq!(c.model.as_deref(), Some("claude-opus-5-5"));
        assert_eq!(c.tokens, 2 * (10 + 5 + 100));
        assert_eq!(c.steps.len(), 2);
        assert!(c.steps[0].done && !c.steps[1].done);
        assert_eq!(c.files, vec![NowFile { path: "src/a.ts".into(), edited: true }]);
        assert!(c.started_ms.is_some() && c.cost_usd.is_some_and(|x| x > 0.0));
    }

    fn now_after() -> i64 {
        crate::usage::time::now_ms()
    }

    #[test]
    fn several_reads_at_once_group_and_the_end_of_a_turn_waits_for_you() {
        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            tool("a", "Read", r#"{"file_path":"x1"}"#, "2026-11-08T10:00:01.000Z"),
            tool("b", "Read", r#"{"file_path":"x2"}"#, "2026-11-08T10:00:01.000Z"),
            tool("c", "Read", r#"{"file_path":"x3"}"#, "2026-11-08T10:00:01.000Z"),
        ]);
        let c = s.chat(now_after(), i64::MAX / 4);
        assert_eq!(c.doing.verb, "Reading 3 files");
        assert_eq!(c.doing.target, None);

        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            tool("a", "Bash", r#"{"command":"cargo test"}"#, "2026-11-08T10:00:01.000Z"),
            result("a"),
            end("2026-11-08T10:00:09.000Z"),
        ]);
        let c = s.chat(now_after(), i64::MAX / 4);
        assert_eq!((c.state.as_str(), c.doing.verb.as_str()), ("waiting", "Waiting for you"));
        assert_eq!(c.worked_ms, Some(9_000));
    }

    #[test]
    fn a_new_prompt_or_a_stop_clears_what_was_open() {
        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            tool("a", "Bash", r#"{"command":"sleep 99"}"#, "2026-11-08T10:00:01.000Z"),
            r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user for tool use]"}]}}"#.to_string(),
        ]);
        let c = s.chat(now_after(), i64::MAX / 4);
        assert_eq!(c.state, "waiting");
        assert!(c.steps[0].done);
    }

    #[test]
    fn a_repeated_message_counts_once_and_the_last_line_wins() {
        let a = tool("t1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:01.000Z");
        let b = a.replace(r#""output_tokens":5"#, r#""output_tokens":50"#);
        let (_d, s) = session(&[prompt("2026-11-08T10:00:00.000Z"), a, b]);
        let c = s.chat(now_after(), i64::MAX / 4);
        assert_eq!(c.tokens, 10 + 50 + 100);
    }

    #[test]
    fn the_same_call_again_and_again_is_one_step_with_a_count() {
        let js = r#"{"command":"node poll.js"}"#;
        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            tool("b1", "Bash", js, "2026-11-08T10:00:01.000Z"),
            result("b1"),
            tool("b2", "Bash", js, "2026-11-08T10:00:01.100Z"),
            result("b2"),
            tool("b3", "Bash", js, "2026-11-08T10:00:01.200Z"),
            tool("r1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:01.300Z"),
            tool("b4", "Bash", js, "2026-11-08T10:00:01.400Z"),
        ]);
        let c = s.chat(now_after(), i64::MAX / 4);
        let ids: Vec<(&str, u32)> = c.steps.iter().map(|s| (s.id.as_str(), s.count)).collect();
        assert_eq!(ids, vec![("b1", 3), ("r1", 1), ("b4", 1)]);
        // The folded step is open until its newest call's result comes back.
        assert!(!c.steps[0].done);
    }

    #[test]
    fn a_helper_is_listed_with_its_own_spend_and_the_chat_waits_on_it() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s1.jsonl");
        std::fs::write(
            &main,
            format!(
                "{}\n{}\n",
                prompt("2026-11-08T10:00:00.000Z"),
                tool("task1", "Task", r#"{"subagent_type":"Explore","prompt":"SECRET PROMPT"}"#, "2026-11-08T10:00:01.000Z")
            ),
        )
        .unwrap();
        let subs = dir.path().join("s1").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        let sub = subs.join("agent-abc.jsonl");
        std::fs::write(
            &sub,
            format!("{}\n", tool("h1", "Grep", r#"{"pattern":"zzz"}"#, "2026-11-08T10:00:02.000Z")),
        )
        .unwrap();
        std::fs::write(subs.join("agent-abc.meta.json"), r#"{"agentType":"Explore","description":"Find the callers"}"#).unwrap();
        let mut s = Session::new("s1".into(), 1, "proj".into());
        let (facts, prices, stats) = (Facts::new(), PriceTable::seed(), ReadStats::default());
        let a = s.add_file(&main, false);
        let b = s.add_file(&sub, true);
        s.read_file(a, &facts, &prices, &stats).unwrap();
        s.read_file(b, &facts, &prices, &stats).unwrap();
        let c = s.chat(now_after(), i64::MAX / 4);
        assert_eq!(c.helpers.len(), 1);
        assert_eq!(c.helpers[0].name, "Find the callers");
        assert_eq!(c.helpers[0].tokens, 115);
        assert_eq!(c.doing.verb, "Waiting on a helper");
        assert_eq!(c.tokens, 230);
        assert!(c.steps.iter().any(|s| s.by.as_deref() == Some("Find the callers")));
        assert!(!format!("{c:?}").contains("SECRET PROMPT"));
    }

    #[test]
    fn the_last_chat_reads_from_the_end_of_a_big_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s9.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        let filler = format!(r#"{{"type":"attachment","pad":"{}"}}"#, "x".repeat(4000));
        for _ in 0..1200 {
            writeln!(f, "{filler}").unwrap();
        }
        writeln!(f, r#"{{"type":"custom-title","customTitle":"The big one"}}"#).unwrap();
        writeln!(f, "{}", tool("t", "Read", r#"{"file_path":"q"}"#, "2026-11-08T10:00:01.000Z")).unwrap();
        drop(f);
        let l = tail_last(&p, "s9", "proj", &Facts::new(), &PriceTable::seed(), &ReadStats::default()).unwrap();
        assert_eq!(l.title.as_deref(), Some("The big one"));
        assert_eq!(l.project, "app");
        assert!(l.ended_ms > 0);
    }

    #[test]
    fn the_newest_entry_time_skips_untimed_lines_and_a_cut_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let mut f = std::fs::File::create(&p).unwrap();
        // More than the tail it reads, so it starts mid-line.
        let filler = format!(r#"{{"type":"attachment","timestamp":"2026-11-08T09:00:00.000Z","pad":"{}"}}"#, "x".repeat(4000));
        for _ in 0..80 {
            writeln!(f, "{filler}").unwrap();
        }
        writeln!(f, "{}", tool("t", "Read", r#"{"file_path":"q"}"#, "2026-11-08T10:00:01.000Z")).unwrap();
        // A rename later on adds an untimed line: it does not make the chat newer.
        f.write_all(b"{\"type\":\"custom-title\",\"customTitle\":\"Renamed\"}\r\n").unwrap();
        drop(f);
        let want = crate::usage::time::parse_iso_ms("2026-11-08T10:00:01.000Z");
        assert_eq!(last_entry_ms(&p), want);

        let q = dir.path().join("none.jsonl");
        std::fs::write(&q, "{\"type\":\"custom-title\",\"customTitle\":\"x\"}\n").unwrap();
        assert_eq!(last_entry_ms(&q), None);
    }
}
