//! One chat session's turns on this box (ISS-977).
//!
//! Core starts one turn of a session at a time and refuses a second beside it
//! (`chat-turn.ts:writeTurn`, `SESSION_RUNNING`): core owns that rule, because
//! it alone sees every hand-over and writes the seed row each turn is numbered
//! from. This is the box's half, for a core that still sends two: the second
//! turn of a session waits for the first to end instead of running beside it,
//! and numbers its lines past the last seq any earlier turn of the session on
//! this box used, never from a base the first turn's lines have since taken.
//!
//! Nothing here outlives the daemon: after a restart a session's first turn
//! numbers from the base core sent, which is core's next seq.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Every chat session this box ran a turn for since it started.
#[derive(Default, Clone)]
pub struct ChatTurns {
    sessions: Arc<Mutex<HashMap<String, Arc<SessionTurns>>>>,
}

#[derive(Default)]
struct SessionTurns {
    /// Held by the one turn running.
    gate: Arc<tokio::sync::Mutex<()>>,
    /// The highest seq a turn of the session numbered a line with on this box.
    last_seq: AtomicU64,
}

/// The session's one running turn, held until the turn has delivered its lines
/// and written its end.
pub struct TurnHold {
    _running: tokio::sync::OwnedMutexGuard<()>,
    session: Arc<SessionTurns>,
}

impl ChatTurns {
    /// Wait until no other turn of `session_id` runs on this box, then hold it.
    pub async fn hold(&self, session_id: &str) -> TurnHold {
        let session = {
            let mut map = self.sessions.lock().unwrap_or_else(|e| e.into_inner());
            map.entry(session_id.to_string()).or_default().clone()
        };
        let running = session.gate.clone().lock_owned().await;
        TurnHold {
            _running: running,
            session,
        }
    }
}

impl TurnHold {
    /// The seq this turn's lines follow: core's base, or the last seq an
    /// earlier turn of the session on this box used, where that is higher.
    pub fn base(&self, core_base: u64) -> u64 {
        core_base.max(self.session.last_seq.load(Ordering::SeqCst))
    }

    /// Record `seq` as numbered by this turn.
    pub fn used(&self, seq: u64) {
        self.session.last_seq.fetch_max(seq, Ordering::SeqCst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn a_second_turn_of_one_session_waits_for_the_first_to_end() {
        let turns = ChatTurns::default();
        let first = turns.hold("s-1").await;
        let second = tokio::spawn({
            let turns = turns.clone();
            async move { turns.hold("s-1").await }
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !second.is_finished(),
            "a second turn of the session started while the first still ran"
        );
        // another session is not held by it
        let other = tokio::time::timeout(Duration::from_secs(1), turns.hold("s-2")).await;
        assert!(other.is_ok(), "one session's turn held another session's");
        drop(first);
        let second = tokio::time::timeout(Duration::from_secs(1), second).await;
        assert!(
            second.is_ok(),
            "the second turn never started once the first ended"
        );
    }

    #[tokio::test]
    async fn a_turn_after_another_numbers_past_the_lines_the_first_took() {
        let turns = ChatTurns::default();
        let first = turns.hold("s-1").await;
        assert_eq!(
            first.base(641),
            641,
            "a first turn numbers from core's base"
        );
        // the first turn's lines were numbered on, past the base core sent the second
        first.used(650);
        drop(first);
        let second = turns.hold("s-1").await;
        assert_eq!(
            second.base(642),
            650,
            "the second turn numbered from a base the first turn's lines had taken"
        );
        // core's base past what this box used stands
        assert_eq!(second.base(700), 700);
    }

    #[tokio::test]
    async fn a_box_that_restarted_numbers_a_resumed_session_from_cores_base() {
        // a restarted daemon holds nothing: its turns start from what core sent
        let before = ChatTurns::default();
        before.hold("s-1").await.used(900);
        let after = ChatTurns::default();
        assert_eq!(after.hold("s-1").await.base(642), 642);
    }
}
