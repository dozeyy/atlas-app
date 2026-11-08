//! What Atlas may change for each item (the editor and the delete control are
//! shown from this). Pure: it only looks at the item and its source; the code
//! that actually writes lives outside `setup/` in `setup_write`.

use std::fs;
use std::path::Path;

use super::model::{ItemKind, ScopeKind, SetupItem};
use super::SourceRef;


/// What the page may offer for one item.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Capability {
    pub editable: bool,
    pub deletable: bool,
    /// Why Atlas will not change it (shown instead of the X). None when the item
    /// is simply not something Atlas removes.
    pub locked: Option<String>,
}

fn locked(why: impl Into<String>) -> Capability {
    Capability { editable: false, deletable: false, locked: Some(why.into()) }
}

pub fn capability(item: &SetupItem, src: Option<&SourceRef>) -> Capability {
    match item.scope {
        ScopeKind::Plugin => {
            let p = item.plugin.clone().unwrap_or_else(|| "a plugin".into());
            return locked(format!("This comes from the {p} plugin, so it can only be changed by updating or removing the plugin."));
        }
        ScopeKind::Synced | ScopeKind::Connector => return locked("This is synced from your claude.ai account, so it can only be changed there."),
        ScopeKind::Managed => return locked("This is set by your organisation, so Atlas cannot change it."),
        _ => {}
    }
    if item.real_project_file {
        return locked("Sandbox Mode is on and this is a real project file. Turn Sandbox Mode off to change it.");
    }
    if item.backup {
        return Capability::default();
    }
    let Some(src) = src else { return Capability::default() };
    if item.link_target.is_some() {
        return locked("This is a link to a file somewhere else, so Atlas leaves it alone.");
    }
    match (item.kind, src) {
        (ItemKind::Skill, SourceRef::File { path }) => {
            let ok = path.file_name().is_some_and(|n| n == "SKILL.md") && path.parent().and_then(Path::parent).and_then(Path::file_name).is_some_and(|n| n == "skills");
            let linked = path.parent().and_then(|p| fs::symlink_metadata(p).ok()).is_some_and(|m| m.file_type().is_symlink());
            if linked {
                return locked("This skill folder is a link to somewhere else, so Atlas leaves it alone.");
            }
            Capability { editable: true, deletable: ok, locked: None }
        }
        (ItemKind::Agent | ItemKind::Command | ItemKind::Rule | ItemKind::OutputStyle | ItemKind::Workflow, SourceRef::File { .. }) => {
            Capability { editable: true, deletable: true, locked: None }
        }
        (
            ItemKind::Instructions | ItemKind::AutoMemory | ItemKind::AgentMemory | ItemKind::Settings | ItemKind::Keybindings | ItemKind::Theme | ItemKind::Other,
            SourceRef::File { .. },
        ) => Capability { editable: true, deletable: false, locked: None },
        (ItemKind::Hook, SourceRef::JsonEntry { .. }) | (ItemKind::McpServer, SourceRef::JsonEntry { .. }) => Capability { editable: true, deletable: true, locked: None },
        (ItemKind::Hook, SourceRef::File { .. }) => locked("This hook is written inside a skill or agent file. Edit that file instead."),
        _ => Capability::default(),
    }
}

