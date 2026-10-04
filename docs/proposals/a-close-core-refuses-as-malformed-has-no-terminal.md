# A close core refuses as malformed has no terminal on this side

**Removed when:** a close core refuses with a constraint answer is recorded in a ledger mark of its
own that takes the row out of `ended_with_open_session`, which dev ISS-139 carries. The change that
lands it deletes this file.

ISS-1284 stopped one of the two forever-loops in
`forge-runner-core::daemon::run_record`. This is the other one, left standing on purpose and
written down rather than worked around.

## What stands

`close_ended_runs` sends core a close for every run whose session is open and whose row has ended.
When core refuses, the arm is `tracing::warn!("… the next sweep tries again")` and the row keeps
`session_terminal_at IS NULL`, which is exactly what `Ledger::ended_with_open_session` selects on.
So a close core will never accept is re-sent once per sweep, for as long as the daemon runs — the
same shape ISS-1284 measured at 351 refusals in one evening on the open path.

ISS-1284 closed the reachable half of it: the `detail` this box sends is now built to the 500 units
`closeBodySchema` states, so an operator's `forge-runner run close --reason "<long>"` can no longer
earn that 400. What remains reachable is the `checkpoint`: it is assembled by
`checkpoint::reconstruct_within_budget` and validated at core by `runCheckpointSchema`, and a shape
those two disagree about is refused the same way and retried the same way.

## Why the fix ISS-1284 took does not transfer

On the open path the terminal act is honest: the run never got a core session, so
`Ledger::end_run` ends a row that core has no counterpart for, and `close_loop::close` already
reads `session_id: None` as a session that is over.

On the close path there is a session at core, it is not terminal, and the only mark this side has
for *this run is finished at core* is `mark_session_terminal_observed`. Setting it on a close core
refused would record core having closed a session core did not close — the state lying about
itself, which `VISION: state-never-lies` refuses. Nothing else in the ledger distinguishes *core
refused this close* from *this close has not been sent yet*, so a run that stopped re-sending would
be indistinguishable from one whose sweep had not reached it.

## The three shapes a fix could take

1. **A mark of its own.** A `close_refused_at` column, written when `status::constraints` answers
   on a close, read by `ended_with_open_session` so the row leaves the sweep, and surfaced by
   `forge-runner run status` so an operator can see a run core would not take the close for. The
   honest option and the one that costs a ledger migration.
2. **Send a close core cannot refuse.** Drop the `checkpoint` and re-send the close alone on a
   constraint refusal. Cheapest, and it is the silent substitution this repo refuses by name: the
   evidence a run owes would go missing and nothing would say so.
3. **Validate the checkpoint before it is sent**, on this side, against the same shape core states.
   It narrows the reachable set the way the `detail` cap did, and it does not terminate anything —
   a constraint nobody has added yet reopens the loop.

Only (1) ends the loop. It is not ISS-1284's to take: that issue's Outcome is written to the
declaration, and a ledger migration plus a new operator-visible state is a change no reviewer of
this one asked for.

## What is already in place for whichever is taken

`transport::status::constraints` answers *which constraints core named* for any refusal, and
`Error::Malformed` carries them to the caller. The classification a terminal close would read is
therefore already there; what is missing is the state to write it into.

## Honest costs

- **Leaving it standing costs a wedged run and about 25 calls every ten minutes, indefinitely.** A
  close core will not take keeps the row non-terminal, which holds its issue leases and its
  checkout, and the calls are spent from an account limit that refused every master on this box for
  28 minutes on the evening ISS-1284 was filed.
- **Shape (1) costs a ledger migration and a new state an operator has to learn.** Every box's
  sqlite ledger gains a column, `forge-runner run status` gains a state that means *core refused
  this close*, and somebody has to decide what an operator does about a run sitting in it.
- **Shape (2) costs the run evidence and says nothing about losing it.** Dropping the checkpoint to
  get the close accepted makes the loop disappear and the diff, the turn record and the reason the
  run ended disappear with it, which is the outcome this repository refuses by name.
- **Shape (3) costs a second copy of core's schema, kept by hand.** A checkpoint validated on this
  side is a shape stated twice on two release clocks, and the day the two disagree the loop comes
  back wearing the validator that was supposed to prevent it.
- **Reading this document costs the reader the belief that ISS-1284 closed the whole defect.** It
  closed the declaration path and bounded the one reachable trigger on the close path; the
  mechanism on that path is untouched, and anybody measuring "is the retry loop fixed" has to know
  which half they are measuring.
