//! Which definition wins when the same name exists at several scopes.
//!
//! Precedence comes from the Claude Code docs (see `PRECEDENCE_SOURCES`):
//! this module only applies the table.

use std::collections::{BTreeMap, BTreeSet};

use super::model::*;

/// Where the order was checked. Update both when a docs page changes.
pub const PRECEDENCE_SOURCES: &str = "code.claude.com/docs/en: skills, sub-agents, mcp pages read 2026-11-08; commands and output styles have no documented winner (spec default), not re-read";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Group {
    Skill,
    Agent,
    Command,
    OutputStyle,
    Mcp,
}

pub fn group_of(kind: ItemKind) -> Option<Group> {
    match kind {
        ItemKind::Skill => Some(Group::Skill),
        ItemKind::Agent => Some(Group::Agent),
        ItemKind::Command => Some(Group::Command),
        ItemKind::OutputStyle => Some(Group::OutputStyle),
        ItemKind::McpServer => Some(Group::Mcp),
        _ => None,
    }
}

/// Higher wins. `None`: the scope takes no part. Equal ranks at different
/// scopes are a "Conflict" (the docs name no winner).
pub fn rank(group: Group, scope: ScopeKind) -> Option<u8> {
    use ScopeKind::*;
    match group {
        // managed > user > project; plugin skills are namespaced and never clash.
        Group::Skill => match scope {
            Managed => Some(3),
            User => Some(2),
            Project => Some(1),
            _ => None,
        },
        // managed > project > user > plugin
        Group::Agent => match scope {
            Managed => Some(4),
            Project => Some(3),
            User => Some(2),
            Plugin => Some(1),
            _ => None,
        },
        // user and project commands: no documented winner
        Group::Command => match scope {
            User | Project => Some(1),
            _ => None,
        },
        Group::OutputStyle => match scope {
            User | Project => Some(1),
            _ => None,
        },
        // managed > local > project > user > plugin
        Group::Mcp => match scope {
            Managed => Some(5),
            Local => Some(4),
            Project => Some(3),
            User => Some(2),
            Plugin => Some(1),
            _ => None,
        },
    }
}

#[derive(Clone, Copy)]
enum Rel {
    /// `self` beats `other`
    Beats(usize),
    /// `other` beats `self`
    LosesTo(usize),
    Tie(usize),
}

fn identity(it: &SetupItem) -> (ScopeKind, Option<String>, Option<String>) {
    (it.scope, it.project_id.clone(), it.plugin.clone())
}

fn is_global(s: ScopeKind) -> bool {
    !matches!(s, ScopeKind::Project | ScopeKind::Local)
}

pub fn apply(items: &mut [SetupItem]) {
    let mut rels: Vec<Vec<Rel>> = vec![Vec::new(); items.len()];
    let mut dup: BTreeSet<usize> = BTreeSet::new();

    // Bucket by (group, key).
    let mut buckets: BTreeMap<(Group, String), Vec<usize>> = BTreeMap::new();
    for (i, it) in items.iter().enumerate() {
        let (Some(g), Some(k)) = (group_of(it.kind), it.shadow_key.as_ref()) else { continue };
        if it.worktree || it.backup {
            continue;
        }
        buckets.entry((g, k.to_lowercase())).or_default().push(i);
    }

    for ((group, _), idxs) in &buckets {
        // Duplicates inside one scope.
        let mut by_identity: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for &i in idxs {
            by_identity.entry(format!("{:?}", identity(&items[i]))).or_default().push(i);
        }
        for v in by_identity.values() {
            if v.len() > 1 {
                dup.extend(v.iter().copied());
            }
        }
        let live: Vec<usize> = idxs.iter().copied().filter(|i| !dup.contains(i)).collect();
        let ranked: Vec<(usize, u8)> = live.iter().filter_map(|&i| rank(*group, items[i].scope).map(|r| (i, r))).collect();
        let projects: BTreeSet<Option<String>> =
            ranked.iter().filter(|(i, _)| !is_global(items[*i].scope)).map(|(i, _)| items[*i].project_id.clone()).collect();
        let contexts: Vec<Option<String>> = if projects.is_empty() { vec![None] } else { projects.into_iter().collect() };
        for ctx in contexts {
            let members: Vec<(usize, u8)> = ranked
                .iter()
                .copied()
                .filter(|(i, _)| is_global(items[*i].scope) || items[*i].project_id == ctx)
                .collect();
            let scopes: BTreeSet<String> = members.iter().map(|(i, _)| format!("{:?}", items[*i].scope)).collect();
            if members.len() < 2 || scopes.len() < 2 {
                continue;
            }
            let top = members.iter().map(|m| m.1).max().unwrap_or(0);
            let tops: Vec<usize> = members.iter().filter(|m| m.1 == top).map(|m| m.0).collect();
            let top_scopes: BTreeSet<String> = tops.iter().map(|i| format!("{:?}", items[*i].scope)).collect();
            if top_scopes.len() > 1 {
                for a in &tops {
                    for b in &tops {
                        if a != b && items[*a].scope != items[*b].scope {
                            rels[*a].push(Rel::Tie(*b));
                        }
                    }
                }
                continue;
            }
            let w = tops[0];
            for (i, r) in &members {
                if *i == w || *r == top {
                    continue;
                }
                rels[w].push(Rel::Beats(*i));
                rels[*i].push(Rel::LosesTo(w));
            }
        }
    }

    // A skill beats a command of the same name.
    let skills: BTreeMap<String, Vec<usize>> = {
        let mut m: BTreeMap<String, Vec<usize>> = BTreeMap::new();
        for (i, it) in items.iter().enumerate() {
            if it.kind == ItemKind::Skill && !it.worktree && !it.backup && matches!(it.scope, ScopeKind::User | ScopeKind::Project | ScopeKind::Managed) {
                if let Some(k) = &it.shadow_key {
                    m.entry(k.to_lowercase()).or_default().push(i);
                }
            }
        }
        m
    };
    for ci in 0..items.len() {
        if items[ci].kind != ItemKind::Command || items[ci].worktree || items[ci].backup {
            continue;
        }
        let Some(k) = items[ci].shadow_key.clone() else { continue };
        if let Some(sk) = skills.get(&k.to_lowercase()) {
            for &si in sk {
                let same_ctx = is_global(items[si].scope) || is_global(items[ci].scope) || items[si].project_id == items[ci].project_id;
                if same_ctx {
                    rels[si].push(Rel::Beats(ci));
                    rels[ci].push(Rel::LosesTo(si));
                }
            }
        }
    }

    // Write the results.
    let snapshot: Vec<(String, String, bool)> = items.iter().map(|i| (i.id.clone(), i.scope_label.clone(), false)).collect();
    for i in 0..items.len() {
        if dup.contains(&i) {
            let mut defined: Vec<DefinedIn> = Vec::new();
            for (j, _) in items.iter().enumerate() {
                if j != i && dup.contains(&j) && items[j].kind == items[i].kind && items[j].shadow_key.as_deref().map(str::to_lowercase) == items[i].shadow_key.as_deref().map(str::to_lowercase) && identity(&items[j]) == identity(&items[i]) {
                    defined.push(DefinedIn { id: snapshot[j].0.clone(), scope_label: snapshot[j].1.clone(), winner: false, is_self: false });
                }
            }
            defined.insert(0, DefinedIn { id: snapshot[i].0.clone(), scope_label: snapshot[i].1.clone(), winner: false, is_self: true });
            items[i].conflict = Some(Conflict { status: ConflictStatus::Duplicate, label: "Duplicate".into(), defined_in: defined });
            continue;
        }
        let r = &rels[i];
        if r.is_empty() {
            continue;
        }
        let losers_to: Vec<usize> = r.iter().filter_map(|x| if let Rel::LosesTo(w) = x { Some(*w) } else { None }).collect();
        let beats: Vec<usize> = r.iter().filter_map(|x| if let Rel::Beats(l) = x { Some(*l) } else { None }).collect();
        let ties: Vec<usize> = r.iter().filter_map(|x| if let Rel::Tie(t) = x { Some(*t) } else { None }).collect();
        let me = DefinedIn { id: snapshot[i].0.clone(), scope_label: snapshot[i].1.clone(), winner: false, is_self: true };
        let conflict = if !losers_to.is_empty() {
            let mut w = losers_to.clone();
            w.sort_unstable();
            w.dedup();
            let mut defined: Vec<DefinedIn> = w.iter().map(|&j| DefinedIn { id: snapshot[j].0.clone(), scope_label: snapshot[j].1.clone(), winner: true, is_self: false }).collect();
            defined.push(me);
            let label = format!("Overridden by {}", snapshot[w[0]].1);
            Conflict { status: ConflictStatus::Overridden, label, defined_in: defined }
        } else if !beats.is_empty() {
            let mut l = beats.clone();
            l.sort_unstable();
            l.dedup();
            let mut labels: Vec<String> = Vec::new();
            for &j in &l {
                let s = short_scope(&snapshot[j].1);
                if !labels.contains(&s) {
                    labels.push(s);
                }
            }
            let label = if labels.len() > 2 {
                format!("Overrides {} and {} more", labels[0], labels.len() - 1)
            } else {
                format!("Overrides {}", labels.join(", "))
            };
            let mut defined = vec![DefinedIn { id: me.id.clone(), scope_label: me.scope_label.clone(), winner: true, is_self: true }];
            defined.extend(l.iter().map(|&j| DefinedIn { id: snapshot[j].0.clone(), scope_label: snapshot[j].1.clone(), winner: false, is_self: false }));
            Conflict { status: ConflictStatus::Overrides, label, defined_in: defined }
        } else {
            let mut t = ties.clone();
            t.sort_unstable();
            t.dedup();
            let mut defined = vec![me];
            defined.extend(t.iter().map(|&j| DefinedIn { id: snapshot[j].0.clone(), scope_label: snapshot[j].1.clone(), winner: false, is_self: false }));
            Conflict { status: ConflictStatus::Conflict, label: "Conflict".into(), defined_in: defined }
        };
        if conflict.status == ConflictStatus::Overridden && matches!(items[i].enabled.state, EnabledKind::On | EnabledKind::None | EnabledKind::Custom) {
            items[i].enabled = Enabled::of(EnabledKind::Shadowed, "Shadowed");
        }
        items[i].conflict = Some(conflict);
    }
}

/// "Project · app" stays; the Global label is the short form of "Global".
fn short_scope(label: &str) -> String {
    label.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn it(kind: ItemKind, scope: ScopeKind, project: Option<&str>, key: &str, id: &str) -> SetupItem {
        let mut i = SetupItem::new(kind, scope, key);
        i.id = id.into();
        i.project_id = project.map(str::to_string);
        i.scope_label = match scope {
            ScopeKind::User => "Global".into(),
            ScopeKind::Project => format!("Project · {}", project.unwrap_or("?")),
            ScopeKind::Local => format!("Local · {}", project.unwrap_or("?")),
            _ => "Other".into(),
        };
        i.shadow_key = Some(key.into());
        i.enabled = Enabled::on();
        i
    }

    /// The documented order, as data: first name beats the later ones.
    #[test]
    fn order_table_matches_the_docs() {
        use ScopeKind::*;
        let order = |g: Group, high_to_low: &[ScopeKind]| {
            for w in high_to_low.windows(2) {
                assert!(rank(g, w[0]).unwrap() > rank(g, w[1]).unwrap(), "{g:?}: {:?} should beat {:?}", w[0], w[1]);
            }
        };
        order(Group::Skill, &[Managed, User, Project]);
        order(Group::Agent, &[Managed, Project, User, Plugin]);
        order(Group::Mcp, &[Managed, Local, Project, User, Plugin]);
        assert_eq!(rank(Group::Command, User), rank(Group::Command, Project));
        assert_eq!(rank(Group::OutputStyle, User), rank(Group::OutputStyle, Project));
        assert_eq!(rank(Group::Skill, Plugin), None);
        assert!(PRECEDENCE_SOURCES.contains("2026-11-08"));
    }

    #[test]
    fn skill_user_beats_project() {
        let mut v = vec![
            it(ItemKind::Skill, ScopeKind::User, None, "s", "u"),
            it(ItemKind::Skill, ScopeKind::Project, Some("app"), "s", "p"),
        ];
        apply(&mut v);
        assert_eq!(v[0].conflict.as_ref().unwrap().status, ConflictStatus::Overrides);
        assert_eq!(v[1].conflict.as_ref().unwrap().status, ConflictStatus::Overridden);
        assert_eq!(v[1].enabled.state, EnabledKind::Shadowed);
        assert!(v[1].conflict.as_ref().unwrap().defined_in[0].winner);
    }

    #[test]
    fn agent_project_beats_user_and_two_projects_do_not_clash() {
        let mut v = vec![
            it(ItemKind::Agent, ScopeKind::User, None, "a", "u"),
            it(ItemKind::Agent, ScopeKind::Project, Some("one"), "a", "p1"),
            it(ItemKind::Agent, ScopeKind::Project, Some("two"), "a", "p2"),
        ];
        apply(&mut v);
        assert_eq!(v[1].conflict.as_ref().unwrap().status, ConflictStatus::Overrides);
        assert_eq!(v[0].conflict.as_ref().unwrap().status, ConflictStatus::Overridden);
        let only_projects = [it(ItemKind::Agent, ScopeKind::Project, Some("one"), "a", "p1"), it(ItemKind::Agent, ScopeKind::Project, Some("two"), "a", "p2")];
        let mut w = only_projects.to_vec();
        apply(&mut w);
        assert!(w[0].conflict.is_none() && w[1].conflict.is_none());
    }

    #[test]
    fn commands_conflict_without_a_winner() {
        let mut v = vec![
            it(ItemKind::Command, ScopeKind::User, None, "c", "u"),
            it(ItemKind::Command, ScopeKind::Project, Some("app"), "c", "p"),
        ];
        apply(&mut v);
        assert_eq!(v[0].conflict.as_ref().unwrap().status, ConflictStatus::Conflict);
        assert_eq!(v[1].conflict.as_ref().unwrap().status, ConflictStatus::Conflict);
        assert!(v[0].conflict.as_ref().unwrap().defined_in.iter().all(|d| !d.winner));
    }

    #[test]
    fn mcp_local_project_user_chain() {
        let mut v = vec![
            it(ItemKind::McpServer, ScopeKind::User, None, "shared", "u"),
            it(ItemKind::McpServer, ScopeKind::Project, Some("app"), "shared", "p"),
            it(ItemKind::McpServer, ScopeKind::Local, Some("app"), "shared", "l"),
        ];
        apply(&mut v);
        assert_eq!(v[2].conflict.as_ref().unwrap().status, ConflictStatus::Overrides);
        assert_eq!(v[0].conflict.as_ref().unwrap().status, ConflictStatus::Overridden);
        assert_eq!(v[1].conflict.as_ref().unwrap().status, ConflictStatus::Overridden);
    }

    #[test]
    fn same_name_twice_in_one_scope_is_a_duplicate() {
        let mut v = vec![
            it(ItemKind::Agent, ScopeKind::User, None, "dup", "a"),
            it(ItemKind::Agent, ScopeKind::User, None, "dup", "b"),
        ];
        apply(&mut v);
        assert_eq!(v[0].conflict.as_ref().unwrap().status, ConflictStatus::Duplicate);
        assert_eq!(v[1].conflict.as_ref().unwrap().status, ConflictStatus::Duplicate);
    }

    #[test]
    fn a_skill_beats_a_command_with_its_name() {
        let mut v = vec![
            it(ItemKind::Skill, ScopeKind::User, None, "x", "s"),
            it(ItemKind::Command, ScopeKind::User, None, "x", "c"),
        ];
        apply(&mut v);
        assert_eq!(v[0].conflict.as_ref().unwrap().status, ConflictStatus::Overrides);
        assert_eq!(v[1].conflict.as_ref().unwrap().status, ConflictStatus::Overridden);
    }
}
