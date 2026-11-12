//! The Library: find skills, agents and plugins, check them in plain words, install them
//! through the same safe write path as everything else (spec: `docs/specs/skill-library.md`).

use std::path::{Path, PathBuf};

pub mod archive;
pub mod catalog;
pub mod check;
pub mod cli;
pub mod install;
pub mod ledger;
pub mod link;
pub mod popularity;
pub mod shape;

/// Atlas's own working folder for the Library, inside the data dir.
pub fn library_dir(data: &Path) -> PathBuf {
    data.join("library")
}
