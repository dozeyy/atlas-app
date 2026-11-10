//! What the engine remembers about the chats that are running: one `Session` per chat,
//! one `FileTrack` per transcript file (the chat's own and each helper's), all fed one
//! line at a time through `facts`. Nothing here keeps a line; only the few facts.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::facts::{Desc, Facts, Parsed, PlanOp, Role, StepState, clean};
use super::model::{Doing, NowChat, NowFile, NowHelper, NowLast, NowStep, OpenCall, PlanCount};
use crate::search::mask::mask_secrets;
use crate::usage::naming::{AgentMeta, agent_id_of_stem, agent_name};
use crate::usage::time::now_ms;
use crate::usage::pricing::{Basis, Counts, PriceTable};
use crate::usage::reader::{Item, LINE_CAP, ReadStats, open_read_only, read_lines};

/// Tool calls kept per chat (the page shows the last `SHOWN_STEPS`).
const MAX_STEPS: usize = 24;
pub const SHOWN_STEPS: usize = 8;
const MAX_FILES: usize = 6;
const MAX_PENDING: usize = 32;
/// A helper that finished stays on the page this long, so its last move is seen.
pub const HELPER_LINGER_MS: i64 = 8_000;
/// A helper with no end signal and no new line for this long is taken to be gone (its chat was
/// closed, or it was killed without a word). There is no silence rule shorter than this: a long
/// build or test is quiet for minutes and is still the helper's work.
pub const HELPER_QUIET_MAX_MS: i64 = 20 * 60_000;
/// How often a running helper's sidecar is read again (its `finished` flag appears late).
const META_RECHECK_MS: i64 = 5_000;
/// The last calls the phase word is taken from.
const PHASE_CALLS: usize = 6;
/// Only these statuses in a `<task-notification>` mean the helper is over.
const ENDED_STATUSES: &[&str] = &["completed", "failed", "killed", "stopped"];
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
    /// Output tokens: a later line of the same reply replaces this one only with as much or more.
    output: u64,
}

struct Pend {
    id: String,
    desc: Desc,
}

/// A helper's own task list: only each step's state. Used when it has one that moves.
#[derive(Default)]
struct PlanTrack {
    steps: Vec<StepState>,
    /// A step was completed, or the active step changed after the list was first seen.
    moved: bool,
    /// A TaskUpdate named a task number that is not one of 1..=steps: the ids are not the plain
    /// 1..n this reads them as, so no step count is claimed (the page falls back to the typical run).
    irregular: bool,
}

impl PlanTrack {
    fn active(&self) -> Option<usize> {
        self.steps.iter().position(|s| *s == StepState::Active)
    }

    fn done(&self) -> u32 {
        self.steps.iter().filter(|s| **s == StepState::Done).count() as u32
    }

    /// Run `change` on the list and note whether that moved it.
    fn edit(&mut self, change: impl FnOnce(&mut Vec<StepState>)) {
        let had = !self.steps.is_empty();
        let before = self.active();
        change(&mut self.steps);
        if self.done() > 0 || (had && self.active() != before) {
            self.moved = true;
        }
    }

    fn apply(&mut self, op: PlanOp) {
        match op {
            PlanOp::Set(steps) => {
                // A whole new list (TodoWrite) replaces the tasks, so ids that did not fit the
                // old one say nothing about this one.
                self.irregular = false;
                self.edit(|s| *s = steps)
            }
            PlanOp::Add => self.edit(|s| s.push(StepState::Pending)),
            PlanOp::Update { id, status } => {
                // Task ids count up from 1 in the order they were created.
                let Some(i) = id.parse::<usize>().ok().and_then(|n| n.checked_sub(1)).filter(|i| *i < self.steps.len()) else {
                    self.irregular = true;
                    return;
                };
                let to = match status.as_str() {
                    "completed" => StepState::Done,
                    "in_progress" => StepState::Active,
                    "pending" => StepState::Pending,
                    _ => return,
                };
                self.edit(|s| {
                    if let Some(x) = s.get_mut(i) {
                        *x = to;
                    }
                });
            }
            PlanOp::Advance => self.edit(|s| {
                if let Some(i) = s.iter().position(|x| *x == StepState::Active) {
                    s[i] = StepState::Done;
                }
                if let Some(next) = s.iter().position(|x| *x == StepState::Pending) {
                    s[next] = StepState::Active;
                }
            }),
            PlanOp::Mark { done, start } => self.edit(|s| {
                for d in done {
                    if let Some(x) = s.get_mut(d - 1) {
                        *x = StepState::Done;
                    }
                }
                if let Some(x) = start.and_then(|j| s.get_mut(j - 1)) {
                    *x = StepState::Active;
                }
            }),
        }
    }

    /// "Step 3 of 6": two or more steps, and it has moved.
    fn count(&self) -> Option<PlanCount> {
        (self.steps.len() >= 2 && self.moved && !self.irregular).then(|| PlanCount { done: self.done(), total: self.steps.len() as u32 })
    }
}

/// The sidecar's own flags, beside what `AgentMeta` reads.
#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct MetaFlags {
    finished: Option<bool>,
    stopped_by_user: Option<bool>,
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
    agent_type: Option<String>,
    goal: Option<String>,
    meta_tries: u8,
    /// When the sidecar was last read, epoch ms (it is read again while the helper runs).
    meta_checked_ms: i64,
    /// The sidecar says `finished` (or the user stopped it): when it was written, epoch ms.
    meta_finished_ms: Option<i64>,
    /// Tool calls made in this file.
    calls: u32,
    /// The kind of each of the last `PHASE_CALLS` calls, and whether it ran tests.
    recent: VecDeque<(&'static str, bool)>,
    plan: PlanTrack,
    /// The model id and effort level this helper's newest lines say, if they say them.
    model: Option<String>,
    effort: Option<String>,
    /// The newest line's time before the one being read (the helper's last activity then).
    prev_ts: Option<i64>,
    /// Where a new run may have begun (a message to the helper after its turn ended).
    marks: VecDeque<RunMark>,
}

/// A point where a helper may have begun a new run: a message to it, or new calls, after its turn
/// ended. Whether it really did is decided when the row is built (`Session::run_of`), because the
/// parent's task-notification may be read after the helper's own line. A message that arrives
/// while the helper is mid-turn (the lead steering it) is not a mark: it is the same run.
struct RunMark {
    ts: i64,
    prev_ts: Option<i64>,
    /// Its previous turn had ended cleanly.
    after_end: bool,
    /// The file's totals at that point: the run's own are what has come since.
    calls: u32,
    tokens: u64,
    cost: f64,
    priced: usize,
}

/// How many run marks (and notices per helper) are kept.
const MAX_MARKS: usize = 16;

/// What the row shows of a helper's current run.
struct RunView {
    first_ts: Option<i64>,
    calls: u32,
    tokens: u64,
    cost: Option<f64>,
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
            agent_type: None,
            goal: None,
            meta_tries: 0,
            meta_checked_ms: 0,
            meta_finished_ms: None,
            calls: 0,
            recent: VecDeque::new(),
            plan: PlanTrack::default(),
            model: None,
            effort: None,
            prev_ts: None,
            marks: VecDeque::new(),
        }
    }

    /// Rows that have a price (cost known).
    fn priced(&self) -> usize {
        self.rows.len().saturating_sub(self.unpriced as usize)
    }

    /// Note that a new run may have begun here (see `RunMark`). Nothing to mark before the first call.
    fn mark_run(&mut self, at: Option<i64>, after_end: bool) {
        let Some(ts) = at else { return };
        if self.calls == 0 {
            return;
        }
        if self.marks.len() >= MAX_MARKS {
            // Make room by dropping a steering message before a certain restart.
            let at = self.marks.iter().position(|m| !m.after_end).unwrap_or(0);
            self.marks.remove(at);
        }
        self.marks.push_back(RunMark {
            ts,
            prev_ts: self.prev_ts,
            after_end,
            calls: self.calls,
            tokens: self.tokens,
            cost: self.cost,
            priced: self.priced(),
        });
    }

    fn reset(&mut self) {
        let (path, is_sub) = (self.path.clone(), self.is_sub);
        let (name, tries) = (self.name.take(), self.meta_tries);
        let (agent_type, goal) = (self.agent_type.take(), self.goal.take());
        *self = FileTrack::new(path, is_sub);
        self.name = name;
        self.meta_tries = tries;
        self.agent_type = agent_type;
        self.goal = goal;
    }

    /// When this file last had anything written to it (its newest line, or the file itself).
    fn last_activity_ms(&self) -> i64 {
        self.mtime_ms.max(self.last_ts.unwrap_or(0))
    }

    /// A helper's name, kind and goal come from the little file beside its transcript. It can
    /// show up a moment after the transcript does, so it is asked for a few times; once it is
    /// known the file is read again every `META_RECHECK_MS` only to see `finished` appear.
    fn refresh_meta(&mut self) {
        if !self.is_sub || self.meta_finished_ms.is_some() {
            return;
        }
        let need_name = self.name.is_none() && self.meta_tries < META_TRIES;
        let now = now_ms();
        if !need_name && (self.name.is_none() || now - self.meta_checked_ms < META_RECHECK_MS) {
            return;
        }
        if self.name.is_none() {
            self.meta_tries += 1;
        }
        self.meta_checked_ms = now;
        let mut buf = Vec::new();
        let p = self.path.with_extension("meta.json");
        let Ok(f) = open_read_only(&p) else { return };
        let written = f.metadata().ok().map(|m| mtime_ms(&m)).unwrap_or(now);
        if f.take(64 * 1024).read_to_end(&mut buf).is_err() {
            return;
        }
        if let Some(m) = AgentMeta::parse(&buf) {
            if self.name.is_none() {
                let (name, _) = agent_name(m.description.as_deref(), m.agent_type.as_deref(), None);
                self.name = Some(mask(&clean(&name, 40)));
            }
            if self.agent_type.is_none() {
                self.agent_type = m.agent_type.as_deref().map(|t| mask(&clean(t, 40)));
            }
            if self.goal.is_none() {
                self.goal = m.description.as_deref().map(|d| mask(&clean(d.lines().next().unwrap_or(d), 80))).filter(|g| !g.is_empty());
            }
        }
        if let Ok(flags) = serde_json::from_slice::<MetaFlags>(&buf)
            && (flags.finished == Some(true) || flags.stopped_by_user == Some(true))
        {
            self.meta_finished_ms = Some(written);
        }
    }

    fn note_call(&mut self, kind: &'static str, test: bool) {
        self.calls = self.calls.saturating_add(1);
        if self.recent.len() >= PHASE_CALLS {
            self.recent.pop_front();
        }
        self.recent.push_back((kind, test));
    }

    /// What the last few calls add up to, in one word or two.
    fn phase(&self) -> &'static str {
        let group = |k: &str| match k {
            "read" | "search" => Some(0usize),
            "edit" | "write" => Some(1),
            "run" => Some(2),
            "web" => Some(3),
            "helper" => Some(4),
            "plan" => Some(5),
            _ => None,
        };
        let mut counts = [0u32; 6];
        for (k, _) in &self.recent {
            if let Some(g) = group(k) {
                counts[g] += 1;
            }
        }
        let top = counts.iter().copied().max().unwrap_or(0);
        if top == 0 {
            return if self.calls == 0 { "Getting started" } else { "Working" };
        }
        // A tie goes to whichever of the tied kinds was called last.
        let win = self.recent.iter().rev().filter_map(|(k, _)| group(k)).find(|g| counts[*g] == top).unwrap_or(0);
        match win {
            0 => "Reading",
            1 => "Changing files",
            2 => {
                let last_run_tests = self.recent.iter().rev().find(|(k, _)| *k == "run").is_some_and(|(_, t)| *t);
                if last_run_tests { "Testing" } else { "Running commands" }
            }
            3 => "Looking things up",
            4 => "Waiting on a helper",
            _ => "Planning",
        }
    }

    /// The call it is waiting on, as a kind and one safe word.
    fn open_call(&self) -> Option<OpenCall> {
        let last = self.pending.last()?;
        let word = match last.desc.kind {
            "run" => match last.desc.target.as_deref() {
                Some(t) if t != "a command" => t.split_whitespace().next().unwrap_or("a command").to_string(),
                _ => "a command".to_string(),
            },
            "helper" => "a helper".to_string(),
            "web" => "the web".to_string(),
            _ => "a tool".to_string(),
        };
        Some(OpenCall { kind: last.desc.kind.to_string(), word })
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
    effort: Option<String>,
    prompt_ts: Option<i64>,
    steps: VecDeque<StepRec>,
    touched: Vec<NowFile>,
    /// Helpers a `<task-notification>` in this chat says are over: agent id -> when it was recorded.
    ended_helpers: HashMap<String, Vec<i64>>,
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
            effort: None,
            prompt_ts: None,
            steps: VecDeque::new(),
            touched: Vec::new(),
            ended_helpers: HashMap::new(),
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
            self.files[fi].refresh_meta();
            return Ok(());
        }
        let committed = read_lines(file, start, LINE_CAP, stats, |item, _| {
            if let Item::Line(l) = item {
                self.feed(fi, l, facts, prices);
            }
            true
        })?;
        self.files[fi].offset = committed;
        self.files[fi].refresh_meta();
        Ok(())
    }

    fn feed(&mut self, fi: usize, line: &[u8], facts: &Facts, prices: &PriceTable) {
        let Some(p) = facts.parse(line) else { return };
        let is_sub = self.files[fi].is_sub;
        if let Some(t) = p.ts_ms {
            let f = &mut self.files[fi];
            f.prev_ts = f.last_ts;
            f.first_ts.get_or_insert(t);
            f.last_ts = Some(f.last_ts.map_or(t, |o| o.max(t)));
        }
        if let Some(c) = &p.cwd
            && (!is_sub || self.cwd.is_none())
        {
            self.cwd = Some(c.clone());
        }
        for n in &p.notices {
            if ENDED_STATUSES.contains(&n.status.as_str()) {
                // Every notice is kept and the newest wins: a helper resumed after one notice and
                // then killed or failed has a newer one, and an older one alone would leave it
                // looking alive.
                let at = p.ts_ms.unwrap_or_else(now_ms);
                let log = self.ended_helpers.entry(n.agent_id.clone()).or_default();
                if log.len() >= MAX_MARKS {
                    log.remove(0);
                }
                log.push(at);
            }
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
                    let was_ended = self.files[fi].ended;
                    self.files[fi].ended = false;
                    if !is_sub {
                        self.prompt_ts = p.ts_ms.or(self.prompt_ts);
                    } else {
                        // A message to a helper whose turn had ended is a new run; one while it
                        // is mid-turn (the lead steering it, a reminder, a notification) is the
                        // same run, unless the parent recorded the helper's end in between (a
                        // killed helper has no clean end line). `run_of` decides.
                        self.files[fi].mark_run(p.ts_ms, was_ended);
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
        if is_sub && p.effort.is_some() {
            self.files[fi].effort = p.effort.clone();
        }
        let mut repeated = false;
        let mut keyed = false;
        // The line parser only gives usage for a line with both `message.id` and `requestId`
        // (one reply = one `id|requestId`, as in the ledger and tools/recount.py); 0 of 255,131
        // usage lines on Will's PC lack either. An empty key is never counted, so a replayed
        // unkeyed line can never be added twice.
        if let Some(m) = p.usage.filter(|m| !m.key.is_empty()) {
            // A reply written again later with less output (zeroed counts) is a replay: skip it.
            let replay = self.files[fi].rows.get(&m.key).is_some_and(|old| m.output < old.output);
            if !replay && !is_sub && !m.model.is_empty() {
                // Model and effort go together: a reply with no effort clears the old one.
                self.model = Some(m.model.clone());
                self.effort = m.effort.clone();
            }
            // A helper's own model: the newest real id its lines name (not "<synthetic>"). Its
            // effort is the newest line that says one (above).
            if !replay && is_sub && m.model.starts_with("claude-") {
                self.files[fi].model = Some(m.model.clone());
            }
            keyed = true;
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
            let row = Row { tokens: m.input + m.output + m.cw5m + m.cw1h, cost, output: m.output };
            let f = &mut self.files[fi];
            let key = m.key.clone();
            // Same rule as the ledger: a replayed line with less output never replaces the reply.
            if replay {
                repeated = true;
            } else {
                if let Some(old) = f.rows.insert(key, Row { tokens: row.tokens, cost: row.cost, output: row.output }) {
                    repeated = true;
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
        }
        let ts = p.ts_ms.unwrap_or(0);
        // A new message of the helper after its turn ended (a lead's message reaches it as a
        // line the reader skips, so this is how a resume shows): possibly a new run. A repeat of
        // a message already counted is not new, and a line with no message id (no telling a repeat
        // from a new message) is not a restart either.
        if is_sub && self.files[fi].ended && keyed && !repeated {
            self.files[fi].mark_run(p.ts_ms, true);
        }
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
            f.note_call(t.desc.kind, t.test);
            if let Some(op) = t.plan {
                f.plan.apply(op);
            }
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
            effort: self.effort.clone(),
            ended_ms: self.newest_write_ms(),
            tokens: Some(self.files.iter().map(|f| f.tokens).sum()),
        }
    }

    /// When this helper ended, if it did. Three signals, the earliest wins: its parent recorded a
    /// task-notification for it, its sidecar says `finished`, or its last assistant line ended
    /// the turn with no call open. A signal older than the helper's newest line does not count:
    /// a helper that was sent another message after finishing is working again.
    fn finished_at(&self, f: &FileTrack) -> Option<i64> {
        let newest = f.last_ts;
        let live = |sig: Option<i64>| sig.filter(|t| newest.is_none_or(|n| n <= *t + 2_000));
        let by_line = (f.ended && f.pending.is_empty()).then(|| f.last_ts.unwrap_or(f.mtime_ms));
        let notice = self.ended_helpers.get(&f.agent_id).and_then(|log| log.iter().max().copied());
        [live(notice), live(f.meta_finished_ms), by_line].into_iter().flatten().min()
    }

    /// This helper's current run: the one that began at its newest real restart. A mark is a
    /// restart when the helper's turn had ended before it, or the parent recorded a notice for the
    /// helper between its last activity and the mark. A helper resumed hours later starts its
    /// clock, calls and spend over; one the lead only steered mid-turn keeps going as one run.
    fn run_of(&self, f: &FileTrack) -> RunView {
        let notices = self.ended_helpers.get(&f.agent_id);
        let restart = |m: &RunMark| {
            m.after_end
                || notices.is_some_and(|log| log.iter().any(|n| m.prev_ts.is_none_or(|p| *n + 2_000 >= p) && *n <= m.ts))
        };
        match f.marks.iter().rev().find(|m| restart(m)) {
            Some(m) => RunView {
                first_ts: Some(m.ts),
                calls: f.calls.saturating_sub(m.calls),
                tokens: f.tokens.saturating_sub(m.tokens),
                cost: (f.priced() > m.priced).then(|| (f.cost - m.cost).max(0.0)),
            },
            None => RunView {
                first_ts: f.first_ts,
                calls: f.calls,
                tokens: f.tokens,
                cost: (f.rows.len() > f.unpriced as usize).then_some(f.cost),
            },
        }
    }

    /// A helper is running until it ends (`finished_at`); with no end signal it is taken to be
    /// gone only after `HELPER_QUIET_MAX_MS` of silence.
    fn helper_running(&self, f: &FileTrack, now: i64) -> bool {
        f.is_sub && self.finished_at(f).is_none() && now - f.last_activity_ms() <= HELPER_QUIET_MAX_MS
    }

    /// Is file `fi` a helper that is still at work?
    pub fn is_running_helper(&self, fi: usize, now: i64) -> bool {
        self.files.get(fi).is_some_and(|f| self.helper_running(f, now))
    }

    /// Some helper of this chat is still at work (it keeps the chat followed through a long,
    /// quiet build).
    pub fn has_running_helper(&self, now: i64) -> bool {
        self.files.iter().any(|f| self.helper_running(f, now))
    }

    /// Look at the sidecars of the helpers that are running (rate-limited per helper).
    pub fn refresh_helper_meta(&mut self, now: i64) {
        let running: Vec<bool> = self.files.iter().map(|f| self.helper_running(f, now)).collect();
        for (f, run) in self.files.iter_mut().zip(running) {
            if run {
                f.refresh_meta();
            }
        }
    }

    fn helper_view(&self, f: &FileTrack) -> NowHelper {
        let done = self.finished_at(f).is_some();
        let doing = if done {
            None
        } else {
            Some(doing_of(&f.pending).unwrap_or_else(|| Doing { kind: "think".into(), verb: "Thinking".into(), target: None }))
        };
        let run = self.run_of(f);
        NowHelper {
            id: f.agent_id.clone(),
            name: f.name.clone().unwrap_or_else(|| "Helper".to_string()),
            model: f.model.clone(),
            effort: f.effort.clone(),
            doing,
            tokens: run.tokens,
            cost_usd: run.cost,
            started_ms: run.first_ts,
            done,
            agent_type: f.agent_type.clone(),
            goal: f.goal.clone(),
            tool_calls: run.calls,
            plan: f.plan.count(),
            typical: None,
            phase: if run.calls == 0 { "Getting started" } else { f.phase() }.to_string(),
            last_line_ms: Some(f.last_activity_ms()).filter(|t| *t > 0),
            open_call: if done { None } else { f.open_call() },
        }
    }

    pub fn chat(&self, now: i64) -> NowChat {
        let main = self.main();
        // Running ones, and ones that finished within the last few seconds.
        let helpers: Vec<NowHelper> = self
            .files
            .iter()
            .filter(|f| {
                f.is_sub
                    && match self.finished_at(f) {
                        None => self.helper_running(f, now),
                        Some(t) => now - t <= HELPER_LINGER_MS,
                    }
            })
            .map(|f| self.helper_view(f))
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
            // The chat ended its own turn but its helpers are still at work (they were started to
            // run on their own): it is still working, on them. It waits for you only once they are done.
            if out > 0 {
                let verb = if out == 1 { "Waiting on a helper".to_string() } else { format!("Waiting on {out} helpers") };
                wait_doing("helper", &verb)
            } else {
                wait_doing("wait", "Waiting for you")
            }
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
            effort: self.effort.clone(),
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
    fn effort_follows_the_newest_reply_and_a_zeroed_replay_does_not_count() {
        let reply = |out: u64, effort: &str| {
            format!(
                r#"{{"type":"assistant","timestamp":"2026-11-08T10:00:01.000Z","requestId":"rq"{effort},"message":{{"id":"mq","model":"claude-sonnet-5-5","stop_reason":"end_turn","content":[{{"type":"text","text":"x"}}],"usage":{{"input_tokens":3,"output_tokens":{out},"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}}}}"#
            )
        };
        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            reply(40, r#","effort":"high","perTurnEffort":"xhigh""#),
            reply(0, r#","effort":"high""#), // the same reply written again with zeroed counts
        ]);
        let c = s.chat(now_after());
        assert_eq!(c.tokens, 3 + 40);
        assert_eq!(c.model.as_deref(), Some("claude-sonnet-5-5"));
        assert_eq!(c.effort.as_deref(), Some("xhigh"));
        let (_d, s) = session(&[prompt("2026-11-08T10:00:00.000Z"), reply(5, "")]);
        assert_eq!(s.chat(now_after()).effort, None);
    }

    #[test]
    fn a_chat_in_the_middle_of_work_shows_its_tool_and_totals() {
        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            tool("t1", "Read", r#"{"file_path":"C:\\p\\app\\src\\a.ts"}"#, "2026-11-08T10:00:01.000Z"),
            result("t1"),
            tool("t2", "Edit", r#"{"file_path":"C:\\p\\app\\src\\a.ts","old_string":"A","new_string":"B"}"#, "2026-11-08T10:00:02.000Z"),
        ]);
        let c = s.chat(now_after());
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
        let c = s.chat(now_after());
        assert_eq!(c.doing.verb, "Reading 3 files");
        assert_eq!(c.doing.target, None);

        let (_d, s) = session(&[
            prompt("2026-11-08T10:00:00.000Z"),
            tool("a", "Bash", r#"{"command":"cargo test"}"#, "2026-11-08T10:00:01.000Z"),
            result("a"),
            end("2026-11-08T10:00:09.000Z"),
        ]);
        let c = s.chat(now_after());
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
        let c = s.chat(now_after());
        assert_eq!(c.state, "waiting");
        assert!(c.steps[0].done);
    }

    #[test]
    fn a_repeated_message_counts_once_and_the_last_line_wins() {
        let a = tool("t1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:01.000Z");
        let b = a.replace(r#""output_tokens":5"#, r#""output_tokens":50"#);
        let (_d, s) = session(&[prompt("2026-11-08T10:00:00.000Z"), a, b]);
        let c = s.chat(now_after());
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
        let c = s.chat(now_after());
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
        let c = s.chat(now_after());
        assert_eq!(c.helpers.len(), 1);
        assert_eq!(c.helpers[0].name, "Find the callers");
        assert_eq!(c.helpers[0].tokens, 115);
        assert_eq!(c.doing.verb, "Waiting on a helper");
        assert_eq!(c.tokens, 230);
        assert!(c.steps.iter().any(|s| s.by.as_deref() == Some("Find the callers")));
        assert!(!format!("{c:?}").contains("SECRET PROMPT"));
    }

    #[test]
    fn a_reply_without_its_ids_is_never_counted_twice() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s7.jsonl");
        // Twice the same reply with no requestId, then twice with no message id.
        let line = |id: &str, req: &str| {
            format!(
                r#"{{"type":"assistant","timestamp":"2026-11-08T10:00:01.000Z"{req},"message":{{{id}"model":"claude-sonnet-5-5","stop_reason":"end_turn","content":[{{"type":"text","text":"x"}}],"usage":{{"input_tokens":3,"output_tokens":40,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}}}}"#
            )
        };
        let body = [line(r#""id":"m1","#, ""), line(r#""id":"m1","#, ""), line("", r#","requestId":"r1""#), line("", r#","requestId":"r1""#)].join("\n");
        std::fs::write(&p, body + "\n").unwrap();
        let mut s = Session::new("s7".into(), 1, "proj".into());
        let (facts, prices, stats) = (Facts::new(), PriceTable::seed(), ReadStats::default());
        let a = s.add_file(&p, false);
        s.read_file(a, &facts, &prices, &stats).unwrap();
        // Same rule as the ledger and the recount: a line missing either id is not a countable reply.
        assert_eq!(s.chat(now_after()).tokens, 0);
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

    // ---- Helpers at work: the live tracker's facts (spec criteria 21-24) ----

    /// A chat with one helper (`agent-abc`): the chat's own lines, the helper's lines, and the
    /// helper's sidecar. Timestamps are old on purpose; the files themselves are fresh.
    fn with_helper(main_lines: &[String], sub_lines: &[String], meta: &str) -> (tempfile::TempDir, Session) {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("s1.jsonl");
        let mut body = vec![
            prompt("2026-11-08T10:00:00.000Z"),
            tool("task1", "Task", r#"{"subagent_type":"Explore","prompt":"x"}"#, "2026-11-08T10:00:01.000Z"),
        ];
        body.extend(main_lines.iter().cloned());
        std::fs::write(&main, body.join("\n") + "\n").unwrap();
        let subs = dir.path().join("s1").join("subagents");
        std::fs::create_dir_all(&subs).unwrap();
        let sub = subs.join("agent-abc.jsonl");
        std::fs::write(&sub, sub_lines.join("\n") + "\n").unwrap();
        std::fs::write(subs.join("agent-abc.meta.json"), meta).unwrap();
        let mut s = Session::new("s1".into(), 1, "proj".into());
        let (facts, prices, stats) = (Facts::new(), PriceTable::seed(), ReadStats::default());
        let a = s.add_file(&main, false);
        let b = s.add_file(&sub, true);
        s.read_file(a, &facts, &prices, &stats).unwrap();
        s.read_file(b, &facts, &prices, &stats).unwrap();
        (dir, s)
    }

    const META: &str = r#"{"agentType":"Explore","description":"Find the callers"}"#;

    fn notice(status: &str, ts: &str) -> String {
        format!(
            r#"{{"type":"user","timestamp":"{ts}","message":{{"role":"user","content":"<task-notification><task-id>abc</task-id><status>{status}</status></task-notification>"}}}}"#
        )
    }

    fn running(s: &Session, now: i64) -> usize {
        s.chat(now).helpers.iter().filter(|h| !h.done).count()
    }

    #[test]
    fn a_helper_in_a_long_quiet_build_is_still_running() {
        let (_d, s) = with_helper(
            &[],
            &[
                tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
                result("h1"),
                tool("h2", "Bash", r#"{"command":"cargo build --release"}"#, "2026-11-08T10:00:03.000Z"),
            ],
            META,
        );
        let t = now_after();
        assert_eq!(running(&s, t), 1);
        // 90 s with no write, the build still open: it is not done (the old 30 s rule said it was).
        assert_eq!(running(&s, t + 90_000), 1);
        let h = &s.chat(t + 90_000).helpers[0];
        assert_eq!(h.open_call.as_ref().map(|o| (o.kind.as_str(), o.word.as_str())), Some(("run", "cargo")));
        // Only a very long silence with no end signal writes it off.
        assert!(s.chat(t + HELPER_QUIET_MAX_MS + 60_000).helpers.is_empty());
    }

    #[test]
    fn a_task_notification_ends_a_helper() {
        let (_d, s) = with_helper(
            &[notice("completed", "2026-11-08T10:05:00.000Z")],
            &[tool("h2", "Bash", r#"{"command":"cargo build"}"#, "2026-11-08T10:00:03.000Z")],
            META,
        );
        assert_eq!(running(&s, now_after()), 0);
        // Past the linger window it is gone from the list.
        assert!(s.chat(now_after() + HELPER_LINGER_MS + 1_000).helpers.is_empty());
    }

    #[test]
    fn a_sidecar_that_says_finished_ends_a_helper() {
        let (_d, s) = with_helper(
            &[],
            &[tool("h2", "Bash", r#"{"command":"cargo build"}"#, "2026-11-08T10:00:03.000Z")],
            r#"{"agentType":"Explore","description":"Find the callers","finished":true}"#,
        );
        assert_eq!(running(&s, now_after()), 0);
    }

    #[test]
    fn end_turn_with_nothing_open_ends_a_helper_but_a_later_line_resumes_it() {
        let ended = [
            tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
            result("h1"),
            end("2026-11-08T10:00:05.000Z"),
        ];
        let (_d, s) = with_helper(&[], &ended, META);
        assert_eq!(running(&s, now_after()), 0);

        // The same helper sent another message after it finished: it is working again.
        let mut more = ended.to_vec();
        more.push(tool("h2", "Edit", r#"{"file_path":"y","old_string":"a","new_string":"b"}"#, "2026-11-08T10:01:00.000Z"));
        let (_d, s) = with_helper(&[notice("completed", "2026-11-08T10:00:06.000Z")], &more, META);
        assert_eq!(running(&s, now_after()), 1);
    }

    #[test]
    fn a_chat_that_ended_its_turn_is_still_working_while_its_helpers_are() {
        // The chat started helpers that run on their own, got the starts back and ended its turn.
        let parent_done = [result("task1"), end("2026-11-08T10:00:09.000Z")];
        let working = [tool("h1", "Bash", r#"{"command":"cargo build"}"#, "2026-11-08T10:00:03.000Z")];
        let (_d, s) = with_helper(&parent_done, &working, META);
        let c = s.chat(now_after());
        assert_eq!((c.state.as_str(), c.doing.verb.as_str(), c.doing.kind.as_str()), ("working", "Waiting on a helper", "helper"));
        assert_eq!(c.helpers.len(), 1);
        // Once the helper is done the chat waits for you again.
        let (_d, s) = with_helper(
            // (the notice is a user line in the chat, so the chat's own end comes after it)
            &[result("task1"), notice("completed", "2026-11-08T10:00:10.000Z"), end("2026-11-08T10:00:11.000Z")],
            &working,
            META,
        );
        let c = s.chat(now_after());
        assert_eq!((c.state.as_str(), c.doing.verb.as_str()), ("waiting", "Waiting for you"));
    }

    #[test]
    fn a_helper_resumed_then_killed_is_ended_by_its_newest_notice() {
        let lines = [
            tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
            result("h1"),
            end("2026-11-08T10:00:05.000Z"),
            // Sent another message half an hour later, working again...
            prompt("2026-11-08T10:30:00.000Z"),
            tool("h2", "Bash", r#"{"command":"cargo build"}"#, "2026-11-08T10:30:10.000Z"),
        ];
        // ...with only the first notice on record it is running.
        let (_d, s) = with_helper(&[notice("completed", "2026-11-08T10:00:06.000Z")], &lines, META);
        assert_eq!(running(&s, now_after()), 1);
        // The second run was killed with no clean end line: the newer notice ends it.
        let both = [notice("completed", "2026-11-08T10:00:06.000Z"), notice("killed", "2026-11-08T10:31:00.000Z")];
        let (_d, s) = with_helper(&both, &lines, META);
        assert_eq!(running(&s, now_after()), 0);
        // Notices read in any order: the newest is kept.
        let swapped = [notice("killed", "2026-11-08T10:31:00.000Z"), notice("completed", "2026-11-08T10:00:06.000Z")];
        let (_d, s) = with_helper(&swapped, &lines, META);
        assert_eq!(running(&s, now_after()), 0);
    }

    #[test]
    fn a_resumed_helper_starts_its_clock_calls_and_spend_over() {
        let (_d, s) = with_helper(
            &[],
            &[
                prompt("2026-11-08T10:00:01.000Z"),
                tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
                result("h1"),
                tool("h2", "Read", r#"{"file_path":"y"}"#, "2026-11-08T10:00:03.000Z"),
                result("h2"),
                end("2026-11-08T10:00:05.000Z"),
                // A day later it is sent another message.
                prompt("2026-11-09T10:00:00.000Z"),
                tool("h3", "Grep", r#"{"pattern":"z"}"#, "2026-11-09T10:00:10.000Z"),
            ],
            META,
        );
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!(h.tool_calls, 1);
        assert_eq!(h.started_ms, crate::usage::time::parse_iso_ms("2026-11-09T10:00:00.000Z"));
        assert_eq!(h.tokens, 115);
        assert_eq!(h.phase, "Reading");
        assert!(!h.done);
    }

    #[test]
    fn messages_to_a_helper_mid_turn_do_not_restart_its_run() {
        // The lead steers a working helper again and again (and reminders arrive as text lines):
        // nothing ended in between, so it is one run with every call counted.
        let (_d, s) = with_helper(
            &[],
            &[
                prompt("2026-11-08T10:00:01.000Z"),
                tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
                result("h1"),
                prompt("2026-11-08T10:10:00.000Z"),
                tool("h2", "Read", r#"{"file_path":"y"}"#, "2026-11-08T10:10:05.000Z"),
                prompt("2026-11-08T10:20:00.000Z"),
                tool("h3", "Read", r#"{"file_path":"z"}"#, "2026-11-08T10:20:05.000Z"),
            ],
            META,
        );
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!(h.tool_calls, 3);
        assert_eq!(h.started_ms, crate::usage::time::parse_iso_ms("2026-11-08T10:00:01.000Z"));
        assert_eq!(h.tokens, 3 * 115);
    }

    #[test]
    fn a_helper_resumed_by_a_line_the_reader_skips_still_starts_a_new_run() {
        // The lead's message reaches a finished helper as an injected (meta) user line, and the
        // helper may answer with a line of text before it makes a call.
        let meta = r#"{"type":"user","isMeta":true,"timestamp":"2026-11-08T10:30:00.000Z","message":{"role":"user","content":"more work"}}"#.to_string();
        let said = r#"{"type":"assistant","timestamp":"2026-11-08T10:30:05.000Z","requestId":"rsaid","message":{"id":"msaid","model":"claude-opus-5-5","stop_reason":null,"content":[{"type":"text","text":"on it"}],"usage":{"input_tokens":1,"output_tokens":1}}}"#.to_string();
        let (_d, s) = with_helper(
            &[],
            &[
                prompt("2026-11-08T10:00:01.000Z"),
                tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
                result("h1"),
                tool("h2", "Read", r#"{"file_path":"y"}"#, "2026-11-08T10:00:03.000Z"),
                result("h2"),
                end("2026-11-08T10:00:05.000Z"),
                meta,
                said,
                tool("h3", "Bash", r#"{"command":"cargo build"}"#, "2026-11-08T10:30:10.000Z"),
            ],
            META,
        );
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!(h.tool_calls, 1);
        assert_eq!(h.started_ms, crate::usage::time::parse_iso_ms("2026-11-08T10:30:05.000Z"));
        assert!(!h.done);
    }

    #[test]
    fn a_helper_killed_with_no_end_line_and_then_resumed_starts_a_new_run_whatever_is_read_first() {
        let sub = [
            prompt("2026-11-08T10:00:01.000Z"),
            tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
            tool("h2", "Read", r#"{"file_path":"y"}"#, "2026-11-08T10:00:03.000Z"),
            // No end line: it was killed. The lead sends it a message a day later.
            prompt("2026-11-09T10:00:00.000Z"),
            tool("h3", "Grep", r#"{"pattern":"z"}"#, "2026-11-09T10:00:10.000Z"),
        ];
        // The parent's notice is read after the helper's own lines (the files are read in either order).
        let (d, mut s) = with_helper(&[], &sub, META);
        assert_eq!(s.chat(now_after()).helpers[0].tool_calls, 3);
        let main = d.path().join("s1.jsonl");
        let mut f = std::fs::OpenOptions::new().append(true).open(&main).unwrap();
        writeln!(f, "{}", notice("killed", "2026-11-08T10:05:00.000Z")).unwrap();
        drop(f);
        s.read_file(0, &Facts::new(), &PriceTable::seed(), &ReadStats::default()).unwrap();
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!(h.tool_calls, 1);
        assert_eq!(h.started_ms, crate::usage::time::parse_iso_ms("2026-11-09T10:00:00.000Z"));
        assert!(!h.done);
    }

    #[test]
    fn task_ids_that_are_not_one_to_n_give_no_step_count() {
        let create = |id: &str, ts: &str| tool(id, "TaskCreate", r#"{"subject":"a"}"#, ts);
        let update = |id: &str, n: &str, ts: &str| tool(id, "TaskUpdate", &format!(r#"{{"taskId":"{n}","status":"completed"}}"#), ts);
        let (_d, s) = with_helper(
            &[],
            &[
                create("c1", "2026-11-08T10:00:02.000Z"),
                create("c2", "2026-11-08T10:00:03.000Z"),
                update("u1", "1", "2026-11-08T10:00:04.000Z"),
                // A number past the list: the ids are not the plain 1..n.
                update("u2", "7", "2026-11-08T10:00:05.000Z"),
            ],
            META,
        );
        assert_eq!(s.chat(now_after()).helpers[0].plan, None);
        let (_d, s) = with_helper(
            &[],
            &[
                create("c1", "2026-11-08T10:00:02.000Z"),
                create("c2", "2026-11-08T10:00:03.000Z"),
                update("u1", "abc", "2026-11-08T10:00:04.000Z"),
                update("u2", "1", "2026-11-08T10:00:05.000Z"),
            ],
            META,
        );
        assert_eq!(s.chat(now_after()).helpers[0].plan, None);
        // A whole new list (TodoWrite) after the odd ids starts clean: the count is back.
        let todos = |a: &str, b: &str| format!(r#"{{"todos":[{{"content":"A","status":"{a}"}},{{"content":"B","status":"{b}"}}]}}"#);
        let (_d, s) = with_helper(
            &[],
            &[
                create("c1", "2026-11-08T10:00:02.000Z"),
                update("u1", "9", "2026-11-08T10:00:03.000Z"),
                tool("p1", "TodoWrite", &todos("in_progress", "pending"), "2026-11-08T10:00:04.000Z"),
                tool("p2", "TodoWrite", &todos("completed", "in_progress"), "2026-11-08T10:00:05.000Z"),
            ],
            META,
        );
        assert_eq!(s.chat(now_after()).helpers[0].plan, Some(PlanCount { done: 1, total: 2 }));
    }

    #[test]
    fn an_extra_line_with_no_message_id_after_a_helper_ended_is_not_a_new_run() {
        let stray = r#"{"type":"assistant","timestamp":"2026-11-08T10:00:06.000Z","message":{"role":"assistant","content":[{"type":"text","text":"x"}]}}"#.to_string();
        let (_d, s) = with_helper(
            &[],
            &[
                prompt("2026-11-08T10:00:01.000Z"),
                tool("h1", "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z"),
                result("h1"),
                tool("h2", "Read", r#"{"file_path":"y"}"#, "2026-11-08T10:00:03.000Z"),
                result("h2"),
                end("2026-11-08T10:00:05.000Z"),
                stray,
            ],
            META,
        );
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!(h.tool_calls, 2);
        assert_eq!(h.started_ms, crate::usage::time::parse_iso_ms("2026-11-08T10:00:01.000Z"));
    }

    #[test]
    fn a_plan_that_moves_gives_a_step_count_and_one_that_never_moves_does_not() {
        let todos = |a: &str, b: &str, c: &str| {
            format!(r#"{{"todos":[{{"content":"A","status":"{a}"}},{{"content":"B","status":"{b}"}},{{"content":"C","status":"{c}"}}]}}"#)
        };
        let plan = |input: String, ts: &str, id: &str| tool(id, "TodoWrite", &input, ts);
        // Written once and never touched: not a plan worth showing.
        let (_d, s) = with_helper(&[], &[plan(todos("in_progress", "pending", "pending"), "2026-11-08T10:00:02.000Z", "p1")], META);
        assert_eq!(s.chat(now_after()).helpers[0].plan, None);
        // One step done: "1 of 3".
        let (_d, s) = with_helper(
            &[],
            &[
                plan(todos("in_progress", "pending", "pending"), "2026-11-08T10:00:02.000Z", "p1"),
                plan(todos("completed", "in_progress", "pending"), "2026-11-08T10:00:09.000Z", "p2"),
            ],
            META,
        );
        assert_eq!(s.chat(now_after()).helpers[0].plan, Some(PlanCount { done: 1, total: 3 }));
        // A single-step list is never a plan.
        let one = r#"{"todos":[{"content":"A","status":"completed"}]}"#.to_string();
        let (_d, s) = with_helper(&[], &[plan(one, "2026-11-08T10:00:02.000Z", "p1")], META);
        assert_eq!(s.chat(now_after()).helpers[0].plan, None);
    }

    #[test]
    fn update_plan_and_task_tools_move_the_count_with_one_based_numbers() {
        let items = r#"{"items":[{"content":"a","status":"in_progress"},{"content":"b","status":"pending"},{"content":"c","status":"pending"}]}"#;
        let (_d, s) = with_helper(
            &[],
            &[
                tool("u1", "mcp__ccd_turn__update_plan", items, "2026-11-08T10:00:02.000Z"),
                tool("u2", "mcp__ccd_turn__update_plan", r#"{"advance":true}"#, "2026-11-08T10:00:03.000Z"),
                tool("u3", "mcp__ccd_turn__update_plan", r#"{"done":[2],"start":3}"#, "2026-11-08T10:00:04.000Z"),
            ],
            META,
        );
        assert_eq!(s.chat(now_after()).helpers[0].plan, Some(PlanCount { done: 2, total: 3 }));

        let (_d, s) = with_helper(
            &[],
            &[
                tool("c1", "TaskCreate", r#"{"subject":"a"}"#, "2026-11-08T10:00:02.000Z"),
                tool("c2", "TaskCreate", r#"{"subject":"b"}"#, "2026-11-08T10:00:03.000Z"),
                tool("c3", "TaskUpdate", r#"{"taskId":"1","status":"completed"}"#, "2026-11-08T10:00:04.000Z"),
            ],
            META,
        );
        assert_eq!(s.chat(now_after()).helpers[0].plan, Some(PlanCount { done: 1, total: 2 }));
    }

    #[test]
    fn a_helper_reports_its_tool_calls_and_what_it_is_up_to() {
        let reads: Vec<String> =
            (0..4).map(|i| tool(&format!("r{i}"), "Read", r#"{"file_path":"x"}"#, "2026-11-08T10:00:02.000Z")).collect();
        let (_d, s) = with_helper(&[], &reads, META);
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!((h.tool_calls, h.phase.as_str()), (4, "Reading"));
        assert_eq!(h.agent_type.as_deref(), Some("Explore"));
        assert_eq!(h.goal.as_deref(), Some("Find the callers"));

        let (_d, s) = with_helper(&[], &[tool("t1", "Bash", r#"{"command":"cargo test --workspace"}"#, "2026-11-08T10:00:02.000Z")], META);
        assert_eq!(s.chat(now_after()).helpers[0].phase, "Testing");
        let (_d, s) = with_helper(&[], &[tool("t1", "Bash", r#"{"command":"ls -la"}"#, "2026-11-08T10:00:02.000Z")], META);
        assert_eq!(s.chat(now_after()).helpers[0].phase, "Running commands");
        // Nothing yet: a sentinel, never an empty word.
        let (_d, s) = with_helper(&[], &[prompt("2026-11-08T10:00:02.000Z")], META);
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!((h.tool_calls, h.phase.as_str()), (0, "Getting started"));
    }

    #[test]
    fn a_helper_carries_its_own_model_and_effort_only_when_its_lines_say_so() {
        let at = |s: &str| tool("r1", "Read", r#"{"file_path":"x"}"#, s);
        let with_effort = |l: String, e: &str| l.replacen(r#"{"type":"assistant","#, &format!(r#"{{"type":"assistant","effort":"{e}","#), 1);
        // No effort on any line: model is known, effort stays empty (never a default).
        let (_d, s) = with_helper(&[], &[at("2026-11-08T10:00:02.000Z")], META);
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!((h.model.as_deref(), h.effort.as_deref()), (Some("claude-opus-5-5"), None));
        // The newest line's effort wins.
        let lines = [with_effort(at("2026-11-08T10:00:02.000Z"), "medium"), with_effort(at("2026-11-08T10:00:03.000Z"), "high")];
        let (_d, s) = with_helper(&[], &lines, META);
        assert_eq!(s.chat(now_after()).helpers[0].effort.as_deref(), Some("high"));
        // The chat's own model never leaks onto a helper that has not said one.
        let (_d, s) = with_helper(&[], &[prompt("2026-11-08T10:00:02.000Z")], META);
        let h = &s.chat(now_after()).helpers[0];
        assert_eq!((h.model.as_deref(), h.effort.as_deref()), (None, None));
    }

    #[test]
    fn the_tracker_facts_carry_no_command_text_or_plan_text() {
        let (_d, s) = with_helper(
            &[],
            &[
                tool("t1", "Bash", r#"{"command":"curl http://secret.example/TOPSECRETCMD"}"#, "2026-11-08T10:00:02.000Z"),
                tool("p1", "TodoWrite", r#"{"todos":[{"content":"TOPSECRETPLAN","status":"in_progress"},{"content":"b","status":"pending"}]}"#, "2026-11-08T10:00:03.000Z"),
            ],
            META,
        );
        let h = &s.chat(now_after()).helpers[0];
        assert!(!format!("{h:?}").contains("TOPSECRET"));
    }
}
