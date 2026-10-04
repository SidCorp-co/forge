# A message refused at a live pane waits, and nobody counts the wait

**Removed when:** a pending session-send that has stayed `unknown` past a declared deadline produces
a visible outcome, which dev ISS-133 carries. The change that lands it deletes this file.

Met while working ISS-1265, which stopped the runner reporting a refused message as a session that
ended. Neither residual below is caused by that change, and neither is in its reach; both are
written down here rather than filed, because a residual out of reach leaves as a line in
`docs/proposals/`.

## 1. Nothing bounds the wait the silence buys

ISS-1265 makes the runner say nothing when a master pane refuses a message — a draft at the
composer, a choice list, a tmux that could not be asked. Core reads that silence as `unknown`, which
is true, and waits.

What nothing does is end the waiting.

- `packages/core/src/agent-sessions/session-send.ts:resolveSessionSend` answers `unknown` for as
  long as the session is non-terminal and the runner's `lastSeenAt` is inside
  `dispatchLivenessMs()`. A pane whose draft is never cleared satisfies both for ever.
- `packages/core/src/pipeline/answer-resume.ts:resumeLapsedAnswers` acts only on `gone`, so it
  sweeps that row on every tick and does nothing with it.
- `packages/core/src/agent-sessions/session-send.ts:requestSessionSend` republishes only when a
  caller sends the same intent again. Nothing schedules that.

So an answer someone typed can sit unapplied with no retry, no escalation and no row anywhere
saying how long it has been sitting. Before ISS-1265 the same message was equally undelivered and
the issue was ALSO re-dispatched against a session that was still running, so the silence is
strictly better — but better is not bounded.

What would end this: a decision about delivery policy. How long a pending message may wait, and
what the deadline produces — an intervention event, a question to a person, a bounded resend. That
decision is nobody's to take inside a runner issue, which is why it is here rather than in a diff.
The evidence is `daemon::inbox::tests::a_message_refused_at_a_dirty_composer_is_never_acked_gone`,
which asserts the silence and says nothing about what follows it.

## 2. `supervise` closes a master's row on a tmux it could not ask

Separately, and by exactly the mechanism ISS-1265 fixed one caller of:

`packages/runner/crates/forge-runner-core/src/daemon/master.rs:supervise` reads
`if !terminal::alive(&name).await` and, on `false`, logs *resident session {name} is gone* and calls
`end_master`. `alive` answers a single bool, and after ISS-1265 the three-valued
`terminal::has_session` under it shows what that bool hides: `false` is returned both where tmux
said it holds no such session and where tmux could not be asked at all. A tmux that cannot be run —
the state `terminal::testing::UnaskableTmux` exists to produce — therefore ends a master's row on
the strength of a question nobody answered.

The fix is one line at that call site — read the three-valued answer and end the row only where
tmux said the session is absent — plus the visibility to reach it: `has_session` and `Presence` are
private to `terminal.rs` today, because ISS-1265 had exactly one caller for them, so taking this
means exporting a predicate for `supervise` to read (`pub(crate)` on both, or a
`terminal::confirmed_absent(name) -> bool` that answers the one question a caller outside the
module has). That is two lines and a decision about which shape the export takes, not one line.

It is not taken here because `daemon/master.rs` is held by another run's branch (ISS-1238) at the
time of writing, and a file another run holds is not this one's to edit. It is reported as a comment
on that issue as well as here, so whichever lands first can take it.

## Honest costs

- **Writing the delivery-policy decision down costs a product argument nobody has had yet.** Whoever
  bounds the wait has to name a deadline in wall-clock time and defend it against both a master that
  is mid-turn for twenty minutes and an operator who walked away, and every value picked there is
  wrong for one of those two.
- **A bounded resend costs duplicate turns.** The runner cannot tell a message that was never typed
  from one typed into a pane whose capture it failed to read, so any automatic retry buys the risk
  of the same answer arriving at the agent twice, which is the failure `markSessionSendApplied`
  exists to keep apart from a write that landed.
- **Leaving residual 1 unbounded costs an answer that can sit for ever with no row saying so.** The
  person who typed it sees a comment posted and nothing else; nothing on the issue, the run or the
  Attention list distinguishes that from an answer the agent read and is working on.
- **Taking residual 2 costs a second reader of `has_session` in `daemon/master.rs`**, and with it
  the line that `alive` is the answer every caller there reads: the next caller that needs the
  three-valued answer has to be judged one at a time rather than following one convention.
