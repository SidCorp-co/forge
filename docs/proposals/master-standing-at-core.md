# The half of a master's standing that belongs to core

ISS-1118 gave a resident master a representable stood-down state. All of it landed on the runner
box: `master_standing` in the box's own ledger, read by the sweep off the handle it already holds,
written and lifted by `forge-runner master stand-down` / `stand-up`.

Nothing of it reaches core, and an owner working the web UI still cannot see or set it. That is
deliberate and it is not finished. This page is the part that was not built, so the next person
starts from what is here rather than from the same reading.

## Why it stopped at the box

The sweep is the only code path that would place a replacement pane, and it runs on the box. Putting
the decision anywhere the sweep has to reach over a network for would mean a box that cannot reach
core replaces the very pane its owner withheld — the failure mode the whole change exists to close.
The ledger is where the sweep already reads the conversation id, one expression above, so the
stand-down costs nothing extra to honour and cannot be undone by core being down.

The web half is a different deliverable: it is a control core can *set*, which the daemon then has
to notice. That needs a migration in `packages/core`, a field on the runner-serving payload, a
control in `packages/web-v2`, and a rule about which of the two answers wins when they disagree.

## What would have to be decided

**Where the field lives.** The natural home is the row `GET /api/devices/me/runners` already serves
per project — `MeRunner` in `packages/runner/crates/forge-runner-core/src/transport/runners.rs`
parses it. A nullable `master_stood_down_at` plus who and why would slot in beside `master_policy`,
which is already an owner statement carried on that row.

**Not a fifth runner status.** `draining` and `disabled` both take the same `accepts_new_work`
branch in `daemon/master.rs` and neither ends a running pane. ISS-1118's own comment `67e22e32`
established that; a fifth status there would be a fourth control over a question the issue already
found ambiguous.

**Which answer wins.** Two writers means two answers, and `VISION: state-never-lies` says the box
must be able to say which it is following. The cheap reading is that the box's own ledger row wins
where both exist, and core's is a default a local stand-up clears — but that is a reading, not a
decision, and it is the one thing on this page that a later change cannot quietly assume.

**How the box learns.** The sweep already calls `runners::list_me` every pass, so a core-set
stand-down would be read there and written through to the ledger, leaving the placement decision
exactly where it is now — `placement_under` in `daemon/master.rs`, off the ledger, on the box.

## What already exists to build against

- `Ledger::stand_down_master` / `stand_up_master` / `master_standing`, and the `master_standing`
  table, in `packages/runner/crates/forge-runner-core/src/runner/ledger.rs`.
- `placement_under` and `Unplaced::StoodDown` in
  `packages/runner/crates/forge-runner-core/src/daemon/master.rs` — the whole decision, pure, and
  the reason a pane is absent, in words that name the act that reverses it.
- `master_exit::holding`, which answers what runs a master holds in three values rather than two.
- `forge-runner master status`, which already prints the pane answer and the standing answer as
  separate lines. A web surface has the same two questions to answer.

## Honest costs

| Cost | What it buys, and who pays |
|---|---|
| Two writers for one decision | Today one place holds a stand-down and one command writes it, so there is nothing to reconcile. Putting the same decision at core means a box and a server can each hold an answer, and every reader from then on has to know which it is looking at — including paths with nothing to do with masters |
| A migration, a contracts change and a screen | A column, a serialized field on the runner-serving payload, a control in `packages/web-v2`, and the tests for all three. It buys exactly one thing: reaching the decision without a terminal on the box. An owner who already has one pays the whole price for nothing |
| A round trip between the act and the effect | A stand-down set at core takes effect on the next sweep that reads `me/runners`, so an owner who clicks it watches the master keep running for up to a poll interval. The local verb is immediate. Whatever the UI says while that gap is open is a promise somebody has to keep, and "stopping…" is a state this product does not otherwise have |
| The precedence question arrives unanswered | This page states which answer should win and does not settle it. A change that ships the field without settling it ships two answers and a reader who cannot tell which is running — which is the defect ISS-1118 existed to close, arriving from the other direction |
| A local stand-up can be silently re-imposed | If core's answer is a default the box re-reads every pass, an operator who stands a project up on the box gets it stood down again thirty seconds later by a field nobody remembers setting. Whoever builds this owes that operator a line saying where the decision came from |

## What this does not ask for

Changing the daemon's residency model. One master per served project, parented by tmux so it
survives a `forge-runner` restart, is ISS-919's decision and is correct. ISS-1118 added a veto over
placement; it removed no gate and it places no pane it did not already place.
