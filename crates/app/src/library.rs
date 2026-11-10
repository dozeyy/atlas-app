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

use std::collections::HashMap;
use std::io::Cursor;
use std::path::PathBuf;
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogView {
    entries: Vec<catalog::Entry>,
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

fn view(st: &AppState, env: &Env) -> CatalogView {
    let cache = catalog::read_cache(&env.data);
    let now = now_ms();
    let stale = cache.as_ref().is_none_or(|c| now.saturating_sub(c.fetched_ms) > STALE_SECS * 1000);
    let marketplaces = ledger::marketplaces(&env.root.dir);
    let (entries, fetched_ms) = match cache {
        Some(c) => (c.entries, Some(c.fetched_ms)),
        // The very first visit: show what Claude Code already keeps on disk instead of an empty
        // tab while the real list is fetched (the page still refreshes, because `stale` is set).
        None => {
            let places: Vec<(String, PathBuf)> = marketplaces.iter().filter_map(|m| m.install_location.clone().map(|l| (m.name.clone(), PathBuf::from(l)))).collect();
            (catalog::read_local(&places), None)
        }
    };
    let sandbox = st.history_root().is_none();
    CatalogView { entries, fetched_ms, now_ms: now, cli: CliChoice::Auto.found(), sandbox, marketplaces, stale }
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
        let v = view(&st, &env);
        eprintln!("[atlas] library: catalog {} entries read in {} ms", v.entries.len(), t.elapsed().as_millis());
        Ok(v)
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
    if entries.is_empty() {
        // An empty answer would wipe the list the user can already see (and the saved copy).
        return Err("Claude Code's plugin list came back empty, so Atlas kept the list it had.".into());
    }
    catalog::write_cache(&env.data, entries, now_ms()).map_err(|_| "Atlas could not save the catalog.".to_string())?;
    eprintln!("[atlas] library: catalog refreshed in {} ms", t.elapsed().as_millis());
    Ok(view(st, &env))
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
    let (base, repo, sha, subpath) = match &entry.source {
        catalog::Source::Github { repo, sha, path, .. } => {
            // Exactly what Claude Code installs: the pinned commit, else the named branch or tag, else HEAD.
            let want = install::fetch_target(&entry.source).unwrap_or("HEAD");
            let un = fetch(&app, &lib, env.fetch_dir(), repo, want, sha.as_deref()).await?;
            let base = install::resolve_base(&un.dir, path.as_deref())?;
            (Some(base), repo.clone(), un.sha.or_else(|| sha.clone()).unwrap_or_default(), path.clone())
        }
        catalog::Source::Local { path } => {
            let (dir, mp, p) = (env.root.dir.clone(), entry.marketplace.clone(), path.clone());
            let base = blocking(move || install::local_base(&dir, &mp, &p)).await?;
            (Some(base), String::new(), String::new(), Some(path.clone()))
        }
        // Another git host or a source Atlas can't read: nothing to look at, a deliberate two-click install.
        _ => (None, String::new(), String::new(), None),
    };
    let inspected = match base.clone() {
        Some(b2) => blocking(move || Ok(install::inspect_plugin(&b2, &name))).await?,
        None => install::inspect_unchecked(&name),
    };
    let detail = Detail {
        token: lib.keep(Staged { base, source: Some(entry.source.clone()), repo: repo.clone(), sha: sha.clone(), tree_hash: inspected.check.tree_hash.clone(), shaped: inspected.shaped.clone(), plugin_id: Some(plugin_id), market_source: None }),
        repo,
        sha,
        subpath,
        taken: Vec::new(),
        inspected,
        market_source: None,
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
        let token = lib.keep(Staged { base: Some(base), source: None, repo: repo.clone(), sha: sha.clone(), tree_hash: inspected.check.tree_hash.clone(), shaped: inspected.shaped.clone(), plugin_id: Some(id), market_source: None });
        Ok(Detail { token, repo, sha, subpath: None, taken: Vec::new(), inspected, market_source: None })
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
    let token = lib.keep(Staged { base: Some(base), source: None, repo: l.slug(), sha: sha.clone(), tree_hash: inspected.check.tree_hash.clone(), shaped: inspected.shaped.clone(), plugin_id: None, market_source: market_source.clone() });
    Ok(Detail { token, repo: l.slug(), sha, subpath: l.path.clone(), inspected, taken, market_source })
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
pub async fn library_install_plugin(state: Info<'_>, lib: Lib<'_>, plugin_id: String, token: String) -> Result<install::PluginOutcome, String> {
    let (st, lib) = (state.inner().clone(), lib.inner().clone());
    blocking(move || {
        let env = Env::of(&st)?;
        let (repo, sha, tree_hash, checked_source) = lib.with(&token, |s| {
            if s.plugin_id.as_deref() != Some(plugin_id.as_str()) {
                return Err("Check it again first.".to_string());
            }
            Ok((s.repo.clone(), s.sha.clone(), s.tree_hash.clone(), s.source.clone()))
        })?;
        // The listing may have been refreshed since the look (review finding 3): what Claude Code
        // would install now has to be what was checked, or nothing is installed.
        let source = entry_of(&env, &plugin_id).map(|e| e.source);
        let checked_source = checked_source.ok_or("Check it again first.")?;
        install::same_listing(&checked_source, source.as_ref())?;
        let source = source.ok_or("That plugin is not in the catalog. Press Refresh.")?;
        let runner = env.runner()?;
        install::install_plugin(&env.ctx(), &runner, &plugin_id, &source, &install::Checked { repo: &repo, sha: &sha, tree_hash: &tree_hash })
    })
    .await
}

#[tauri::command]
pub async fn library_uninstall_plugin(state: Info<'_>, id: String) -> Result<String, String> {
    let st = state.inner().clone();
    blocking(move || {
        let env = Env::of(&st)?;
        install::uninstall_plugin(&env.ctx(), &env.runner()?, &id)
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
        let done = install::undo_plugin_backup(&env.ctx(), &env.runner()?, &backup_id, now.as_ref())?;
        hub.refresh(&app, &st);
        Ok(done)
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
        let catalog = refresh_now(&st, None).or_else(|_| Ok::<_, String>(view(&st, &env)))?;
        Ok(Added { name: out.name, backup_id: out.backup_id, catalog })
    })
    .await
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
