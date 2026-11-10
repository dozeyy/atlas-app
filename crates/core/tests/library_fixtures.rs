//! The Library against the files in `fixtures/library/` (criteria 6, 10 to 12, 20).

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use atlas_core::library::{archive, catalog, check, install, shape};

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("..").join("fixtures").join("library")
}

fn stage(name: &str, into: &Path) -> archive::Unpacked {
    let f = File::open(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"));
    archive::unpack(f, into, name.trim_end_matches(".tar.gz")).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn catalog_text() -> String {
    let f = File::open(dir().join("catalog-available.json.gz")).unwrap();
    let mut s = String::new();
    flate2::read::GzDecoder::new(f).read_to_string(&mut s).unwrap();
    s
}

#[test]
fn the_captured_catalog_parses_to_3603_entries_with_every_field() {
    let entries = catalog::parse_available(&catalog_text()).unwrap();
    // 3,602 come from the built-in directory; the 3,603rd is the local-source entry of an added marketplace.
    assert_eq!(entries.len(), 3603);
    assert!(entries.iter().all(|e| !e.plugin_id.is_empty() && !e.name.is_empty() && !e.marketplace.is_empty()));
    let dir_entries = entries.iter().filter(|e| e.marketplace == catalog::DIRECTORY).count();
    assert_eq!(dir_entries, 3602);
    let github = entries.iter().filter(|e| matches!(&e.source, catalog::Source::Github { sha: Some(s), .. } if s.len() == 40)).count();
    assert_eq!(github, 3602, "every directory entry is a GitHub source with a pinned sha");
    let local: Vec<_> = entries.iter().filter(|e| matches!(e.source, catalog::Source::Local { .. })).collect();
    assert_eq!(local.len(), 1);
    assert_eq!(local[0].plugin_id, "impeccable@impeccable");
    assert!(entries.iter().filter(|e| !e.version.is_empty()).count() > 1000);
}

#[test]
fn the_cache_round_trips_the_whole_catalog() {
    let entries = catalog::parse_available(&catalog_text()).unwrap();
    let data = tempfile::tempdir().unwrap();
    catalog::write_cache(data.path(), entries.clone(), 1234).unwrap();
    let back = catalog::read_cache(data.path()).unwrap();
    assert_eq!((back.fetched_ms, back.entries.len()), (1234, 3603));
    assert_eq!(back.entries, entries);
}

#[test]
fn mcp_search_finds_frontend_design_first_and_says_what_to_do_without_a_catalog() {
    let data = tempfile::tempdir().unwrap();
    assert_eq!(catalog::search_library(data.path(), &[], "frontend", 10).unwrap_err(), catalog::NO_CATALOG);
    catalog::write_cache(data.path(), catalog::parse_available(&catalog_text()).unwrap(), 1).unwrap();
    let installed = vec!["frontend-design@anthropic-plugin-directory".to_string()];
    let hits = catalog::search_library(data.path(), &installed, "frontend", 10).unwrap();
    assert_eq!(hits[0].name, "frontend-design");
    assert!(hits[0].installed);
    assert!(hits.len() <= 10);
    assert!(catalog::search_library(data.path(), &[], "frontend", 99).unwrap().len() <= 20, "the limit is capped at 20");
}

#[test]
fn every_fixture_resolves_to_the_shape_d17_says() {
    let t = tempfile::tempdir().unwrap();
    let want = [
        ("fixture-marketplace-demo.tar.gz", "marketplace"),
        ("fixture-hookify-like.tar.gz", "plugin"),
        ("fixture-plugin-json-only.tar.gz", "plugin"),
        ("fixture-loose-skills.tar.gz", "loose"),
        ("fixture-http-mcp.tar.gz", "loose"),
        ("fixture-bare-skills.tar.gz", "loose"),
        ("fixture-nothing.tar.gz", "nothing"),
    ];
    for (name, shape_name) in want {
        let u = stage(name, t.path());
        assert!(u.sha.as_deref().is_some_and(|s| s.len() == 40), "{name}: the commit comes from the archive header");
        let s = shape::detect(&u.dir, "repo");
        assert_eq!(s.shape, shape_name, "{name}");
    }
    let u = stage("fixture-marketplace-demo.tar.gz", t.path());
    let s = shape::detect(&u.dir, "repo");
    assert_eq!(s.plugins.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), ["alpha-tools", "beta-tools"]);
    let u = stage("fixture-loose-skills.tar.gz", t.path());
    let items: Vec<_> = shape::detect(&u.dir, "repo").items.iter().map(|i| format!("{}:{}", i.kind, i.name)).collect();
    assert_eq!(items, ["skill:alpha", "skill:beta", "agent:reviewer"]);
    assert_eq!(shape::detect(&stage("fixture-nothing.tar.gz", t.path()).dir, "repo").items.len(), 0);
}

fn codes(c: &check::Check) -> Vec<&str> {
    c.flags.iter().map(|f| f.code.as_str()).collect()
}

#[test]
fn the_hookify_like_fixture_is_flagged_with_evidence() {
    let t = tempfile::tempdir().unwrap();
    let u = stage("fixture-hookify-like.tar.gz", t.path());
    let c = install::inspect_plugin(&u.dir, "hookify-like").check;
    for want in ["commands", "every_action", "every_message", "scripts"] {
        let f = c.flags.iter().find(|f| f.code == want).unwrap_or_else(|| panic!("no {want} in {:?}", codes(&c)));
        assert!(f.evidence.iter().all(|e| !e.path.is_empty()));
        assert!(f.evidence.iter().any(|e| e.line.is_some()), "{want}");
    }
    let cmd = &c.flags.iter().find(|f| f.code == "commands").unwrap().evidence[0];
    assert_eq!(cmd.path, "hooks/hooks.json");
    assert!(cmd.excerpt.contains("python3"));
    assert!(c.flags.iter().find(|f| f.code == "scripts").unwrap().evidence.iter().any(|e| e.path == "hooks/pretooluse.py" && e.line == Some(1)));
}

#[test]
fn the_http_mcp_fixture_uses_the_internet_through_a_server() {
    let t = tempfile::tempdir().unwrap();
    let u = stage("fixture-http-mcp.tar.gz", t.path());
    let c = install::inspect_link(&u.dir, "http-mcp").check;
    assert_eq!(codes(&c), ["internet", "server"]);
}

#[test]
fn text_only_fixtures_say_so_and_the_loose_one_flags_its_scripts() {
    let t = tempfile::tempdir().unwrap();
    let c = install::inspect_link(&stage("fixture-bare-skills.tar.gz", t.path()).dir, "bare").check;
    assert!(c.flags.is_empty(), "{:?}", codes(&c));
    assert_eq!(c.summary, check::TEXT_ONLY);
    let c = install::inspect_link(&stage("fixture-loose-skills.tar.gz", t.path()).dir, "loose").check;
    assert!(codes(&c).contains(&"scripts"));
    assert!(!codes(&c).contains(&"commands"));
}

#[test]
fn the_plugin_json_only_fixture_lists_its_hooks_as_not_installed() {
    let t = tempfile::tempdir().unwrap();
    let u = stage("fixture-plugin-json-only.tar.gz", t.path());
    let ins = install::inspect_link(&u.dir, "plugin-json-only");
    assert_eq!(ins.shaped.shape, "plugin");
    assert_eq!(ins.shaped.items.iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["pdf", "xlsx"]);
    let ni = ins.check.flags.iter().find(|f| f.code == "not_installed").expect("not_installed");
    assert!(ni.words.starts_with("Not installed: its hooks and LSP servers."));
    // The same plugin from the catalog would install its hooks: nothing is left out.
    assert!(!install::inspect_plugin(&u.dir, "plugin-json-only").check.flags.iter().any(|f| f.code == "not_installed"));
}

#[test]
fn staging_is_content_addressed_and_pruned() {
    let t = tempfile::tempdir().unwrap();
    let a = stage("fixture-bare-skills.tar.gz", t.path());
    assert!(a.dir.join("skills").join("plain").join("SKILL.md").is_file());
    let name = a.dir.file_name().unwrap().to_string_lossy().into_owned();
    assert!(name.starts_with("fixture-bare-skills-"), "{name}");
    assert!(name.ends_with(&a.sha.clone().unwrap()[..12]));
    // Nothing is left half-written beside it.
    let others: Vec<_> = fs::read_dir(t.path()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(others, [name]);
}
