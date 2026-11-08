//! Atlas core: everything that is testable without a UI.
//!
//! Phase 1 holds the foundations every later phase stands on: where the Claude
//! config lives (`paths`), how the app is launched (`launch`), Sandbox Mode
//! (`sandbox`), Atlas's own settings (`settings`) and the atomic write helper
//! with its dev/test guard against touching the real config (`fsutil`).
//! Phase 3 adds `layout` (what is never read) and `setup` (read-only discovery
//! of every Claude Code setup item).

pub mod cache;
pub mod fsutil;
pub mod launch;
pub mod layout;
pub mod paths;
pub mod redact;
pub mod sandbox;
pub mod settings;
pub mod usage;
pub mod setup;
