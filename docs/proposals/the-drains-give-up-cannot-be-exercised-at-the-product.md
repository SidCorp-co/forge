# The drain's give-up cannot be exercised at the product

**ISS-1223, 2026-09-26. A residual, left by the judgement of that issue's own change.**

ISS-1223 gave the runner's restart drain a bound, a give-up and a reopen interval. Seven of its
nineteen acceptance criteria — 7 through 13 — are about what happens when that bound is crossed:
the line naming every holder, admission reopening, the next attempt being stated, the restart not
being taken, the reopen interval holding whichever loop asks, and a second drain requested during
the first starting nothing and moving nothing.

All seven were judged `skipped` on 2026-09-25, by the run that judged the rest of the change at the
product. They are covered by controlled-clock tests in
`packages/runner/crates/forge-runner-core/src/daemon/drain.rs`, and by nothing else, and they will
go on being judged there for as long as this page is true.

## Why no route reaches them

Two walls, and each criterion runs into one of them.

**The bound is a compile-time constant.** `DRAIN_TIMEOUT_SECS` and `DRAIN_REOPEN_SECS` in
`daemon/drain.rs` are both two hours, with no configuration key, no environment override and no
flag. Reaching a give-up on a running box therefore costs two hours of that box held by work that
does not end — and the give-up is the door to criteria 7, 8, 9, 10 and 11, since the reopen
interval is measured from it.

**The only second asker is the update loop.** Criteria 12 and 13 are about a drain requested while
another is under way. `Drain::begin` is reached from exactly two places: the credential loop, which
a judge can raise by rotating a device token, and the update loop, which begins a drain only after
it has downloaded a manifest and swapped the binary at `update.manifest_url`. On any box worth
testing on, that path replaces the file the live daemon runs from. So the second asker cannot be
raised without either a manifest fixture served to a daemon whose install path is disposable, or
overwriting a real runner's binary.

A third wall stands beside them, met by criterion 3 rather than by 7–13: the master sweep iterates
the runner list core hands back for a paired device, so a fixture daemon with no core reachable has
an empty list and never enters the loop at all. That one is reachable with a throwaway paired
device against a throwaway project; the two above are not reachable by any arrangement of
credentials.

## What would open them

Not proposed here, and not costed — this page exists so that the next person to reach for it starts
from the walls rather than rediscovering them. Three shapes were visible from the repair:

1. **Make the bound configurable.** A pair of keys in the runner's own config would turn a
   two-hour wait into a two-minute one. It is also a production knob whose wrong value is a box
   that gives up its restart in thirty seconds, so it is a change to what operators can do, not
   only to what a judge can reach.
2. **A control verb that asks a running daemon to begin a drain.** This also answers criterion 3,
   and it is the only one of the three that makes the sweep's hold-back observable. It widens the
   control socket, which today offers no verb that acts on work.
3. **A manifest fixture and a disposable install path**, wired as an integration test rather than
   as something an operator can reach. It opens 12 and 13 and nothing else.

## Honest costs

| Choice | What it costs | What it buys |
|---|---|---|
| Leave it as it stands | Every future judgement of the give-up is a reading of `drain.rs`'s own tests, so a defect those tests share a blind spot with — a give-up that composes its line correctly and never fires — survives every judgement this project knows how to make. Nothing is red and nobody is stopped; the bill arrives on the day that defect reaches a box. | Nothing, and no new surface. |
| 1 — make the bound configurable | Two keys an operator can set wrong, and a box that gives up its restart in thirty seconds looks exactly like a box that is working. A production knob added to make a judgement cheaper. | Criteria 7–11, at a two-minute wait instead of a two-hour one. The cheapest route in. |
| 2 — a control verb that begins a drain | A verb on the control socket that acts on work, where today there is none. That line is load-bearing, and widening it is a decision about the socket rather than about this issue. | Criteria 7–11 and criterion 3, and it is the only shape that makes the sweep's hold-back observable. |
| 3 — a manifest fixture and a disposable install path | A fixture to build and keep, reachable by nobody but the suite. | Criteria 12 and 13, and nothing an operator can use. The only shape that changes nothing a person can reach. |

## What is true meanwhile

`forge-runner status` reports the deferred state accurately — a judge planted a `Deferred` record
and read back *"the drain … gave up 10m ago with 1 outstanding …; admission is open, and the next
attempt is the next update check, due in 59m"* — so the **reader** of the give-up is exercised at
the product. What is not is the **writer**: the line `give_up_line` composes, and the state
transition `Drain::give_up` performs, have never been seen on a running box.
