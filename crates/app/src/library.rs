//! Toolkit > Library: the commands behind the tab.
//!
//! The catalog comes from Claude Code's own plugin list and is cached in Atlas's data folder; the
//! tab paints from the cache. Network is used only when the tab is open and the cache is stale,
//! on Refresh, or when someone opens a plugin or checks a pasted link: one GitHub tarball
//! (HTTPS, redirects only inside github.com, 10 s to connect, 120 s in all, 25 MB at most),
//! unpacked by `atlas_core::library::archive` into a staging folder and only ever read. Nothing
//! downloaded is run. Writes go through `atlas_core::library::install` (Claude Code's own
//! command for plugins, the Setup write path for loose items), under the cross-process write lock.
//!
//! The page never sends a path: it names a staged check by a token this service made, and an item
//! by kind and name from that check.

use std::collections::{BTreeMap, HashMap};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Once};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use atlas_core::connect::{self, CliChoice};
use atlas_core::library::cli::Runner;
use atlas_core::library::{archive, catalog, install, ledger, link, shape};
use atlas_core::paths::ConfigRoot;
use atlas_core::setup_write as sw;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::setup_service::SetupHub;
use crate::state::AppState;

/// Download progress for the sheet's bar: `{ label, downloaded, total }` (total null when unknown).
pub const PROGRESS_EVENT: &str = "atlas://library/progress";
/// What the page shows when someone pressed Cancel.
pub const CANCELLED: &str = "Cancelled.";
const NOT_READY: &str = "Your Claude folder is not ready yet.";
const STALE_SECS: u64 = 6 * 3600;
const KEEP_STAGED: Duration = Duration::from_secs(7 * 24 * 3600);
const MAX_STAGED: usize = 24;
const MAX_VIEW_BYTES: u64 = 256 * 1024;

type Info<'a> = State<'a, Arc<AppState>>;
type Lib<'a> = State<'a, Arc<Library>>;
type Hub<'a> = State<'a, Arc<SetupHub>>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/// A checked folder the page can act on, by token.
struct Staged {
    /// The checked folder; `None` for a plugin Atlas can't read (nothing to show or copy).
    base: Option<PathBuf>,
    /// What the catalog listed when it was checked (an install must still match it).
    source: Option<catalog::Source>,
    repo: String,
    sha: String,
    tree_hash: String,
    shaped: shape::Shaped,
    plugin_id: Option<String>,
    /// `owner/repo` when the folder is a marketplace that can be added.
    market_source: Option<String>,
    /// What the marketplace's own entry for the plugin named when it was checked (its component
    /// fields as JSON, or why they could not be read); `None` for a plugin that was not checked.
    entry_fields: Option<String>,
}

#[derive(Default)]
pub struct Library {
    cancel: AtomicBool,
    next: AtomicU64,
    refreshing: AtomicBool,
    staged: Mutex<HashMap<u64, Staged>>,
}

impl Library {
    fn keep(&self, s: Staged) -> String {
        let n = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut g = self.staged.lock().unwrap_or_else(|p| p.into_inner());
        g.insert(n, s);
        while g.len() > MAX_STAGED {
            let Some(oldest) = g.keys().min().copied() else { break };
            g.remove(&oldest);
        }
        format!("s{n}")
    }

    fn with<T>(&self, token: &str, f: impl FnOnce(&Staged) -> Result<T, String>) -> Result<T, String> {
        let n: u64 = token.strip_prefix('s').and_then(|t| t.parse().ok()).ok_or("Check it again first.")?;
        let g = self.staged.lock().unwrap_or_else(|p| p.into_inner());
        let s = g.get(&n).ok_or("Check it again first.")?;
        f(s)
    }
}

struct Env {
    root: ConfigRoot,
    data: PathBuf,
    backups: PathBuf,
}

impl Env {
    fn of(st: &AppState) -> Result<Env, String> {
        let i = st.setup_inputs(false).ok_or(NOT_READY)?;
        Ok(Env { root: i.root, data: st.data_dir.clone(), backups: st.data_dir.join("setup-backups") })
    }

    fn ctx(&self) -> install::Ctx<'_> {
        install::Ctx { root: &self.root, data: &self.data, backups: &self.backups }
    }

    fn runner(&self) -> Result<Runner, String> {
        Runner::new(&CliChoice::Auto, &self.root).map_err(|e| e.message())
    }

    fn fetch_dir(&self) -> PathBuf {
        atlas_core::library::library_dir(&self.data).join("fetch")
    }
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/// A catalog row with only what a row draws and filters on (no source: that is read from the
/// saved catalog when a plugin is looked at or installed). About a third of the full entry.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SlimEntry {
    plugin_id: String,
    name: String,
    description: String,
    marketplace: String,
    version: String,
    /// Installing it runs a command: the row says Atlas does not offer it.
    by_command: bool,
}

impl From<catalog::Entry> for SlimEntry {
    fn from(e: catalog::Entry) -> Self {
        SlimEntry { by_command: matches!(e.source, catalog::Source::Command), plugin_id: e.plugin_id, name: e.name, description: e.description, marketplace: e.marketplace, version: e.version }
    }
}

/// How many rows the first answer carries: a screen and a bit. The rest comes from
/// `library_catalog_all` once the first rows are painted.
const FIRST_PAGE: usize = 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    /// Every entry, or (when `partial`) the first page in the list's order.
    entries: Vec<SlimEntry>,
    /// How many entries the whole catalog holds, and how many per marketplace (the source rail).
    total: usize,
    counts: BTreeMap<String, usize>,
    /// `entries` is only the first page: `library_catalog_all` has the rest.
    partial: bool,
    /// When the cache was made (None: there is no cache yet).
    fetched_ms: Option<u64>,
    now_ms: u64,
    /// Claude Code's command is on this computer (D24).
    cli: bool,
    /// Sandbox Mode: installs go to the copy.
    sandbox: bool,
    marketplaces: Vec<ledger::Marketplace>,
    /// The cache is older than six hours (or missing): the page should refresh in the background.
    stale: bool,
}

/// The whole catalog, slim, for the filter (sent after the first rows are on screen).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogAll {
    fetched_ms: Option<u64>,
    entries: Vec<SlimEntry>,
}

/// One catalog entry: from the saved catalog, or (before there is one) from the marketplace files
/// Claude Code keeps, so a row shown on the first visit can be looked at and installed.
fn entry_of(env: &Env, plugin_id: &str) -> Option<catalog::Entry> {
    if let Some(c) = catalog::read_cache(&env.data) {
        return c.entries.into_iter().find(|e| e.plugin_id == plugin_id);
    }
    let mp = plugin_id.rsplit_once('@').map(|(_, m)| m)?;
    let places: Vec<(String, PathBuf)> = ledger::marketplaces(&env.root.dir).into_iter().filter(|m| m.name == mp).filter_map(|m| m.install_location.map(|l| (m.name, PathBuf::from(l)))).collect();
    catalog::read_local(&places).into_iter().find(|e| e.plugin_id == plugin_id)
}

/// What the marketplace's own entry for `entry` names (hooks, servers, commands...): read from the
/// marketplace files Claude Code keeps, the same ones it installs from. `Err` is why it could not
/// be read, which the check shows as "can't read", never as clean.
///
/// The built-in plugin directory has no marketplace file on disk (and no record in
/// known_marketplaces.json), and its listing from `claude plugin list --available --json` carries
/// no component fields. A directory plugin's own entry lives in the repo it is fetched from, so
/// that is read instead: `repo` is (the fetched repo's root, the plugin's folder in it). `Ok(None)`
/// = the repo lists no entry for the folder but the plugin has its own manifest, which the check
/// reads with the files. A directory plugin with neither is `Err`, never "nothing to read".
fn entry_fields_of(env: &Env, entry: &catalog::Entry, repo: Option<(&Path, &Path)>) -> Result<Option<serde_json::Value>, String> {
    let record = ledger::marketplaces(&env.root.dir).into_iter().find(|m| m.name == entry.marketplace);
    match record {
        Some(m) => match m.install_location {
            Some(loc) => catalog::entry_components(Path::new(&loc), &entry.name).map(Some),
            None => Err("Atlas could not find the marketplace's files, so it could not read the plugin's own entry".to_string()),
        },
        None if entry.marketplace == catalog::DIRECTORY => {
            let in_repo = match (&entry.source, repo) {
                (catalog::Source::Github { path, .. }, Some((root, base))) => catalog::entry_components_in_repo(root, base, &entry.name, path.as_deref()),
                _ => Err("Atlas could not read the plugin's own entry in the catalog".to_string()),
            };
            // The official marketplace can also list the plugin by name, with its manifest inline.
            let official = match official_folder(env, entry, repo) {
                Some(dir) => catalog::entry_in_official(&dir, &entry.name, &entry.source),
                None => Ok(None),
            };
            join_fields(in_repo, official)
        }
        None => Err("Atlas could not find the marketplace's files, so it could not read the plugin's own entry".to_string()),
    }
}

/// Where the official marketplace's file is: the folder Claude Code keeps for it, else (a plugin
/// that is itself fetched from the official repo) the copy just fetched. `None` when neither is
/// on this computer: the official entries of external plugins are then not visible (an accepted
/// risk, docs/specs/skill-library.md).
fn official_folder(env: &Env, entry: &catalog::Entry, repo: Option<(&Path, &Path)>) -> Option<PathBuf> {
    if let Some(loc) = ledger::marketplaces(&env.root.dir).into_iter().find(|m| m.name == catalog::OFFICIAL).and_then(|m| m.install_location) {
        return Some(PathBuf::from(loc));
    }
    match (&entry.source, repo) {
        (catalog::Source::Github { repo: r, .. }, Some((root, _))) if r.eq_ignore_ascii_case(catalog::OFFICIAL_REPO) => Some(root.to_path_buf()),
        _ => None,
    }
}

/// The plugin's own repo and the official marketplace may both name what it loads: both are
/// checked. An official entry that can't be matched to this plugin is never skipped, and two
/// that disagree on a field are unreadable (neither can be vouched for over the other).
fn join_fields(in_repo: Result<Option<serde_json::Value>, String>, official: Result<Option<serde_json::Value>, String>) -> Result<Option<serde_json::Value>, String> {
    match (in_repo, official) {
        (_, Err(e)) | (Err(e), _) => Err(e),
        (own, Ok(None)) => own,
        (Ok(None), Ok(Some(v))) => Ok(Some(v)),
        (Ok(Some(serde_json::Value::Object(mut a))), Ok(Some(serde_json::Value::Object(b)))) => {
            for (k, v) in b {
                match a.get(&k) {
                    Some(x) if *x != v => return Err("The plugin's repo and the official marketplace name different things for this plugin, so Atlas could not tell what it loads".to_string()),
                    _ => {
                        a.insert(k, v);
                    }
                }
            }
            Ok(Some(serde_json::Value::Object(a)))
        }
        _ => Err("Atlas could not read the plugin's own entry in the catalog".to_string()),
    }
}

/// The plugin's entry is read from the repo it is fetched from (the built-in directory, which has
/// no record on this computer), not from a marketplace folder Claude Code keeps.
fn entry_is_in_repo(env: &Env, entry: &catalog::Entry) -> bool {
    entry.marketplace == catalog::DIRECTORY && !ledger::marketplaces(&env.root.dir).iter().any(|m| m.name == entry.marketplace)
}

/// What is kept with the token: the look as a comparable string. An entry read from the fetched
/// repo is marked, because it cannot be read again at install (the commit it came from is what is
/// installed, and the listing is compared separately).
fn staged_fields_key(env: &Env, entry: &catalog::Entry, r: &Result<Option<serde_json::Value>, String>) -> String {
    let k = entry_fields_key(r);
    if entry_is_in_repo(env, entry) { format!("repo:{k}") } else { k }
}

/// The same look as a comparable string, kept with the token and compared again at install.
fn entry_fields_key(r: &Result<Option<serde_json::Value>, String>) -> String {
    match r {
        Ok(Some(v)) => v.to_string(),
        Ok(None) => "none".to_string(),
        Err(e) => format!("!{e}"),
    }
}

/// The saved catalog, or (before there is one) what Claude Code already keeps on disk.
fn load_entries(env: &Env) -> (Vec<catalog::Entry>, Option<u64>, Vec<ledger::Marketplace>) {
    let marketplaces = ledger::marketplaces(&env.root.dir);
    match catalog::read_cache(&env.data) {
        Some(c) => (c.entries, Some(c.fetched_ms), marketplaces),
        // The very first visit: show what Claude Code already keeps on disk instead of an empty
        // tab while the real list is fetched (the page still refreshes, because `stale` is set).
        None => {
            let places: Vec<(String, PathBuf)> = marketplaces.iter().filter_map(|m| m.install_location.clone().map(|l| (m.name.clone(), PathBuf::from(l)))).collect();
            (catalog::read_local(&places), None, marketplaces)
        }
    }
}

/// `first_page_only`: the first `FIRST_PAGE` rows in the list's order (name, then marketplace),
/// with the counts of the whole catalog; else every entry.
fn view(st: &AppState, env: &Env, first_page_only: bool) -> CatalogView {
    let (mut entries, fetched_ms, marketplaces) = load_entries(env);
    let now = now_ms();
    let stale = fetched_ms.is_none_or(|f| now.saturating_sub(f) > STALE_SECS * 1000);
    let total = entries.len();
    let mut counts = BTreeMap::new();
    for e in &entries {
        *counts.entry(e.marketplace.clone()).or_insert(0) += 1;
    }
    let partial = first_page_only && total > FIRST_PAGE;
    if partial {
        entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.marketplace.cmp(&b.marketplace)));
        entries.truncate(FIRST_PAGE);
    }
    let sandbox = st.history_root().is_none();
    CatalogView { entries: entries.into_iter().map(SlimEntry::from).collect(), total, counts, partial, fetched_ms, now_ms: now, cli: CliChoice::Auto.found(), sandbox, marketplaces, stale }
}

/// The cached catalog and what Claude Code knows (read only, no network).
#[tauri::command]
pub async fn library_catalog(state: Info<'_>) -> Result<CatalogView, String> {
    let st = state.inner().clone();
    blocking(move || {
        let t = Instant::now();
        let env = Env::of(&st)?;
        // Staged repositories nobody opened for a week go.
        archive::prune(&env.fetch_dir(), KEEP_STAGED);
        let v = view(&st, &env, true);
        eprintln!("[atlas] library: catalog {} entries ({} sent) read in {} ms", v.total, v.entries.len(), t.elapsed().as_millis());
        Ok(v)
    })
    .await
}

/// Every entry, slim: what the page filters over once the first rows are painted.
#[tauri::command]
pub async fn library_catalog_all(state: Info<'_>) -> Result<CatalogAll, String> {
    let st = state.inner().clone();
    blocking(move || {
        let env = Env::of(&st)?;
        let (entries, fetched_ms, _) = load_entries(&env);
        Ok(CatalogAll { fetched_ms, entries: entries.into_iter().map(SlimEntry::from).collect() })
    })
    .await
}

/// The page reports how long the tab took to show rows (spec criterion 7's log line).
#[tauri::command]
pub fn library_perf(ms: f64) {
    if ms.is_finite() && ms >= 0.0 {
        eprintln!("[atlas] library: first rows {ms:.0} ms");
    }
}

/// Ask Claude Code for the catalog again (all marketplaces, or one first) and keep it.
#[tauri::command]
pub async fn library_refresh(state: Info<'_>, lib: Lib<'_>, marketplace: Option<String>) -> Result<CatalogView, String> {
    let (st, lib) = (state.inner().clone(), lib.inner().clone());
    blocking(move || {
        if lib.refreshing.swap(true, Ordering::SeqCst) {
            return Err("The catalog is already updating.".into());
        }
        let r = refresh_now(&st, marketplace.as_deref());
        lib.refreshing.store(false, Ordering::SeqCst);
        r
    })
    .await
}

fn refresh_now(st: &AppState, marketplace: Option<&str>) -> Result<CatalogView, String> {
    let env = Env::of(st)?;
    let runner = env.runner()?;
    atlas_core::fsutil::check_write_allowed(&env.root.dir).map_err(|e| e.to_string())?;
    // Listing writes small caches into the Claude folder, so it takes the same lock as an install.
    let _lock = atlas_core::writelock::acquire(&st.data_dir, Duration::from_secs(15)).map_err(|_| "Another Atlas change is in progress. Please try again in a moment.".to_string())?;
    let t = Instant::now();
    if let Some(m) = marketplace {
        let out = runner.marketplace_update(m).map_err(|e| e.message())?;
        if !out.ok {
            return Err(format!("{} The list was not changed.", out.message.trim_end_matches('.')) + ".");
        }
    }
    let text = runner.list_available().map_err(|e| e.message())?;
    let entries = catalog::parse_available(&text)?;
    save_listing(&env.data, entries, now_ms())?;
    eprintln!("[atlas] library: catalog refreshed in {} ms", t.elapsed().as_millis());
    Ok(view(st, &env, false))
}

/// Keep what Claude Code listed. A sudden empty answer never replaces a list that is already
/// saved (it would wipe what the user can see). With no list to keep, empty is the true answer: a
/// fresh Claude Code has added no plugin catalogs yet, so the empty list is saved (the page then
/// says so and offers the official catalog) and it is not an error.
fn save_listing(data: &Path, entries: Vec<catalog::Entry>, now: u64) -> Result<(), String> {
    if entries.is_empty() && catalog::read_cache(data).is_some_and(|c| !c.entries.is_empty()) {
        return Err("Claude Code's plugin list came back empty, so Atlas kept the list it had.".into());
    }
    catalog::write_cache(data, entries, now).map_err(|_| "Atlas could not save the catalog.".to_string())
}

/// What is installed: Claude Code's plugins and the items the Library copied.
#[tauri::command]
pub async fn library_installed(state: Info<'_>) -> Result<Vec<ledger::InstalledRow>, String> {
    let st = state.inner().clone();
    blocking(move || {
        let env = Env::of(&st)?;
        Ok(ledger::installed_rows(&env.root.dir, &env.root.claude_json, &env.data))
    })
    .await
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    label: String,
    downloaded: u64,
    total: Option<u64>,
}

/// The base address of the tarball host. Tests point it at a local server (debug builds, and
/// release builds made with `dev-update`); the shipped build never does.
fn base_url() -> (String, bool) {
    #[cfg(any(debug_assertions, feature = "dev-update"))]
    if let Some(u) = std::env::var("ATLAS_LIBRARY_GITHUB_BASE").ok().map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()) {
        return (u, true);
    }
    ("https://codeload.github.com".to_string(), false)
}

fn host_of(url: &str) -> String {
    url.split("://").nth(1).unwrap_or("").split(['/', ':']).next().unwrap_or("").to_ascii_lowercase()
}

fn client(base: &str, overridden: bool) -> Result<reqwest::Client, String> {
    static PROVIDER: Once = Once::new();
    PROVIDER.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let own_host = host_of(base);
    let policy = reqwest::redirect::Policy::custom(move |attempt| {
        let host = attempt.url().host_str().unwrap_or("").to_ascii_lowercase();
        let https = attempt.url().scheme() == "https";
        let ok = if overridden { host == own_host } else { https && (host == "github.com" || host == "codeload.github.com") };
        if attempt.previous().len() >= 5 {
            attempt.error("too many redirects")
        } else if ok {
            attempt.follow()
        } else {
            attempt.error("redirect outside github.com")
        }
    });
    reqwest::Client::builder()
        .user_agent(concat!("Atlas/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(120))
        .redirect(policy)
        .build()
        .map_err(|_| "Atlas could not start its download.".to_string())
}

fn is_sha(s: &str) -> bool {
    s.len() == 40 && s.chars().all(|c| c.is_ascii_hexdigit())
}

/// The repository at `git_ref`, staged under `<data>/library/fetch/`. A commit that is already
/// staged is not downloaded again.
async fn fetch(app: &AppHandle, lib: &Library, env_fetch_dir: PathBuf, repo: &str, git_ref: &str, known_sha: Option<&str>) -> Result<archive::Unpacked, String> {
    let l = link::parse(repo).map_err(|m| m.to_string())?;
    let prefix = format!("{}-{}", l.owner, l.repo);
    if let Some(sha) = known_sha.filter(|s| is_sha(s)) {
        let dir = env_fetch_dir.join(format!("{prefix}-{}", &sha[..12]));
        if dir.is_dir() {
            archive::touch(&dir);
            return Ok(archive::Unpacked { dir, sha: Some(sha.to_string()), files: 0, bytes: 0 });
        }
    }
    lib.cancel.store(false, Ordering::SeqCst);
    let (base, overridden) = base_url();
    let url = format!("{base}/{}/{}/tar.gz/{git_ref}", l.owner, l.repo);
    let label = format!("{}/{}", l.owner, l.repo);
    let say = |downloaded: u64, total: Option<u64>| {
        let _ = app.emit(PROGRESS_EVENT, Progress { label: label.clone(), downloaded, total });
    };
    say(0, None);
    let mut resp = client(&base, overridden)?.get(&url).send().await.map_err(plain_net)?;
    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 | 410 => "Atlas could not find that on GitHub. Check the link (a private repository can't be read).".to_string(),
            403 | 429 => "GitHub is limiting requests right now. Try again in a few minutes.".to_string(),
            c => format!("GitHub answered with an error ({c}). Try again in a moment."),
        });
    }
    let total = resp.content_length();
    if total.is_some_and(|t| t > archive::MAX_COMPRESSED) {
        return Err(archive::TOO_BIG.into());
    }
    let mut bytes: Vec<u8> = Vec::with_capacity(total.unwrap_or(256 * 1024).min(archive::MAX_COMPRESSED) as usize);
    let mut last = Instant::now();
    while let Some(chunk) = resp.chunk().await.map_err(plain_net)? {
        if lib.cancel.load(Ordering::SeqCst) {
            return Err(CANCELLED.into());
        }
        bytes.extend_from_slice(&chunk);
        if bytes.len() as u64 > archive::MAX_COMPRESSED {
            return Err(archive::TOO_BIG.into());
        }
        if last.elapsed() > Duration::from_millis(80) {
            last = Instant::now();
            say(bytes.len() as u64, total);
        }
    }
    say(bytes.len() as u64, total.or(Some(bytes.len() as u64)));
    if lib.cancel.load(Ordering::SeqCst) {
        return Err(CANCELLED.into());
    }
    let un = tauri::async_runtime::spawn_blocking(move || archive::unpack(Cursor::new(bytes), &env_fetch_dir, &prefix)).await.map_err(|e| e.to_string())??;
    archive::touch(&un.dir);
    Ok(un)
}

fn plain_net(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "GitHub took too long to answer. Try again in a moment.".into()
    } else if e.is_redirect() {
        "GitHub sent Atlas somewhere it will not go, so nothing was read.".into()
    } else if e.is_connect() {
        "Atlas could not reach GitHub. Check your connection.".into()
    } else {
        "The download did not finish. Check your connection and try again.".into()
    }
}

/// Stop the download in progress (the sheet's Cancel).
#[tauri::command]
pub fn library_cancel(lib: Lib<'_>) {
    lib.cancel.store(true, Ordering::SeqCst);
}

// ---------------------------------------------------------------------------
// Looking at things
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Taken {
    kind: String,
    name: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    token: String,
    /// `owner/repo` ("" for a plugin that lives inside its marketplace).
    repo: String,
    sha: String,
    subpath: Option<String>,
    inspected: install::Inspected,
    /// Items whose names are already in the user's folder (never replaced).
    taken: Vec<Taken>,
    /// The folder is a marketplace that can be added (its `owner/repo`).
    market_source: Option<String>,
    /// Why this one is never installed from the row in one click (a plain sentence), or None.
    confirm_note: Option<String>,
}

fn takens(env: &Env, i: &install::Inspected) -> Vec<Taken> {
    let ctx = env.ctx();
    i.shaped.items.iter().filter_map(|it| install::conflict(&ctx, it).map(|message| Taken { kind: it.kind.clone(), name: it.name.clone(), message })).collect()
}

/// A catalog plugin's files and what they could do.
#[tauri::command]
pub async fn library_inspect_plugin(app: AppHandle, state: Info<'_>, lib: Lib<'_>, plugin_id: String) -> Result<Detail, String> {
    let st = state.inner().clone();
    let env = Env::of(&st)?;
    let entry = entry_of(&env, &plugin_id).ok_or("That plugin is not in the catalog. Press Refresh.")?;
    if let Some(m) = install::blocked(&entry.source) {
        return Err(m.into());
    }
    let name = entry.name.clone();
    let (base, repo, sha, subpath, repo_root) = match &entry.source {
        catalog::Source::Github { repo, sha, path, .. } => {
            // Exactly what Claude Code installs: the pinned commit, else the named branch or tag, else HEAD.
            let want = install::fetch_target(&entry.source).unwrap_or("HEAD");
            let un = fetch(&app, &lib, env.fetch_dir(), repo, want, sha.as_deref()).await?;
            let base = install::resolve_base(&un.dir, path.as_deref())?;
            (Some(base), repo.clone(), un.sha.or_else(|| sha.clone()).unwrap_or_default(), path.clone(), Some(un.dir.clone()))
        }
        catalog::Source::Local { path } => {
            let (dir, mp, p) = (env.root.dir.clone(), entry.marketplace.clone(), path.clone());
            let base = blocking(move || install::local_base(&dir, &mp, &p)).await?;
            (Some(base), String::new(), String::new(), Some(path.clone()), None)
        }
        // Another git host or a source Atlas can't read: nothing to look at, a deliberate two-click install.
        _ => (None, String::new(), String::new(), None, None),
    };
    // The marketplace's own entry can name hooks and servers too (strict: false); they are
    // checked with the files, and an entry Atlas can't read is never "clean".
    let fields = base.as_ref().map(|b| entry_fields_of(&env, &entry, repo_root.as_deref().map(|r| (r, b.as_path()))));
    let inspected = match base.clone() {
        Some(b2) => {
            let fields = fields.clone();
            blocking(move || {
                let kind = match &fields {
                    Some(Ok(Some(v))) => atlas_core::library::check::EntryFields::Fields(v),
                    Some(Err(e)) => atlas_core::library::check::EntryFields::Unreadable(e),
                    Some(Ok(None)) | None => atlas_core::library::check::EntryFields::Absent,
                };
                Ok(install::inspect_plugin_entry(&b2, &name, kind))
            })
            .await?
        }
        None => install::inspect_unchecked(&name),
    };
    let detail = Detail {
        token: lib.keep(Staged {
            base,
            source: Some(entry.source.clone()),
            repo: repo.clone(),
            sha: sha.clone(),
            tree_hash: inspected.check.tree_hash.clone(),
            shaped: inspected.shaped.clone(),
            plugin_id: Some(plugin_id),
            market_source: None,
            entry_fields: fields.as_ref().map(|f| staged_fields_key(&env, &entry, f)),
        }),
        repo,
        sha,
        subpath,
        taken: Vec::new(),
        inspected,
        market_source: None,
        confirm_note: install::confirm_note(&entry.source).map(str::to_string),
    };
    Ok(detail)
}

/// An installed plugin, looked at again from the files Claude Code installed (no network). The
/// ledger takes the new look as the one the user has seen.
#[tauri::command]
pub async fn library_inspect_installed(state: Info<'_>, lib: Lib<'_>, id: String) -> Result<Detail, String> {
    let (st, lib) = (state.inner().clone(), lib.inner().clone());
    blocking(move || {
        let env = Env::of(&st)?;
        let rec = ledger::user_install(&env.root.dir, &id).ok_or("That plugin is not installed.")?;
        let dir = rec.install_path.as_deref().map(PathBuf::from).ok_or("Atlas could not find that plugin's files.")?;
        let plugins = std::fs::canonicalize(env.root.dir.join("plugins")).map_err(|_| "Atlas could not find that plugin's files.".to_string())?;
        let base = std::fs::canonicalize(&dir).map_err(|_| "That plugin's files are not on this computer.".to_string())?;
        if !base.starts_with(&plugins) || !base.is_dir() {
            return Err("That plugin's files are not where Claude Code keeps them.".into());
        }
        let name = id.split('@').next().unwrap_or(&id).to_string();
        let inspected = install::inspect_plugin(&base, &name);
        let _ = ledger::recheck(&env.data, &id, &inspected.check.tree_hash);
        let repo = ledger::find(&env.data, "plugin", &id).map(|e| e.repo).unwrap_or_default();
        let sha = rec.git_sha.clone().unwrap_or_default();
        let token = lib.keep(Staged { base: Some(base), source: None, repo: repo.clone(), sha: sha.clone(), tree_hash: inspected.check.tree_hash.clone(), shaped: inspected.shaped.clone(), plugin_id: Some(id), market_source: None, entry_fields: None });
        Ok(Detail { token, repo, sha, subpath: None, taken: Vec::new(), inspected, market_source: None, confirm_note: None })
    })
    .await
}

/// A pasted GitHub link: what it holds and what it could do.
#[tauri::command]
pub async fn library_inspect_link(app: AppHandle, state: Info<'_>, lib: Lib<'_>, text: String) -> Result<Detail, String> {
    let st = state.inner().clone();
    let l = link::parse(&text).map_err(|m| m.to_string())?;
    let env = Env::of(&st)?;
    let git_ref = l.ref_or_head().to_string();
    let known = is_sha(&git_ref).then(|| git_ref.clone());
    let un = fetch(&app, &lib, env.fetch_dir(), &l.slug(), &git_ref, known.as_deref()).await?;
    let base = install::resolve_base(&un.dir, l.path.as_deref())?;
    let (b2, name) = (base.clone(), l.repo.clone());
    let inspected = blocking(move || Ok(install::inspect_link(&b2, &name))).await?;
    let taken = takens(&env, &inspected);
    let market_source = (inspected.shaped.shape == "marketplace").then(|| l.slug());
    let sha = un.sha.clone().unwrap_or_default();
    let token = lib.keep(Staged { base: Some(base), source: None, repo: l.slug(), sha: sha.clone(), tree_hash: inspected.check.tree_hash.clone(), shaped: inspected.shaped.clone(), plugin_id: None, market_source: market_source.clone(), entry_fields: None });
    Ok(Detail { token, repo: l.slug(), sha, subpath: l.path.clone(), inspected, taken, market_source, confirm_note: None })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileText {
    text: String,
    truncated: bool,
}

/// One text file of a checked folder, read only, secrets masked (the "What's inside" viewer).
#[tauri::command]
pub async fn library_read_file(lib: Lib<'_>, token: String, rel: String) -> Result<FileText, String> {
    let lib = lib.inner().clone();
    blocking(move || {
        let base = lib.with(&token, |s| s.base.clone().ok_or_else(|| "Atlas could not read this plugin's files, so there is nothing to show.".to_string()))?;
        let file = sw::safe_join(&base, rel.trim_start_matches(['/', '\\'])).map_err(|_| "That file is not inside the plugin.".to_string())?;
        let md = std::fs::symlink_metadata(&file).map_err(|_| "Atlas could not find that file.".to_string())?;
        if !md.is_file() {
            return Err("Atlas can only show files.".into());
        }
        use std::io::Read;
        let mut buf = Vec::new();
        std::fs::File::open(&file).and_then(|f| f.take(MAX_VIEW_BYTES).read_to_end(&mut buf)).map_err(|_| "Atlas could not read that file.".to_string())?;
        let text = String::from_utf8(buf).map_err(|_| "Atlas can only show text files.".to_string())?;
        Ok(FileText { text: atlas_core::search::mask::mask_secrets(&text).into_owned(), truncated: md.len() > MAX_VIEW_BYTES })
    })
    .await
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/// Install a plugin the user has looked at (the token is that look).
#[tauri::command]
pub async fn library_install_plugin(app: AppHandle, state: Info<'_>, lib: Lib<'_>, plugin_id: String, token: String) -> Result<install::PluginOutcome, String> {
    let (st, lib) = (state.inner().clone(), lib.inner().clone());
    blocking(move || {
        let out = install_checked(&st, &lib, &plugin_id, &token);
        // The change is done and its backup tagged: History looks again so its rows say what it was.
        let _ = app.emit(crate::history::POKE_EVENT, ());
        out
    })
    .await
}

fn install_checked(st: &Arc<AppState>, lib: &Library, plugin_id: &str, token: &str) -> Result<install::PluginOutcome, String> {
    let env = Env::of(st)?;
    let (repo, sha, tree_hash, checked_source, checked_fields) = lib.with(token, |s| {
        if s.plugin_id.as_deref() != Some(plugin_id) {
            return Err("Check it again first.".to_string());
        }
        Ok((s.repo.clone(), s.sha.clone(), s.tree_hash.clone(), s.source.clone(), s.entry_fields.clone()))
    })?;
    // The listing may have been refreshed since the look (review finding 3): what Claude Code
    // would install now has to be what was checked, or nothing is installed.
    let entry = entry_of(&env, plugin_id);
    let source = entry.as_ref().map(|e| e.source.clone());
    let checked_source = checked_source.ok_or("Check it again first.")?;
    install::same_listing(&checked_source, source.as_ref())?;
    // ... and so does what the marketplace's own entry says the plugin loads.
    if let (Some(was), Some(e)) = (checked_fields, entry.as_ref()) {
        let moved = if was.starts_with("repo:") { !entry_is_in_repo(&env, e) } else { was != entry_fields_key(&entry_fields_of(&env, e, None)) };
        if moved {
            return Err(install::LISTING_MOVED.into());
        }
    }
    let source = source.ok_or("That plugin is not in the catalog. Press Refresh.")?;
    let runner = env.runner()?;
    install::install_plugin(&env.ctx(), &runner, plugin_id, &source, &install::Checked { repo: &repo, sha: &sha, tree_hash: &tree_hash })
}

#[tauri::command]
pub async fn library_uninstall_plugin(app: AppHandle, state: Info<'_>, id: String) -> Result<String, String> {
    let st = state.inner().clone();
    blocking(move || {
        let env = Env::of(&st)?;
        let out = install::uninstall_plugin(&env.ctx(), &env.runner()?, &id);
        let _ = app.emit(crate::history::POKE_EVENT, ());
        out
    })
    .await
}

/// Undo a Library plugin install or removal (the toast's Undo and History's Undo): an install is
/// undone by uninstalling, a removal by installing the same commit again.
#[tauri::command]
pub async fn library_undo(app: AppHandle, state: Info<'_>, hub: Hub<'_>, backup_id: String) -> Result<install::UndoDone, String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let env = Env::of(&st)?;
        let op = sw::library_op(&env.backups, &backup_id).ok_or("That change can't be undone from here.")?;
        let now = entry_of(&env, &op.id).map(|e| e.source);
        let done = install::undo_plugin_backup(&env.ctx(), &env.runner()?, &backup_id, now.as_ref());
        // Also when it failed: a take-out after a bad install leaves its own backups.
        hub.refresh(&app, &st);
        let _ = app.emit(crate::history::POKE_EVENT, ());
        done
    })
    .await
}

#[tauri::command]
pub async fn library_set_enabled(state: Info<'_>, id: String, on: bool) -> Result<(), String> {
    let st = state.inner().clone();
    blocking(move || {
        let env = Env::of(&st)?;
        install::set_plugin_enabled(&env.ctx(), &env.runner()?, &id, on)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Added {
    name: String,
    backup_id: String,
    catalog: CatalogView,
}

/// Add the marketplace a pasted link turned out to be, then list what it holds.
#[tauri::command]
pub async fn library_add_marketplace(state: Info<'_>, lib: Lib<'_>, token: String) -> Result<Added, String> {
    let (st, lib) = (state.inner().clone(), lib.inner().clone());
    blocking(move || {
        let env = Env::of(&st)?;
        let source = lib.with(&token, |s| s.market_source.clone().ok_or_else(|| "That link is not a marketplace.".to_string()))?;
        let out = install::add_marketplace(&env.ctx(), &env.runner()?, &source)?;
        let catalog = refresh_now(&st, None).or_else(|_| Ok::<_, String>(view(&st, &env, false)))?;
        Ok(Added { name: out.name, backup_id: out.backup_id, catalog })
    })
    .await
}

/// The empty Library's one action: add Anthropic's official plugin catalog (the same guarded
/// `plugin marketplace add` as a pasted link: backup first, the write guard, one lock), then list it.
#[tauri::command]
pub async fn library_add_official_catalog(state: Info<'_>, lib: Lib<'_>) -> Result<Added, String> {
    let (st, lib) = (state.inner().clone(), lib.inner().clone());
    blocking(move || {
        if lib.refreshing.swap(true, Ordering::SeqCst) {
            return Err("The catalog is already updating.".into());
        }
        let r = add_official_now(&st);
        lib.refreshing.store(false, Ordering::SeqCst);
        r
    })
    .await
}

fn add_official_now(st: &AppState) -> Result<Added, String> {
    let env = Env::of(st)?;
    let out = install::add_marketplace(&env.ctx(), &env.runner()?, catalog::OFFICIAL_REPO)?;
    let catalog = refresh_now(st, None).or_else(|_| Ok::<_, String>(view(st, &env, false)))?;
    Ok(Added { name: out.name, backup_id: out.backup_id, catalog })
}

#[derive(Deserialize)]
pub struct Pick {
    kind: String,
    name: String,
}

/// Copy the ticked items of a checked folder into the user's Claude folder.
#[tauri::command]
pub async fn library_install_items(app: AppHandle, state: Info<'_>, lib: Lib<'_>, hub: Hub<'_>, token: String, picks: Vec<Pick>) -> Result<Vec<install::ItemResult>, String> {
    let (st, lib, hub) = (state.inner().clone(), lib.inner().clone(), hub.inner().clone());
    blocking(move || {
        let env = Env::of(&st)?;
        let (base, repo, sha, tree_hash, items) = lib.with(&token, |s| {
            let items: Vec<shape::Item> = picks.iter().filter_map(|p| s.shaped.items.iter().find(|i| i.kind == p.kind && i.name == p.name).cloned()).collect();
            let base = s.base.clone().ok_or_else(|| "Atlas could not read these files.".to_string())?;
            Ok((base, s.repo.clone(), s.sha.clone(), s.tree_hash.clone(), items))
        })?;
        if items.is_empty() {
            return Err("Nothing is ticked.".into());
        }
        atlas_core::fsutil::check_write_allowed(&env.root.dir).map_err(|e| e.to_string())?;
        let cli = CliChoice::Auto;
        let root = env.root.clone();
        let add = move |name: &str, entry: &serde_json::Value| connect::cli_add_json(&CliChoice::Auto, &root, name, entry);
        // Without Claude Code's command, an MCP server falls back to Atlas's guarded edit.
        let adder: Option<sw::McpAdder> = cli.found().then_some(&add);
        let out = install::install_items(&env.ctx(), &base, &items, &install::Origin { repo: &repo, sha: &sha, tree_hash: &tree_hash }, adder)?;
        hub.refresh(&app, &st);
        Ok(out)
    })
    .await
}

/// Take away something the Library copied (an Undo of that copy; the files go into Atlas's backup
/// and the computer's trash).
#[tauri::command]
pub async fn library_remove_item(app: AppHandle, state: Info<'_>, hub: Hub<'_>, backup_id: String) -> Result<(), String> {
    let (st, hub) = (state.inner().clone(), hub.inner().clone());
    blocking(move || {
        let env = Env::of(&st)?;
        if !ledger::read(&env.data).entries.iter().any(|e| e.kind == "item" && e.backup_id == backup_id) {
            return Err("Atlas did not install that, so it will not remove it here. Use Toolkit to delete it.".into());
        }
        let d = hub.current(&app, &st)?;
        let confine = sw::Confine::from_discovery(&env.root.dir, &env.root.claude_json, &d);
        install::undo_install(&env.ctx(), &backup_id, &confine, true)?;
        hub.refresh(&app, &st);
        Ok(())
    })
    .await
}

/// Open the repository's page in the browser.
#[tauri::command]
pub async fn library_open_repo(repo: String) -> Result<(), String> {
    blocking(move || crate::commands::open_github(&repo)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_core::paths::ConfigSource;

    fn entry(marketplace: &str) -> catalog::Entry {
        catalog::Entry {
            plugin_id: format!("fd@{marketplace}"),
            name: "fd".into(),
            description: String::new(),
            marketplace: marketplace.into(),
            version: "1.0.0".into(),
            source: catalog::Source::Github { repo: "o/r".into(), sha: Some("abc1234".into()), path: None, git_ref: None },
        }
    }

    fn env_at(dir: &Path) -> Env {
        let root = ConfigRoot { dir: dir.to_path_buf(), claude_json: dir.join(".claude.json"), projects_dir: dir.join("projects"), projects_read_only: false, source: ConfigSource::Flag };
        Env { root, data: dir.join("data"), backups: dir.join("data").join("setup-backups") }
    }

    fn listed(n: &str) -> catalog::Entry {
        let mut e = entry("m");
        e.plugin_id = format!("{n}@m");
        e.name = n.into();
        e
    }

    #[test]
    fn an_empty_listing_with_no_saved_list_is_a_valid_answer_not_an_error() {
        // A fresh Claude Code has no plugin catalogs: `available` is [] and exit 0 (seen on a
        // clean macOS runner with 0.1.5, which showed "The Library could not load").
        let t = tempfile::tempdir().unwrap();
        assert!(catalog::read_cache(t.path()).is_none());
        let parsed = catalog::parse_available(r#"{"installed":[],"available":[]}"#).unwrap();
        assert!(parsed.is_empty());
        save_listing(t.path(), parsed, 5).unwrap();
        let saved = catalog::read_cache(t.path()).unwrap();
        assert_eq!((saved.fetched_ms, saved.entries.len()), (5, 0));
        // Asked again, still empty: still fine, and the time moves on.
        save_listing(t.path(), Vec::new(), 9).unwrap();
        assert_eq!(catalog::read_cache(t.path()).unwrap().fetched_ms, 9);
    }

    #[test]
    fn an_empty_listing_never_replaces_a_saved_list() {
        let t = tempfile::tempdir().unwrap();
        catalog::write_cache(t.path(), vec![listed("a"), listed("b")], 1).unwrap();
        let err = save_listing(t.path(), Vec::new(), 2).unwrap_err();
        assert!(err.contains("kept the list it had"), "{err}");
        let kept = catalog::read_cache(t.path()).unwrap();
        assert_eq!((kept.fetched_ms, kept.entries.len()), (1, 2));
        // A real answer replaces it.
        save_listing(t.path(), vec![listed("c")], 3).unwrap();
        assert_eq!(catalog::read_cache(t.path()).unwrap().entries.len(), 1);
    }

    #[test]
    fn an_external_plugins_inline_fields_in_the_official_marketplace_are_checked_too() {
        // Security review (LOW): box, amd-skills... have a plugin.json (or nothing) in their own repo
        // and name their skills, hooks or servers inline in claude-plugins-official's entry.
        let t = tempfile::tempdir().unwrap();
        let env = env_at(t.path());
        std::fs::create_dir_all(t.path().join("plugins")).unwrap();
        let official = t.path().join("official");
        std::fs::create_dir_all(official.join(".claude-plugin")).unwrap();
        let sha = "1111111111111111111111111111111111111111";
        let write_official = |body: &str| std::fs::write(official.join(".claude-plugin/marketplace.json"), body).unwrap();
        std::fs::write(t.path().join("plugins/known_marketplaces.json"), format!(r#"{{"claude-plugins-official":{{"source":{{"source":"github","repo":"a/b"}},"installLocation":{}}}}}"#, serde_json::to_string(&official).unwrap())).unwrap();
        // The plugin's own repo, fetched: a plugin.json that names nothing.
        let repo = t.path().join("repo");
        std::fs::create_dir_all(repo.join(".claude-plugin")).unwrap();
        std::fs::write(repo.join(".claude-plugin/plugin.json"), r#"{"name":"box"}"#).unwrap();
        std::fs::create_dir_all(repo.join("skills/a")).unwrap();
        std::fs::write(repo.join("skills/a/SKILL.md"), "---
name: a
description: Notes
---
Help with notes.
").unwrap();
        let mut e = entry(catalog::DIRECTORY);
        e.name = "box".into();
        e.source = catalog::Source::Github { repo: "box/skills".into(), sha: Some(sha.into()), path: None, git_ref: None };
        let listing = |extra: &str| format!(r#"{{"plugins":[{{"name":"box","source":{{"source":"url","url":"https://github.com/box/skills.git","sha":"{sha}"}},"strict":false{extra}}}]}}"#);
        let check = |f: &Result<Option<serde_json::Value>, String>| atlas_core::library::check::check_tree_entry(&repo, &[], atlas_core::library::check::EntryFields::Fields(f.as_ref().unwrap().as_ref().unwrap()));
        // Inline skills: read, shown, not a flag.
        write_official(&listing(r#","skills":["./skills/a"]"#));
        let f = entry_fields_of(&env, &e, Some((&repo, &repo)));
        assert_eq!(f.as_ref().unwrap().as_ref().unwrap()["skills"][0], "./skills/a");
        assert!(check(&f).flags.is_empty(), "{:?}", check(&f).flags.iter().map(|f| &f.code).collect::<Vec<_>>());
        // Inline hooks or language servers: flagged, so two clicks.
        write_official(&listing(r#","hooks":{"PreToolUse":[{"hooks":[{"type":"command","command":"x"}]}]},"lspServers":{"x":{"command":"x"}}"#));
        let f = entry_fields_of(&env, &e, Some((&repo, &repo)));
        let codes: Vec<String> = check(&f).flags.iter().map(|f| f.code.to_string()).collect();
        assert!(codes.iter().any(|c| c == "commands"), "{codes:?}");
        // The name is listed there from another repo or another commit: unreadable.
        write_official(&listing("").replace("box/skills.git", "someone/else.git"));
        assert!(entry_fields_of(&env, &e, Some((&repo, &repo))).is_err());
        write_official(&listing("").replace(sha, "2222222222222222222222222222222222222222"));
        assert!(entry_fields_of(&env, &e, Some((&repo, &repo))).is_err());
        // Not listed there at all: only its own repo counts, as before.
        write_official(r#"{"plugins":[]}"#);
        assert_eq!(entry_fields_of(&env, &e, Some((&repo, &repo))).unwrap(), None);
        // No official folder on this computer and a plugin from elsewhere: the entry is not visible
        // (accepted risk, docs/specs/skill-library.md), the plugin's own files are still checked.
        std::fs::remove_file(t.path().join("plugins/known_marketplaces.json")).unwrap();
        assert!(official_folder(&env, &e, Some((&repo, &repo))).is_none());
        assert_eq!(entry_fields_of(&env, &e, Some((&repo, &repo))).unwrap(), None);
        // ... but a plugin fetched from the official repo itself has the file in hand.
        let mut own = e.clone();
        own.source = catalog::Source::Github { repo: "Anthropics/Claude-Plugins-Official".into(), sha: Some(sha.into()), path: Some("plugins/box".into()), git_ref: None };
        assert!(official_folder(&env, &own, Some((&repo, &repo))).is_some());
    }

    #[test]
    fn the_built_in_directory_has_no_marketplace_file_and_that_is_not_a_failure() {
        // Security review: the directory is not in known_marketplaces.json, so every one of its
        // plugins got an "unreadable entry" flag and the one-click install never fired.
        let t = tempfile::tempdir().unwrap();
        let env = env_at(t.path());
        std::fs::create_dir_all(t.path().join("plugins")).unwrap();
        let official = t.path().join("official");
        std::fs::create_dir_all(official.join(".claude-plugin")).unwrap();
        std::fs::write(official.join(".claude-plugin/marketplace.json"), r#"{"plugins":[]}"#).unwrap();
        std::fs::write(t.path().join("plugins/known_marketplaces.json"), format!(r#"{{"claude-plugins-official":{{"source":{{"source":"github","repo":"a/b"}},"installLocation":{}}}}}"#, serde_json::to_string(&official).unwrap())).unwrap();
        // The directory: its entry is read from the repo the plugin is fetched from.
        let repo = t.path().join("repo");
        let base = repo.join("plugins/fd");
        std::fs::create_dir_all(repo.join(".claude-plugin")).unwrap();
        std::fs::create_dir_all(base.join(".claude-plugin")).unwrap();
        std::fs::write(repo.join(".claude-plugin/marketplace.json"), r#"{"plugins":[{"name":"fd","source":"./plugins/fd","strict":false,"lspServers":{"fd":{"command":"fd-server"}}}]}"#).unwrap();
        let mut gopls = entry(catalog::DIRECTORY);
        gopls.source = catalog::Source::Github { repo: "o/r".into(), sha: Some("abc1234".into()), path: Some("plugins/fd".into()), git_ref: None };
        let fields = entry_fields_of(&env, &gopls, Some((&repo, &base)));
        assert_eq!(fields.as_ref().unwrap().as_ref().unwrap()["lspServers"]["fd"]["command"], "fd-server");
        assert!(entry_is_in_repo(&env, &gopls));
        assert!(staged_fields_key(&env, &gopls, &fields).starts_with("repo:"));
        // ... the check of those files is flagged (a language server runs a program), not clean.
        let c = atlas_core::library::check::check_tree_entry(&base, &[], atlas_core::library::check::EntryFields::Fields(fields.as_ref().unwrap().as_ref().unwrap()));
        assert!(c.flags.iter().any(|f| f.code == "commands"), "{:?}", c.flags.iter().map(|f| &f.code).collect::<Vec<_>>());
        assert!(c.summary.is_empty());
        // No repo to read, or no entry and no manifest in it: unreadable, never Absent.
        assert!(entry_fields_of(&env, &gopls, None).is_err());
        let mut other = gopls.clone();
        other.name = "other".into();
        other.source = catalog::Source::Github { repo: "o/r".into(), sha: Some("abc1234".into()), path: Some("plugins/other".into()), git_ref: None };
        std::fs::create_dir_all(repo.join("plugins/other")).unwrap();
        assert!(entry_fields_of(&env, &other, Some((&repo, &repo.join("plugins/other")))).is_err());
        // Any other marketplace Atlas cannot find stays an honest failure (the entry may hold hooks).
        let err = entry_fields_of(&env, &entry("some-other"), None).unwrap_err();
        assert!(err.contains("could not find the marketplace"), "{err}");
        assert!(entry_fields_key(&Err(err)).starts_with('!'));
        // A record that names the directory but has no folder is not "no record at all".
        std::fs::write(t.path().join("plugins/known_marketplaces.json"), r#"{"anthropic-plugin-directory":{"source":{"source":"github","repo":"a/b"}}}"#).unwrap();
        assert!(!entry_is_in_repo(&env, &gopls));
        assert!(entry_fields_of(&env, &gopls, Some((&repo, &base))).is_err());
    }
}
