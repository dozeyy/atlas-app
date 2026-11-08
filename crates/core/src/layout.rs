//! What inside a Claude config folder Atlas never copies, lists or opens.
//!
//! One home for the deny lists: Sandbox Mode (copying) and Setup (reading) both
//! use them, so a file that is too private to copy is also too private to show.

/// Top-level names that hold secrets or private history.
pub const SENSITIVE_TOP: &[&str] = &[".credentials.json", "sessions", "history.jsonl"];

/// Top-level names that are bulk Claude Code keeps for itself.
pub const BULK_TOP: &[&str] = &[
    "backups",
    "cache",
    "debug",
    "file-history",
    "session-env",
    "shell-snapshots",
    "jobs",
    "daemon",
    "ide",
    "bridge-spawn",
    "cloud",
    "state",
    "scheduled-tasks",
    "telemetry",
    "statsig",
    "todos",
    "paste-cache",
];

/// True for a single file or folder name that must never be listed or opened,
/// wherever it sits.
pub fn is_denied_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".credentials.json"
        || lower == ".env"
        || lower.starts_with(".env.")
        || lower.ends_with(".key")
        || lower.ends_with(".pem")
        || lower.ends_with(".lock")
        || lower == ".git"
        || lower == "node_modules"
        // The global state file holds the account and every project's history;
        // it is only ever read through the MCP view, never as a file.
        || lower == ".claude.json"
        || lower.starts_with(".claude.json.")
}

/// `rel` is a path relative to the config folder (or a project's `.claude`),
/// using `/` separators. True if Setup must never list or open it.
pub fn is_denied(rel: &str) -> bool {
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| is_denied_name(p)) {
        return true;
    }
    let Some(first) = parts.first() else { return false };
    let first = first.to_ascii_lowercase();
    if SENSITIVE_TOP.contains(&first.as_str()) || BULK_TOP.contains(&first.as_str()) {
        return true;
    }
    if first == "worktrees" {
        return true;
    }
    // `<anything>/.claude/worktrees/...`: agent checkouts of a whole project.
    if parts.windows(2).any(|w| w[0].eq_ignore_ascii_case(".claude") && w[1].eq_ignore_ascii_case("worktrees")) {
        return true;
    }
    // Synced-skill staging buckets.
    if first == "skills" && parts.get(1) == Some(&"synced") {
        if let Some(b) = parts.get(2) {
            if b.starts_with(".bucket-") {
                return true;
            }
        }
    }
    false
}

/// Backup copies the user or an editor left beside real files.
pub fn is_backup_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains(".bak-") || lower.ends_with(".bak") || lower.ends_with('~') || lower.contains(".bak.")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_and_bulk_are_denied() {
        for p in [
            ".credentials.json",
            "sessions/x.key",
            "history.jsonl",
            "backups/a.json",
            "agents/secret.pem",
            "a/.env",
            ".claude.json",
            ".claude.json.backup",
            "daemon.lock",
            "skills/synced/.bucket-x/a/SKILL.md",
            "worktrees/a/b",
            "x/node_modules/y",
        ] {
            assert!(is_denied(p), "{p} should be denied");
        }
        for p in ["agents/a.md", "skills/synced/bkt/a/SKILL.md", "settings.json", "reference/notes.md"] {
            assert!(!is_denied(p), "{p} should be allowed");
        }
    }

    #[test]
    fn backups_are_recognised() {
        assert!(is_backup_name("user-agent.md.bak-20261001"));
        assert!(is_backup_name("CLAUDE.md.bak"));
        assert!(is_backup_name("notes.md~"));
        assert!(!is_backup_name("backup-plan.md"));
    }
}
