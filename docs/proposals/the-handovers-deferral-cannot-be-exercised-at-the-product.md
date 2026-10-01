# The handover's deferral cannot be exercised at the product

**ISS-1223, 2026-09-26; rewritten for ISS-1379, 2026-10-01. A residual, left by the judgement of
ISS-1223's own change.**

ISS-1223 gave the runner's restart a bound, a give-up and a reopen interval. ISS-1379 turned the
restart into a handover — the daemon waits, with admission open, on its own in-process work, then
replaces its image in place — and kept the bound and the interval: in-process work that outlasts
two hours defers the handover, and no handover is attempted again for two hours after that.

What happens when that bound is crossed — the line naming what still holds it, saying admission
was never closed and stating the next attempt; the deferred state; the interval refusing whichever
loop asks next; a second handover requested during the first starting nothing — is covered by
controlled-clock tests in `packages/runner/crates/forge-runner-core/src/daemon/drain.rs`, and by
nothing else.

## Why no route reaches it

**The bound is a compile-time constant.** `DRAIN_TIMEOUT_SECS` and `DRAIN_REOPEN_SECS` in
`daemon/drain.rs` are both two hours, with no configuration key, no environment override and no
flag. Reaching a deferral on a running box therefore costs two hours of a chat turn inside the
daemon that does not end.

**The only second asker is the update loop.** `Drain::begin` is reached from exactly two places:
the credential loop, which a judge can raise by rotating a device token, and the update loop, which
begins a handover only after it has downloaded a manifest and swapped the binary at
`update.manifest_url`. On any box worth testing on, that path replaces the file the live daemon
runs from. So the second asker cannot be raised without either a manifest fixture served to a
daemon whose install path is disposable, or overwriting a real runner's binary.

## What would open it

Not proposed here, and not costed — this page exists so that the next person to reach for it starts
from the walls rather than rediscovering them.

| Choice | What it costs | What it buys |
|---|---|---|
| Leave it as it stands | Every judgement of the deferral is a reading of `drain.rs`'s own tests, so a defect those tests share a blind spot with survives every judgement this project knows how to make. Since ISS-1379 a deferral closes nothing and stops nothing, so that defect costs a box the new build for one more interval, not its admission. | Nothing, and no new surface. |
| Make the bound configurable | Two keys an operator can set wrong, and a box that defers every handover in thirty seconds never takes a new build. A production knob added to make a judgement cheaper. | The deferral and the interval, at a two-minute wait instead of a two-hour one. |
| A control verb that begins a handover | A verb on the control socket that acts on the daemon itself, where today there is none. Widening it is a decision about the socket rather than about this residual. | The deferral and a second asker, both on a running box. |
| A manifest fixture and a disposable install path | A fixture to build and keep, reachable by nobody but the suite. | The second asker, and nothing an operator can use. |

## What is true meanwhile

`forge-runner status` reads the deferred state back — `daemon/serving.rs` plants a `Deferred`
record and reads its line in its own tests — so the **reader** of a deferral is exercised. What is
not is the **writer**: the line `give_up_line` composes, and the state transition
`Drain::give_up` performs, have never been seen on a running box.
