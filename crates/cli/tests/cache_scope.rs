//! Which index `atlas-usage` writes when no `--cache-dir` is given. The index keeps chats after
//! their files vanish, so a fixture read with `--config-dir` must never land in the user's own
//! index (`<local data>/cli`): it gets a folder of its own under `cli/roots/`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn fixture() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("claude-ledger")
}

/// `atlas-usage all --json` with the data folder pinned to `local` (so `<local>/cli` is "the real index").
fn run(local: &Path, config: Option<&Path>, env_config: Option<&Path>) -> Output {
    let mut c = Command::new(env!("CARGO_BIN_EXE_atlas-usage"));
    c.args(["all", "--json"]);
    if let Some(d) = config {
        c.arg("--config-dir").arg(d);
    }
    c.env("ATLAS_DATA_DIR", local).env_remove("ATLAS_USAGE_CACHE").env_remove("CLAUDE_PROJECT_DIR").env_remove("CLAUDE_CODE_SESSION_ID");
    match env_config {
        Some(d) => c.env("CLAUDE_CONFIG_DIR", d),
        None => c.env_remove("CLAUDE_CONFIG_DIR"),
    };
    c.output().unwrap()
}

/// Every file under `dir` with its bytes, keyed by relative path.
fn snapshot(dir: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(base: &Path, d: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for e in std::fs::read_dir(d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                out.insert(p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), std::fs::read(&p).unwrap());
            }
        }
    }
    let mut m = BTreeMap::new();
    walk(dir, dir, &mut m);
    m
}

fn ok(o: &Output) {
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
}

#[test]
fn a_config_dir_without_cache_dir_leaves_the_default_index_alone_and_uses_its_own_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path().join("local");
    let default_cache = local.join("cli");

    // The user's own index: made from a different (copied) root so the fixture is not in it.
    let own_root = tmp.path().join("own-claude");
    copy_dir(&fixture(), &own_root);
    ok(&run(&local, None, Some(&own_root)));
    assert!(default_cache.join("cache.sqlite").is_file(), "the default root writes the old folder");
    assert!(!default_cache.join("roots").exists(), "and no per-root folder");
    let before = snapshot(&default_cache);

    // The fixture, by --config-dir, with no --cache-dir (and no env root).
    let out = run(&local, Some(&fixture()), None);
    ok(&out);
    assert_eq!(snapshot(&default_cache).into_iter().filter(|(k, _)| !k.starts_with("roots/")).collect::<BTreeMap<_, _>>(), before, "the default index is byte for byte what it was");

    let roots: Vec<PathBuf> = std::fs::read_dir(default_cache.join("roots")).unwrap().flatten().map(|e| e.path()).collect();
    assert_eq!(roots.len(), 1, "one per-root folder: {roots:?}");
    assert!(roots[0].join("cache.sqlite").is_file(), "the fixture's index lives in its own folder");

    // A second run reuses the same per-root folder.
    ok(&run(&local, Some(&fixture()), None));
    assert_eq!(std::fs::read_dir(default_cache.join("roots")).unwrap().count(), 1);
}

#[test]
fn a_config_dir_that_is_the_users_own_root_keeps_the_default_folder() {
    let tmp = tempfile::tempdir().unwrap();
    let local = tmp.path().join("local");
    let root = tmp.path().join("own-claude");
    copy_dir(&fixture(), &root);
    ok(&run(&local, Some(&root), Some(&root)));
    assert!(local.join("cli").join("cache.sqlite").is_file());
    assert!(!local.join("cli").join("roots").exists());
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let (src, dst) = (e.path(), to.join(e.file_name()));
        if src.is_dir() {
            copy_dir(&src, &dst);
        } else {
            std::fs::copy(&src, &dst).unwrap();
        }
    }
}
