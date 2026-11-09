//! Finds the real Atlas installer that this program carries inside (feature `payload`)
//! and hands its path to `include_bytes!` through an env var.
//!
//! The installer is the NSIS file `npx tauri build` makes for crates/app. A missing file
//! is a compile error with the fix in the message, never a setup program that installs
//! nothing.

use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=ATLAS_SETUP_PAYLOAD");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=tauri.conf.json");

    if std::env::var_os("CARGO_FEATURE_PAYLOAD").is_some() {
        let path = find_payload();
        println!("cargo:rerun-if-changed={}", path.display());
        println!("cargo:rustc-env=ATLAS_PAYLOAD_PATH={}", path.display());
    } else {
        println!("cargo:rustc-env=ATLAS_PAYLOAD_PATH=");
    }

    tauri_build::build();
}

fn find_payload() -> PathBuf {
    if let Some(p) = std::env::var_os("ATLAS_SETUP_PAYLOAD").filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        assert!(p.is_file(), "ATLAS_SETUP_PAYLOAD points at {} which is not a file.", p.display());
        return p;
    }
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let workspace = manifest.parent().and_then(Path::parent).expect("workspace root");
    let target = std::env::var_os("CARGO_TARGET_DIR").map(PathBuf::from).unwrap_or_else(|| workspace.join("target"));
    let dir = target.join("release").join("bundle").join("nsis");
    let newest = std::fs::read_dir(&dir).ok().and_then(|rd| {
        rd.filter_map(Result::ok)
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")))
            .max_by_key(|p| std::fs::metadata(p).and_then(|m| m.modified()).ok())
    });
    newest.unwrap_or_else(|| {
        panic!(
            "\n\nAtlas Setup carries the Atlas installer, and none was found in {}.\n\
             Build it first (`npx tauri build` from the repository root), or set ATLAS_SETUP_PAYLOAD \
             to the installer file. `tools/build-setup.ps1` does the whole chain.\n",
            dir.display()
        )
    })
}
