//! Claude Code's plugin command, run safely (D4, D5, D7).
//!
//! Every call: quiet (no console window), a time limit, stdout capped at 8 MB, only `--json`
//! output parsed. Nothing downloaded is run by Atlas, and no call ever carries `-y` or
//! `--accept-command`. Debug builds refuse to start the command when the config folder is the
//! real one, listing calls included (they write into the folder too).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::connect::CliChoice;
use crate::paths::{ConfigRoot, ConfigSource};

pub const STDOUT_CAP: usize = 8 * 1024 * 1024;
const LIST: Duration = Duration::from_secs(30);
const MARKET: Duration = Duration::from_secs(120);
const INSTALL: Duration = Duration::from_secs(180);
const OTHER: Duration = Duration::from_secs(30);

pub const NO_CLI: &str = "Needs Claude Code's command to install plugins.";
pub const COMMAND_SOURCE: &str = "This plugin installs by running a command. Atlas does not run those.";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliError {
    /// Claude Code's command is not on this computer.
    NoCli,
    /// Atlas refused to start it (the real folder in a development build, a bad argument).
    Refused(String),
    /// It could not be started.
    Spawn(String),
    TimedOut,
    TooMuch,
    /// Its output had no JSON in it.
    NoJson(String),
}

impl CliError {
    /// One plain sentence.
    pub fn message(&self) -> String {
        match self {
            CliError::NoCli => NO_CLI.into(),
            CliError::Refused(m) | CliError::Spawn(m) => m.clone(),
            CliError::TimedOut => "Claude Code's command took too long. Nothing was changed by Atlas; check the plugin list before trying again.".into(),
            CliError::TooMuch => "Claude Code's command sent back more than Atlas can read.".into(),
            CliError::NoJson(m) => if m.is_empty() { "Claude Code's command did not answer in a way Atlas can read.".into() } else { m.clone() },
        }
    }
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

/// What came back from one run.
#[derive(Debug, Clone)]
pub struct RawOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// One request to start the command.
#[derive(Debug, Clone)]
pub struct Request {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// `CLAUDE_CONFIG_DIR` for the child: `Some` for a chosen folder, `None` for the default one
    /// (then the variable is removed, so the command finds `~/.claude` and `~/.claude.json` as it does
    /// for the user).
    pub config_dir: Option<PathBuf>,
    pub timeout: Duration,
}

/// Starts the command. The real one spawns a process; tests answer from a script.
pub trait Exec: Send + Sync {
    fn run(&self, req: &Request) -> Result<RawOutput, CliError>;
}

pub struct RealExec;

impl Exec for RealExec {
    fn run(&self, req: &Request) -> Result<RawOutput, CliError> {
        let stem = req.program.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if stem != "claude" {
            return Err(CliError::Refused("Atlas only starts Claude Code's own command.".into()));
        }
        let mut cmd = Command::new(&req.program);
        cmd.args(&req.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        match &req.config_dir {
            Some(d) => {
                cmd.env("CLAUDE_CONFIG_DIR", d);
            }
            None => {
                cmd.env_remove("CLAUDE_CONFIG_DIR");
            }
        }
        crate::proc::quiet(&mut cmd);
        let mut child = cmd.spawn().map_err(|e| CliError::Spawn(format!("Could not start Claude Code's command: {e}")))?;
        let out = child.stdout.take();
        let err = child.stderr.take();
        let t_out = std::thread::spawn(move || read_capped(out, STDOUT_CAP));
        let t_err = std::thread::spawn(move || read_capped(err, 64 * 1024));
        let start = Instant::now();
        let mut failure: Option<CliError> = None;
        let code = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s.code().unwrap_or(-1),
                Ok(None) if start.elapsed() > req.timeout => {
                    failure = Some(CliError::TimedOut);
                    break -1;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(e) => {
                    failure = Some(CliError::Spawn(e.to_string()));
                    break -1;
                }
            }
            // A reader that hit the cap has stopped reading: the child would block, so stop it.
            if t_out.is_finished() && child.try_wait().ok().flatten().is_none() {
                failure = Some(CliError::TooMuch);
                break -1;
            }
        };
        if failure.is_some() {
            let _ = child.kill();
            let _ = child.wait();
        }
        let (stdout, over) = t_out.join().unwrap_or_default();
        let (stderr, _) = t_err.join().unwrap_or_default();
        if let Some(f) = failure {
            return Err(f);
        }
        if over {
            return Err(CliError::TooMuch);
        }
        Ok(RawOutput { code, stdout, stderr })
    }
}

/// (text, hit the cap).
fn read_capped(r: Option<impl Read>, cap: usize) -> (String, bool) {
    let Some(r) = r else { return (String::new(), false) };
    let mut buf = Vec::new();
    let _ = r.take(cap as u64 + 1).read_to_end(&mut buf);
    let over = buf.len() > cap;
    buf.truncate(cap);
    (String::from_utf8_lossy(&buf).into_owned(), over)
}

/// What a plugin or marketplace command said.
#[derive(Debug, Clone)]
pub struct Outcome {
    pub ok: bool,
    /// The command's own words, cut to one sentence.
    pub message: String,
    pub failure_code: Option<String>,
    /// Marketplace name or plugin id the command reports.
    pub subject: Option<String>,
    pub raw: Value,
}

/// A plugin id: `name@marketplace`, nothing a command line could read as an option.
pub fn valid_plugin_id(id: &str) -> bool {
    let part = |s: &str| !s.is_empty() && s.len() <= 100 && !s.starts_with(['-', '.']) && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    id.split_once('@').is_some_and(|(a, b)| part(a) && part(b) && !b.contains('@'))
}

fn valid_marketplace_name(n: &str) -> bool {
    !n.is_empty() && n.len() <= 100 && !n.starts_with(['-', '.']) && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// `owner/repo` or a folder path, never something that starts like an option.
fn valid_marketplace_source(s: &str) -> bool {
    !s.is_empty() && s.len() <= 400 && !s.starts_with('-') && !s.contains(['\n', '\r', '\0'])
}

pub struct Runner {
    program: PathBuf,
    config_dir: PathBuf,
    /// The folder is a chosen one: the variable is passed on. Default: it is not.
    set_env: bool,
    exec: Arc<dyn Exec>,
    spawns: AtomicUsize,
}

impl Runner {
    /// The real thing: `claude` found by `cli`, running against `root`.
    pub fn new(cli: &CliChoice, root: &ConfigRoot) -> Result<Runner, CliError> {
        let program = cli.resolve().ok_or(CliError::NoCli)?;
        Ok(Runner::with_exec(program, root, Arc::new(RealExec)))
    }

    pub fn with_exec(program: PathBuf, root: &ConfigRoot, exec: Arc<dyn Exec>) -> Runner {
        // D4: the variable is set for every chosen folder. For the default folder it is left unset,
        // because setting it would move `.claude.json` to `<dir>/.claude.json` for the command.
        Runner { program, config_dir: root.dir.clone(), set_env: !matches!(root.source, ConfigSource::Default), exec, spawns: AtomicUsize::new(0) }
    }

    /// How many times the command was started (a refusal does not count).
    pub fn spawns(&self) -> usize {
        self.spawns.load(Ordering::Relaxed)
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    fn start(&self, args: &[&str], timeout: Duration) -> Result<RawOutput, CliError> {
        // Every call writes into the folder (even listing), so every call is guarded.
        crate::fsutil::check_write_allowed(&self.config_dir).map_err(|e| CliError::Refused(e.to_string()))?;
        debug_assert!(!args.iter().any(|a| matches!(*a, "-y" | "--yes" | "--accept-command")));
        let req = Request { program: self.program.clone(), args: args.iter().map(|s| s.to_string()).collect(), config_dir: self.set_env.then(|| self.config_dir.clone()), timeout };
        self.spawns.fetch_add(1, Ordering::Relaxed);
        self.exec.run(&req)
    }

    /// The raw JSON of `plugin list --available --json` (the catalog, about 2 MB).
    pub fn list_available(&self) -> Result<String, CliError> {
        let out = self.start(&["plugin", "list", "--available", "--json"], LIST)?;
        if out.code != 0 {
            return Err(CliError::NoJson(first_line(&out.stderr)));
        }
        Ok(out.stdout)
    }

    /// `plugin list --json`.
    pub fn list_installed(&self) -> Result<Value, CliError> {
        let out = self.start(&["plugin", "list", "--json"], LIST)?;
        last_json(&out.stdout).ok_or_else(|| CliError::NoJson(first_line(&out.stderr)))
    }

    fn outcome(&self, args: &[&str], timeout: Duration) -> Result<Outcome, CliError> {
        let out = self.start(args, timeout)?;
        let raw = last_json(&out.stdout);
        let Some(raw) = raw else {
            return if out.code == 0 { Err(CliError::NoJson(String::new())) } else { Err(CliError::NoJson(first_line(&out.stderr))) };
        };
        let outcome = raw.get("outcome").and_then(Value::as_str).unwrap_or(if out.code == 0 { "ok" } else { "failed" });
        let message = raw.get("message").and_then(Value::as_str).map(first_sentence).filter(|m| !m.is_empty()).unwrap_or_else(|| first_line(&out.stderr));
        let subject = ["pluginId", "marketplace", "plugin"].iter().find_map(|k| raw.get(*k).and_then(Value::as_str)).map(str::to_string);
        Ok(Outcome { ok: out.code == 0 && outcome == "ok", message, failure_code: raw.get("failureCode").and_then(Value::as_str).map(str::to_string), subject, raw })
    }

    /// `plugin marketplace add <source> --json` (`owner/repo` or a folder).
    pub fn marketplace_add(&self, source: &str) -> Result<Outcome, CliError> {
        if !valid_marketplace_source(source) {
            return Err(CliError::Refused("That marketplace source can't be used.".into()));
        }
        self.outcome(&["plugin", "marketplace", "add", source, "--json"], MARKET)
    }

    /// `plugin marketplace update <name> --json`.
    pub fn marketplace_update(&self, name: &str) -> Result<Outcome, CliError> {
        if !valid_marketplace_name(name) {
            return Err(CliError::Refused("That marketplace name can't be used.".into()));
        }
        self.outcome(&["plugin", "marketplace", "update", name, "--json"], MARKET)
    }

    /// `plugin install <id> --json` at user scope. Never `-y`, never `--accept-command`.
    pub fn install(&self, id: &str) -> Result<Outcome, CliError> {
        if !valid_plugin_id(id) {
            return Err(CliError::Refused("That plugin name can't be used.".into()));
        }
        self.outcome(&["plugin", "install", id, "--scope", "user", "--json"], INSTALL)
    }

    /// `plugin uninstall <id> --keep-data --json`.
    pub fn uninstall(&self, id: &str) -> Result<Outcome, CliError> {
        if !valid_plugin_id(id) {
            return Err(CliError::Refused("That plugin name can't be used.".into()));
        }
        self.outcome(&["plugin", "uninstall", id, "--scope", "user", "--keep-data", "--json"], OTHER)
    }

    /// `plugin enable|disable <id> --json`.
    pub fn set_enabled(&self, id: &str, on: bool) -> Result<Outcome, CliError> {
        if !valid_plugin_id(id) {
            return Err(CliError::Refused("That plugin name can't be used.".into()));
        }
        self.outcome(&["plugin", if on { "enable" } else { "disable" }, id, "--scope", "user", "--json"], OTHER)
    }
}

fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).map(|l| cut(l, 200)).unwrap_or_default()
}

fn first_sentence(s: &str) -> String {
    let one = s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
    let end = one.find(". ").map(|i| i + 1).unwrap_or(one.len());
    cut(&one[..end], 200)
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() > n { format!("{}...", s.chars().take(n).collect::<String>()) } else { s.to_string() }
}

/// The last JSON value in `s`: the whole text, else the last line that parses.
pub fn last_json(s: &str) -> Option<Value> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(t) {
        return Some(v);
    }
    t.lines().rev().map(str::trim).filter(|l| l.starts_with(['{', '[']) ).find_map(|l| serde_json::from_str::<Value>(l).ok())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::Mutex;

    type Answer = Box<dyn Fn(&Request) -> Result<RawOutput, CliError> + Send + Sync>;

    /// A scripted command: records every request, answers from a closure.
    pub struct Fake {
        pub calls: Mutex<Vec<Vec<String>>>,
        pub envs: Mutex<Vec<Option<PathBuf>>>,
        pub answer: Answer,
    }

    impl Fake {
        pub fn new(answer: impl Fn(&Request) -> Result<RawOutput, CliError> + Send + Sync + 'static) -> Arc<Fake> {
            Arc::new(Fake { calls: Mutex::new(vec![]), envs: Mutex::new(vec![]), answer: Box::new(answer) })
        }
        pub fn log(&self) -> Vec<String> {
            self.calls.lock().unwrap().iter().map(|a| a.join(" ")).collect()
        }
    }

    impl Exec for Fake {
        fn run(&self, req: &Request) -> Result<RawOutput, CliError> {
            self.calls.lock().unwrap().push(req.args.clone());
            self.envs.lock().unwrap().push(req.config_dir.clone());
            (self.answer)(req)
        }
    }

    pub fn ok(json: &str) -> Result<RawOutput, CliError> {
        Ok(RawOutput { code: 0, stdout: json.into(), stderr: String::new() })
    }

    pub fn root(dir: &Path, source: ConfigSource) -> ConfigRoot {
        ConfigRoot { dir: dir.to_path_buf(), claude_json: dir.join(".claude.json"), projects_dir: dir.join("projects"), projects_read_only: false, source }
    }

    #[test]
    fn plugin_ids_cannot_be_options() {
        assert!(valid_plugin_id("frontend-design@anthropic-plugin-directory"));
        assert!(valid_plugin_id("a.b_c@x-y"));
        for bad in ["-y@x", "a@-x", "a", "a@", "@b", "a@b@c", "a b@c", "--accept-command@x", "a@b;rm", "../x@y"] {
            assert!(!valid_plugin_id(bad), "{bad}");
        }
        assert!(!valid_marketplace_source("--help"));
        assert!(valid_marketplace_source("pbakaus/impeccable"));
    }

    #[test]
    fn the_last_json_line_wins_and_noise_is_ignored() {
        assert_eq!(last_json("[]").unwrap(), serde_json::json!([]));
        assert_eq!(last_json("warming up\n{\"a\":1}\n{\"outcome\":\"ok\"}\n").unwrap()["outcome"], "ok");
        assert!(last_json("no json here").is_none());
        assert!(last_json("").is_none());
    }

    #[test]
    fn a_chosen_folder_is_passed_on_the_default_one_is_not() {
        let t = tempfile::tempdir().unwrap();
        let fake = Fake::new(|_| ok("[]"));
        let r = Runner::with_exec("claude".into(), &root(t.path(), ConfigSource::Flag), fake.clone());
        r.list_installed().unwrap();
        assert_eq!(fake.envs.lock().unwrap()[0].as_deref(), Some(t.path()));
        // The default folder: nothing set (setting it would move `.claude.json`). A temp path stands
        // in for it: the guard only matters for the real one, tested below.
        let fake = Fake::new(|_| ok("[]"));
        let r = Runner::with_exec("claude".into(), &root(t.path(), ConfigSource::Default), fake.clone());
        r.list_installed().unwrap();
        assert_eq!(fake.envs.lock().unwrap()[0], None);
    }

    #[test]
    fn the_real_folder_is_refused_without_starting_anything() {
        if !cfg!(debug_assertions) {
            return;
        }
        let Some(home) = crate::paths::home_dir() else { return };
        let real = home.join(".claude");
        let fake = Fake::new(|_| ok("[]"));
        let r = Runner::with_exec("claude".into(), &root(&real, ConfigSource::Default), fake.clone());
        assert!(matches!(r.list_available(), Err(CliError::Refused(_))));
        assert!(matches!(r.install("frontend-design@anthropic-plugin-directory"), Err(CliError::Refused(_))));
        assert!(matches!(r.uninstall("a@b"), Err(CliError::Refused(_))));
        assert!(matches!(r.marketplace_add("o/r"), Err(CliError::Refused(_))));
        assert_eq!(r.spawns(), 0);
        assert!(fake.log().is_empty());
    }

    #[test]
    fn an_install_never_carries_yes_or_accept_command() {
        let t = tempfile::tempdir().unwrap();
        let fake = Fake::new(|_| ok("{\"outcome\":\"ok\",\"pluginId\":\"a@b\",\"message\":\"Installed.\"}"));
        let r = Runner::with_exec("claude".into(), &root(t.path(), ConfigSource::Flag), fake.clone());
        r.install("a@b").unwrap();
        r.uninstall("a@b").unwrap();
        r.set_enabled("a@b", false).unwrap();
        r.marketplace_add("o/r").unwrap();
        r.marketplace_update("m").unwrap();
        r.list_available().unwrap();
        for line in fake.log() {
            for bad in [" -y", "--yes", "--accept-command"] {
                assert!(!line.contains(bad), "{line}");
            }
        }
        assert_eq!(fake.log()[0], "plugin install a@b --scope user --json");
        assert_eq!(fake.log()[1], "plugin uninstall a@b --scope user --keep-data --json");
        assert_eq!(fake.log()[3], "plugin marketplace add o/r --json");
        assert_eq!(r.spawns(), 6);
    }

    #[test]
    fn failures_come_back_as_one_sentence() {
        let t = tempfile::tempdir().unwrap();
        let fake = Fake::new(|_| Ok(RawOutput { code: 1, stdout: "{\"outcome\":\"failed\",\"failureCode\":\"manifest_missing\",\"message\":\"No marketplace.json found. Add one first.\"}".into(), stderr: String::new() }));
        let r = Runner::with_exec("claude".into(), &root(t.path(), ConfigSource::Flag), fake);
        let o = r.marketplace_add("o/r").unwrap();
        assert!(!o.ok);
        assert_eq!(o.failure_code.as_deref(), Some("manifest_missing"));
        assert_eq!(o.message, "No marketplace.json found.");
    }

    #[test]
    fn the_real_runner_only_starts_claude() {
        let req = Request { program: "notepad.exe".into(), args: vec![], config_dir: None, timeout: Duration::from_secs(1) };
        assert!(matches!(RealExec.run(&req), Err(CliError::Refused(_))));
    }

    /// Every place Atlas builds a `Command` goes through `proc::quiet`, and the library starts
    /// nothing but Claude Code's command (criterion 4).
    #[test]
    fn every_spawn_is_quiet_and_only_claude() {
        let files = [
            ("library/cli.rs", include_str!("cli.rs")),
            ("library/install.rs", include_str!("install.rs")),
            ("library/mod.rs", include_str!("mod.rs")),
            ("library/archive.rs", include_str!("archive.rs")),
            ("library/check.rs", include_str!("check.rs")),
            ("library/shape.rs", include_str!("shape.rs")),
            ("library/catalog.rs", include_str!("catalog.rs")),
            ("library/ledger.rs", include_str!("ledger.rs")),
            ("library/link.rs", include_str!("link.rs")),
            ("app library.rs", include_str!("../../../app/src/library.rs")),
        ];
        for (name, src) in files {
            // Only the code above the test module counts.
            let code = src.split("#[cfg(test)]").next().unwrap();
            let builds = code.matches("Command::new(").count();
            let quiets = code.matches("proc::quiet(").count();
            assert!(quiets >= builds, "{name}: {builds} Command::new but {quiets} proc::quiet");
            for (i, _) in code.match_indices("Command::new(") {
                let arg: String = code[i + "Command::new(".len()..].chars().take_while(|c| *c != ')').collect();
                assert!(arg.contains("req.program"), "{name}: Command::new({arg}) starts something that is not the runner's program");
            }
            // No other way to start a program in the library code.
            for other in ["tokio::process", ".spawn()", "ShellExecute", "open::that"] {
                let n = code.matches(other).count();
                let allowed = usize::from(name == "library/cli.rs" && other == ".spawn()");
                assert!(n <= allowed, "{name} uses {other} {n} times");
            }
        }
    }
}
