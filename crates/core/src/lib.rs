//! Atlas core: everything that is testable without a UI.
//!
//! Phase 1 holds the foundations every later phase stands on: where the Claude
//! config lives (`paths`), how the app is launched (`launch`), Sandbox Mode
//! (`sandbox`), Atlas's own settings (`settings`) and the atomic write helper
//! with its dev/test guard against touching the real config (`fsutil`).
//! Phase 3 adds `layout` (what is never read) and `setup` (read-only discovery
//! of every Claude Code setup item).

pub mod cache;
pub mod connect;
pub mod fsutil;
pub mod habits;
pub mod history;
pub mod launch;
pub mod library;
pub mod layout;
pub mod now;
pub mod ops;
pub mod paths;
pub mod pending;
pub mod proc;
pub mod quit_signal;
pub mod readout;
pub mod review_rule;
pub mod redact;
pub mod sandbox;
pub mod search;
pub mod settings;
pub mod textgroup;
pub mod usage;
pub mod writelock;
pub mod setup;
pub mod setup_write;
