//! Settings files and everything they define: hooks, permission rules, the
//! status line, hook scripts, and the "is it on?" state of items.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::files::FileEnt;
use super::model::*;
use super::projects::norm_key;
use super::secrets::{mask_json, redact_inline};
use super::{display_path, read_head, truncate_chars, Build, ScopeCtx, SourceRef};

/// One settings file, kept only while discovery runs. `env` is removed on load,
/// so no environment value is ever held.
pub struct SettingsFile {
    pub path: PathBuf,
    pub scope: ScopeCtx,
    /// user 1 < user local 2 < project 3 < project local 4 < managed 5
    pub rank: u8,
    pub local: bool,
    pub value: Value,
}

/// A script a hook or the status line runs, or one that sits in a hooks folder.
pub struct Script {
    pub path: PathBuf,
    pub size: u64,
    pub mtime: i64,
    pub scope: ScopeCtx,
    pub used_by: Vec<String>,
}

const SCRIPT_EXT: &[&str] = &["sh", "bash", "ps1", "py", "js", "mjs", "cjs", "ts", "cmd", "bat"];
const MAX_RULES_PER_FILE: usize = 3000;

fn command_tokens(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut any = false;
    for c in cmd.chars() {
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => cur.push(c),
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                any = true;
            }
            None if c.is_whitespace() => {
                if any || !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            None => cur.push(c),
        }
    }
    if any || !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn tool_of(rule: &str) -> String {
    rule.split('(').next().unwrap_or(rule).trim().to_string()
}

impl Build<'_> {
    pub(crate) fn load_settings(&mut self, ent: &FileEnt, scope: &ScopeCtx, local: bool, rank: u8) {
        if self.settings.iter().any(|f| f.path == ent.path) {
            return;
        }
        let text = read_head(&ent.path, 4 * 1024 * 1024).unwrap_or_default();
        let body = text.trim_start_matches('\u{feff}');
        let mut it = SetupItem::new(ItemKind::Settings, scope.kind, ent.name().to_string());
        it.path = Some(display_path(&ent.path));
        it.size = Some(ent.size);
        it.modified_ms = Some(ent.mtime);
        if local {
            it.chips.push("local".into());
        }
        match serde_json::from_str::<Value>(body) {
            Ok(Value::Object(mut m)) => {
                let env_keys: Vec<String> = m.get("env").and_then(Value::as_object).map(|e| e.keys().cloned().collect()).unwrap_or_default();
                m.remove("env");
                let count = |list: &str| m.get("permissions").and_then(|p| p.get(list)).and_then(Value::as_array).map_or(0, |a| a.len());
                it.description = format!("{} keys \u{b7} {} allow \u{b7} {} deny", m.len() + usize::from(!env_keys.is_empty()), count("allow"), count("deny"));
                let mut keys: Vec<String> = m.keys().cloned().collect();
                if !env_keys.is_empty() {
                    keys.push("env".into());
                }
                it.detail.push(DetailRow { label: "Keys".into(), value: keys.join(", ") });
                if !env_keys.is_empty() {
                    let shown: Vec<&str> = env_keys.iter().take(30).map(String::as_str).collect();
                    let more = env_keys.len().saturating_sub(30);
                    let mut v = shown.join(", ");
                    if more > 0 {
                        v.push_str(&format!(" +{more} more"));
                    }
                    it.detail.push(DetailRow { label: "Environment variables (names only)".into(), value: v });
                }
                for (label, key) in [("Model", "model"), ("Output style", "outputStyle"), ("Default mode", "permissions.defaultMode"), ("Effort", "effortLevel")] {
                    let v = if let Some((a, b)) = key.split_once('.') { m.get(a).and_then(|x| x.get(b)) } else { m.get(key) };
                    if let Some(Value::String(s)) = v {
                        it.detail.push(DetailRow { label: label.into(), value: redact_inline(s) });
                    }
                }
                it.has_secrets = !env_keys.is_empty() || !mask_json(body).ranges.is_empty();
                self.settings.push(SettingsFile { path: ent.path.clone(), scope: scope.clone(), rank, local, value: Value::Object(m) });
            }
            Ok(_) => it.warnings.push("Not a JSON object".into()),
            Err(e) => {
                it.description = "Can't be read".into();
                it.warnings.push(format!("Can't be read: line {}, column {}", e.line(), e.column()));
            }
        }
        self.add(it, scope, &ent.path, "", SourceRef::File { path: ent.path.clone() });
    }

    pub(crate) fn derive_settings_items(&mut self) {
        let files: Vec<(PathBuf, ScopeCtx, Value)> = self.settings.iter().map(|f| (f.path.clone(), f.scope.clone(), f.value.clone())).collect();
        for (path, scope, value) in files {
            if let Some(perms) = value.get("permissions") {
                for (list, label) in [("allow", "Allowed"), ("ask", "Asks first"), ("deny", "Denied")] {
                    let Some(Value::Array(rules)) = perms.get(list) else { continue };
                    for (i, rule) in rules.iter().take(MAX_RULES_PER_FILE).enumerate() {
                        let Some(r) = rule.as_str() else { continue };
                        let shown = truncate_chars(&redact_inline(r), 300);
                        let mut it = SetupItem::new(ItemKind::Permission, scope.kind, shown);
                        it.path = Some(display_path(&path));
                        it.description = label.into();
                        it.chips = vec![list.into(), tool_of(r)];
                        it.detail = vec![DetailRow { label: "List".into(), value: list.into() }, DetailRow { label: "Tool".into(), value: tool_of(r) }];
                        self.add(
                            it,
                            &scope,
                            &path,
                            &format!("/permissions/{list}/{i}"),
                            SourceRef::JsonEntry { file: path.clone(), pointer: vec!["permissions".into(), list.into(), i.to_string()] },
                        );
                    }
                }
            }
            if let Some(h) = value.get("hooks") {
                self.add_hooks(h, &path, &scope, "/hooks", true);
            }
            if let Some(sl) = value.get("statusLine") {
                let cmd = sl.get("command").and_then(Value::as_str).unwrap_or("");
                let ty = sl.get("type").and_then(Value::as_str).unwrap_or("command");
                let mut it = SetupItem::new(ItemKind::StatusLine, scope.kind, "Status line");
                it.path = Some(display_path(&path));
                it.description = truncate_chars(&redact_inline(cmd), 60);
                it.chips.push(ty.to_string());
                it.detail.push(DetailRow { label: "Type".into(), value: ty.into() });
                if !cmd.is_empty() {
                    it.detail.push(DetailRow { label: "Command".into(), value: truncate_chars(&redact_inline(cmd), 300) });
                }
                if let Some(p) = sl.get("padding") {
                    it.detail.push(DetailRow { label: "Padding".into(), value: p.to_string() });
                }
                let idx = self.add(it, &scope, &path, "/statusLine", SourceRef::JsonEntry { file: path.clone(), pointer: vec!["statusLine".into()] });
                if let Some(i) = idx {
                    let id = self.items[i].id.clone();
                    let missing = self.note_scripts(cmd, &scope, &id);
                    for m in missing {
                        self.items[i].warnings.push(format!("Script not found: {m}"));
                    }
                }
            }
        }
    }

    /// Hook handlers from `hooks`-shaped JSON (settings, plugin `hooks.json`, or
    /// skill/agent frontmatter).
    pub(crate) fn add_hooks(&mut self, h: &Value, file: &Path, scope: &ScopeCtx, base_ptr: &str, in_json: bool) {
        let Value::Object(events) = h else { return };
        let base: Vec<String> = base_ptr.split('/').filter(|s| !s.is_empty()).map(str::to_string).collect();
        // How many identical hooks (same event, matcher and JSON) came before, for the id.
        let mut seen_same: HashMap<String, usize> = HashMap::new();
        for (event, arr) in events {
            let Value::Array(groups) = arr else { continue };
            for (gi, g) in groups.iter().enumerate() {
                let matcher = g.get("matcher").and_then(Value::as_str).unwrap_or("");
                let Some(Value::Array(handlers)) = g.get("hooks") else { continue };
                for (hi, hd) in handlers.iter().enumerate() {
                    let ty = hd.get("type").and_then(Value::as_str).unwrap_or("command");
                    let cmd = hd.get("command").and_then(Value::as_str);
                    let body = cmd.or_else(|| hd.get("prompt").and_then(Value::as_str)).unwrap_or("");
                    let name = format!("{event} \u{b7} {}", if matcher.is_empty() { "any" } else { matcher });
                    let mut it = SetupItem::new(ItemKind::Hook, scope.kind, name);
                    it.path = Some(display_path(file));
                    it.description = format!("{ty}: {}", truncate_chars(&redact_inline(body), 60));
                    it.chips = vec![event.clone(), ty.to_string()];
                    it.detail.push(DetailRow { label: "Event".into(), value: event.clone() });
                    it.detail.push(DetailRow { label: "Matcher".into(), value: if matcher.is_empty() { "any".into() } else { matcher.to_string() } });
                    it.detail.push(DetailRow { label: "Type".into(), value: ty.into() });
                    if let Some(t) = hd.get("timeout") {
                        it.detail.push(DetailRow { label: "Timeout".into(), value: t.to_string() });
                    }
                    if !body.is_empty() {
                        it.detail.push(DetailRow { label: if cmd.is_some() { "Command" } else { "Prompt" }.into(), value: truncate_chars(&redact_inline(body), 400) });
                    }
                    let ptr = format!("{base_ptr}/{event}/{gi}/hooks/{hi}");
                    // A settings hook can be deleted or saved, and it lives at a position in an
                    // array that Claude Code or the user can shift at any time. Its id names the
                    // hook by what it is (event, matcher, its JSON and which identical copy), not by
                    // its index: after a rescan the same id finds the same hook wherever it moved,
                    // and an id from an older scan never lands on a different hook.
                    let id_key = if in_json {
                        let content = format!("{base_ptr}/{event}\u{1f}{}\u{1f}{}", g.get("matcher").map(Value::to_string).unwrap_or_default(), hd);
                        let n = seen_same.entry(content.clone()).or_insert(0);
                        *n += 1;
                        format!("{content}\u{1f}{}", *n - 1)
                    } else {
                        ptr.clone()
                    };
                    let src = if in_json {
                        let mut p = base.clone();
                        p.extend([event.clone(), gi.to_string(), "hooks".into(), hi.to_string()]);
                        SourceRef::JsonEntry { file: file.to_path_buf(), pointer: p }
                    } else {
                        SourceRef::File { path: file.to_path_buf() }
                    };
                    let added = self.add(it, scope, file, &id_key, src);
                    if let Some(i) = added
                        && in_json {
                            // The write path re-checks that this exact hook still sits at the pointer.
                            self.entry_values.insert(self.items[i].id.clone(), hd.clone());
                        }
                    if let Some(i) = added
                        && let Some(c) = cmd {
                            let id = self.items[i].id.clone();
                            let missing = self.note_scripts(c, scope, &id);
                            for m in missing {
                                self.items[i].warnings.push(format!("Script not found: {m}"));
                            }
                        }
                }
            }
        }
    }

    fn project_dir(&self, scope: &ScopeCtx) -> Option<PathBuf> {
        let id = &scope.project.as_ref()?.0;
        self.col.projects.iter().find(|p| &p.id == id).map(|p| p.path.clone())
    }

    fn expand_vars(&self, tok: &str, scope: &ScopeCtx) -> Option<String> {
        let mut s = tok.to_string();
        let home = display_path(&self.inputs.home);
        let proj = self.project_dir(scope).map(|p| display_path(&p));
        let plugin = scope.plugin.as_ref().and_then(|n| self.plugin_paths.get(n)).map(|p| display_path(p));
        let subs: [(&[&str], Option<String>); 3] = [
            (&["${CLAUDE_PROJECT_DIR}", "$CLAUDE_PROJECT_DIR", "%CLAUDE_PROJECT_DIR%"], proj),
            (&["${CLAUDE_PLUGIN_ROOT}", "$CLAUDE_PLUGIN_ROOT", "%CLAUDE_PLUGIN_ROOT%"], plugin),
            (&["${HOME}", "$HOME", "%USERPROFILE%"], Some(home.clone())),
        ];
        for (pats, val) in subs {
            for p in pats {
                if s.contains(p) {
                    s = s.replace(p, val.as_deref()?);
                }
            }
        }
        if let Some(rest) = s.strip_prefix("~/").or_else(|| s.strip_prefix("~\\")) {
            s = format!("{home}/{rest}");
        }
        if s.contains('$') || s.contains('%') {
            return None;
        }
        Some(s)
    }

    /// Find the script files a command runs, record them, return the names of
    /// those that do not exist.
    pub(crate) fn note_scripts(&mut self, cmd: &str, scope: &ScopeCtx, item_id: &str) -> Vec<String> {
        let mut missing = Vec::new();
        for tok in command_tokens(cmd) {
            let ext_ok = Path::new(&tok).extension().and_then(|e| e.to_str()).is_some_and(|e| SCRIPT_EXT.contains(&e.to_ascii_lowercase().as_str()));
            if !ext_ok {
                continue;
            }
            let Some(exp) = self.expand_vars(&tok, scope) else { continue };
            let p = PathBuf::from(&exp);
            if !p.is_absolute() {
                continue;
            }
            if crate::layout::is_denied_name(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default().as_str()) {
                continue;
            }
            let Ok(md) = std::fs::metadata(&p) else {
                missing.push(p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(exp));
                continue;
            };
            if !md.is_file() {
                continue;
            }
            let key = norm_key(&p.to_string_lossy());
            let entry = self.scripts.entry(key).or_insert_with(|| Script { path: p.clone(), size: md.len(), mtime: super::mtime_ms(&md), scope: scope.clone(), used_by: Vec::new() });
            if !entry.used_by.iter().any(|u| u == item_id) {
                entry.used_by.push(item_id.to_string());
            }
        }
        missing
    }

    /// A file in a `hooks/` folder: listed even when no hook names it.
    pub(crate) fn script_candidate(&mut self, e: &FileEnt, scope: &ScopeCtx) {
        let key = norm_key(&e.path.to_string_lossy());
        self.scripts.entry(key).or_insert_with(|| Script { path: e.path.clone(), size: e.size, mtime: e.mtime, scope: scope.clone(), used_by: Vec::new() });
    }

    pub(crate) fn derive_scripts(&mut self) {
        let mut list: Vec<(String, Script)> = std::mem::take(&mut self.scripts).into_iter().collect();
        list.sort_by(|a, b| a.0.cmp(&b.0));
        // A script that a hook names is a script, not a loose file.
        let script_paths: std::collections::HashSet<String> = list.iter().map(|(k, _)| k.clone()).collect();
        let mut dropped = Vec::new();
        self.items.retain(|i| {
            let loose = i.kind == ItemKind::Other && i.path.as_ref().is_some_and(|p| script_paths.contains(&norm_key(p)));
            if loose {
                dropped.push(i.id.clone());
            }
            !loose
        });
        for id in dropped {
            self.sources.remove(&id);
        }
        for (key, s) in list {
            let name = s.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let mut it = SetupItem::new(ItemKind::HookScript, s.scope.kind, name);
            it.path = Some(display_path(&s.path));
            it.size = Some(s.size);
            it.modified_ms = Some(s.mtime);
            it.used_by = Some(s.used_by.len() as u32);
            it.description = match s.used_by.len() {
                0 => "Not referenced".into(),
                1 => "Used by 1 hook".into(),
                n => format!("Used by {n} hooks"),
            };
            let in_root = key.starts_with(&format!("{}/", self.root_key));
            let scope = if in_root { ScopeCtx::user() } else { s.scope.clone() };
            self.add(it, &scope, &s.path, "", SourceRef::File { path: s.path.clone() });
        }
    }

    // ---- effective settings -------------------------------------------------

    fn layers(&self, project: Option<&str>) -> Vec<&SettingsFile> {
        let mut v: Vec<&SettingsFile> = self
            .settings
            .iter()
            .filter(|f| match &f.scope.project {
                None => true,
                Some((id, _)) => Some(id.as_str()) == project,
            })
            .collect();
        v.sort_by_key(|f| std::cmp::Reverse(f.rank));
        v
    }

    pub(crate) fn eff_value(&self, project: Option<&str>, key: &str) -> Option<&Value> {
        self.layers(project).into_iter().find_map(|f| f.value.get(key))
    }

    pub(crate) fn eff_sub(&self, project: Option<&str>, key: &str, sub: &str) -> Option<&Value> {
        self.layers(project).into_iter().find_map(|f| f.value.get(key).and_then(|m| m.get(sub)))
    }

    fn eff_list_has(&self, project: Option<&str>, key: &str, name: &str) -> bool {
        self.layers(project).iter().any(|f| f.value.get(key).and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.as_str() == Some(name))))
    }

    pub(crate) fn compute_enabled(&mut self) {
        // Plugin states first: their children follow them.
        let mut plugin_on: std::collections::HashMap<String, bool> = std::collections::HashMap::new();
        let mut out: Vec<(usize, Enabled)> = Vec::new();
        for (i, it) in self.items.iter().enumerate() {
            if it.kind == ItemKind::Plugin {
                let on = self.eff_sub(None, "enabledPlugins", &it.name).and_then(Value::as_bool).unwrap_or(false);
                plugin_on.insert(it.name.split('@').next().unwrap_or(&it.name).to_string(), on);
                out.push((i, if on { Enabled::on() } else { Enabled::off() }));
            }
        }
        let cj = self.cj.clone();
        for (i, it) in self.items.iter().enumerate() {
            let proj = it.project_id.as_deref();
            let e = match it.kind {
                ItemKind::Plugin => continue,
                ItemKind::Skill | ItemKind::Agent | ItemKind::Command | ItemKind::OutputStyle | ItemKind::Hook | ItemKind::McpServer
                    if it.scope == ScopeKind::Plugin =>
                {
                    let on = it.plugin.as_ref().and_then(|p| plugin_on.get(p)).copied().unwrap_or(false);
                    if !on {
                        Enabled::of(EnabledKind::Off, "Plugin off")
                    } else if it.kind == ItemKind::OutputStyle {
                        self.style_state(proj, &it.name)
                    } else if it.kind == ItemKind::Hook && self.eff_value(proj, "disableAllHooks").and_then(Value::as_bool) == Some(true) {
                        Enabled::of(EnabledKind::Off, "Hooks disabled")
                    } else {
                        Enabled::on()
                    }
                }
                ItemKind::Skill if matches!(it.scope, ScopeKind::User | ScopeKind::Project) => {
                    let key = it.shadow_key.as_deref().unwrap_or(&it.name);
                    match self.eff_sub(proj, "skillOverrides", key).and_then(Value::as_str) {
                        Some("on") | None => Enabled::on(),
                        Some("off") => Enabled { state: EnabledKind::Off, label: "Off".into(), raw: Some("off".into()) },
                        Some(raw) => Enabled { state: EnabledKind::Custom, label: raw.to_string(), raw: Some(raw.to_string()) },
                    }
                }
                ItemKind::Agent | ItemKind::Command if matches!(it.scope, ScopeKind::User | ScopeKind::Project | ScopeKind::Managed) => Enabled::on(),
                ItemKind::OutputStyle => self.style_state(proj, &it.name),
                ItemKind::Hook => {
                    if self.eff_value(proj, "disableAllHooks").and_then(Value::as_bool) == Some(true) {
                        Enabled::of(EnabledKind::Off, "Hooks disabled")
                    } else {
                        Enabled::on()
                    }
                }
                ItemKind::StatusLine => {
                    let winner = self.layers(proj).into_iter().find(|f| f.value.get("statusLine").is_some()).map(|f| display_path(&f.path));
                    if winner.is_some() && winner == it.path {
                        Enabled::of(EnabledKind::Active, "Active")
                    } else {
                        Enabled::of(EnabledKind::Inactive, "Overridden")
                    }
                }
                ItemKind::McpServer if it.scope == ScopeKind::Managed => Enabled::on(),
                ItemKind::McpServer if it.scope == ScopeKind::Project => {
                    // `.mcp.json` entries need approval.
                    let name = it.shadow_key.as_deref().unwrap_or(&it.name);
                    let pkey = proj.and_then(|id| self.col.projects.iter().find(|p| p.id == id)).map(|p| p.key.clone());
                    let cjp = cj.as_ref().and_then(|c| c.projects.iter().find(|p| Some(norm_key(&p.key)) == pkey));
                    let rejected = cjp.is_some_and(|p| p.disabled_json.iter().any(|n| n == name)) || self.eff_list_has(proj, "disabledMcpjsonServers", name);
                    let approved = cjp.is_some_and(|p| p.enabled_json.iter().any(|n| n == name))
                        || self.eff_list_has(proj, "enabledMcpjsonServers", name)
                        || self.eff_value(proj, "enableAllProjectMcpServers").and_then(Value::as_bool) == Some(true);
                    if rejected {
                        Enabled::of(EnabledKind::Rejected, "Rejected")
                    } else if approved {
                        Enabled::of(EnabledKind::Approved, "Approved")
                    } else {
                        Enabled::of(EnabledKind::Pending, "Pending approval")
                    }
                }
                _ => continue,
            };
            out.push((i, e));
        }
        for (i, e) in out {
            self.items[i].enabled = e;
        }
    }

    fn style_state(&self, proj: Option<&str>, name: &str) -> Enabled {
        let cur = self.eff_value(proj, "outputStyle").and_then(Value::as_str).unwrap_or("");
        if !cur.is_empty() && cur.eq_ignore_ascii_case(name) {
            Enabled::of(EnabledKind::Active, "Active")
        } else {
            Enabled::of(EnabledKind::Inactive, "Not selected")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_respect_quotes() {
        let t = command_tokens(r#"node "C:\a b\x.js" --flag 'q r'"#);
        assert_eq!(t, vec!["node", r"C:\a b\x.js", "--flag", "q r"]);
    }

    #[test]
    fn tool_name_is_the_part_before_the_paren() {
        assert_eq!(tool_of("Bash(git status:*)"), "Bash");
        assert_eq!(tool_of("WebFetch"), "WebFetch");
    }
}
