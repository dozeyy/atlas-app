//! "Tell me when it is done": spots, from the snapshots Now already produces, the moment a
//! chat Atlas watched working turns to waiting for the user.
//!
//! What counts (and how sure it is):
//! - `done`: the chat's own transcript ended its turn (the assistant said its last word with
//!   nothing left to run). Reliable: Claude Code writes that line itself.
//! - `ask`: the chat asked a question (AskUserQuestion is open) and is waiting for an answer.
//!   Reliable for that tool. A permission prompt for a command is NOT written to the
//!   transcript, so a chat held up by one looks like it is still working and is never reported.
//! - A chat that just goes quiet (killed, closed, or the user walked away mid-turn) is not
//!   reported: silence alone cannot be told from a long thinking pause.
//!
//! Only chats seen working are reported, so opening Atlas never announces old news, and a
//! chat is reported once per turn.

use std::collections::HashMap;

use serde::Serialize;

use super::model::NowSnapshot;

/// What happened, for a notification and the page's own toast.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finished {
    pub session_id: String,
    /// The chat's title, or its project folder when it has none.
    pub name: String,
    pub project: String,
    /// `done` or `ask`.
    pub kind: String,
    /// How long the stretch of work took, when known.
    pub worked_ms: Option<i64>,
}

#[derive(Default)]
pub struct NotifyTracker {
    /// session id -> was it working at the last snapshot
    working: HashMap<String, bool>,
    primed: bool,
}

impl NotifyTracker {
    pub fn new() -> NotifyTracker {
        NotifyTracker::default()
    }

    /// Feed each new snapshot; get back the chats that just stopped working.
    pub fn observe(&mut self, snap: &NowSnapshot) -> Vec<Finished> {
        let mut out = Vec::new();
        let mut next: HashMap<String, bool> = HashMap::new();
        for c in &snap.chats {
            let working = c.state == "working";
            if self.primed && !working && self.working.get(&c.session_id).copied().unwrap_or(false) {
                out.push(Finished {
                    session_id: c.session_id.clone(),
                    name: c.title.clone().unwrap_or_else(|| c.project.clone()),
                    project: c.project.clone(),
                    kind: if c.doing.kind == "ask" { "ask" } else { "done" }.to_string(),
                    worked_ms: c.worked_ms,
                });
            }
            next.insert(c.session_id.clone(), working);
        }
        self.working = next;
        self.primed = true;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::{Doing, NowChat};
    use super::*;

    fn chat(id: &str, state: &str, kind: &str) -> NowChat {
        NowChat {
            session_id: id.into(),
            title: Some(format!("Chat {id}")),
            project: "atlas".into(),
            model: None,
            state: state.into(),
            started_ms: None,
            worked_ms: Some(90_000),
            last_write_ms: 0,
            doing: Doing { kind: kind.into(), verb: "x".into(), target: None },
            tokens: 0,
            cost_usd: None,
            unpriced: false,
            helpers: vec![],
            files: vec![],
            steps: vec![],
        }
    }

    fn snap(chats: Vec<NowChat>) -> NowSnapshot {
        NowSnapshot { chats, watching: true, ..Default::default() }
    }

    #[test]
    fn the_first_look_reports_nothing_even_for_chats_already_waiting() {
        let mut t = NotifyTracker::new();
        assert!(t.observe(&snap(vec![chat("a", "waiting", "wait")])).is_empty());
        assert!(t.observe(&snap(vec![chat("a", "waiting", "wait")])).is_empty());
    }

    #[test]
    fn working_to_waiting_is_reported_once() {
        let mut t = NotifyTracker::new();
        t.observe(&snap(vec![chat("a", "working", "edit")]));
        let got = t.observe(&snap(vec![chat("a", "waiting", "wait")]));
        assert_eq!(got.len(), 1);
        assert_eq!((got[0].kind.as_str(), got[0].name.as_str(), got[0].worked_ms), ("done", "Chat a", Some(90_000)));
        assert!(t.observe(&snap(vec![chat("a", "waiting", "wait")])).is_empty(), "not again while it keeps waiting");
    }

    #[test]
    fn a_question_is_told_apart_from_a_finish() {
        let mut t = NotifyTracker::new();
        t.observe(&snap(vec![chat("a", "working", "run")]));
        let got = t.observe(&snap(vec![chat("a", "waiting", "ask")]));
        assert_eq!(got[0].kind, "ask");
    }

    #[test]
    fn a_second_turn_is_a_second_report() {
        let mut t = NotifyTracker::new();
        t.observe(&snap(vec![chat("a", "working", "run")]));
        assert_eq!(t.observe(&snap(vec![chat("a", "waiting", "wait")])).len(), 1);
        t.observe(&snap(vec![chat("a", "working", "run")]));
        assert_eq!(t.observe(&snap(vec![chat("a", "waiting", "wait")])).len(), 1);
    }

    #[test]
    fn a_chat_that_goes_quiet_or_appears_already_waiting_is_not_reported() {
        let mut t = NotifyTracker::new();
        t.observe(&snap(vec![chat("a", "working", "run")]));
        assert!(t.observe(&snap(vec![])).is_empty(), "vanished while working: unknown, stay quiet");
        assert!(t.observe(&snap(vec![chat("b", "waiting", "wait")])).is_empty(), "never seen working");
    }

    #[test]
    fn chats_are_tracked_one_by_one() {
        let mut t = NotifyTracker::new();
        t.observe(&snap(vec![chat("a", "working", "run"), chat("b", "working", "run")]));
        let got = t.observe(&snap(vec![chat("a", "working", "run"), chat("b", "waiting", "wait")]));
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].session_id, "b");
    }
}
