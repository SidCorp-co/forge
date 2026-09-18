# A doorbell ring cannot say whether the ear has gone *yet*

**Status:** open. Raised from ISS-1096 and deliberately not fixed there — `Ring::NoListener` is
ISS-964's contract and a bounded wait is gated on it, so changing when it is reported is that
issue's decision and not a flake to paper over from inside another one.

## What was measured

`runner::doorbell::tests::dropping_the_ear_stops_the_door_being_heard` went red once during
ISS-1096's work, on the first full `cargo test` of `packages/runner` after merging `main` into the
branch, at loadavg 25 on a box carrying four other runs.

- 1 red in 4 full-suite runs.
- 5 of 5 green when run alone.
- 3 of 3 full-suite runs green immediately afterwards, at 835 passed.

It is **not** test isolation: `led_path()` mints a fresh `door-<uuid>` directory per call, so no two
tests in the module share a FIFO. The file last moved in `28fc6d654` (ISS-964); neither ISS-1096's
diff nor ISS-1099's #522 touches it.

## The shape

The test is four lines: `listen` opens the pipe, `ring` is asserted `Ring::Heard`, the ear is
dropped, and the next `ring` is asserted `Ring::NoListener`. The suspected mechanism is that under
load the close of the read end has not propagated by the time the second `ring` runs, so it still
reads `Heard`. That is consistent with everything above and is **not** confirmed — reproducing it
deliberately was not attempted, because the disposition below does not depend on which timing
detail is responsible.

## The decision that is owed

Not "make the test stable". The question underneath it is what `Ring::NoListener` means:

- **the ear is gone** — a fact about the listener, in which case a ring racing the close is
  reporting something that has already become true, and the test is asserting a state the ring
  cannot yet see; or
- **the ear is gone and that is now observable** — a fact about what this ring could detect, in
  which case `Heard` on a just-closed door is the correct answer and the assertion is wrong.

The readers of that verdict are what make it ISS-964's to settle: a bounded wait is gated on
`NoListener`, so the two readings differ in whether a question can be parked against a run whose
listener died between the ring and the read.

## Honest costs

The cost of settling this, not of the red that raised it. Both readings are priced, because which
one is taken is the decision.

| Reading | What taking it costs |
|---|---|
| **The ear is gone** (a fact about the listener) | `ring` must become able to report a listener that has closed but whose close has not propagated — an extra syscall, a retry, or a handshake, on the hot path every bounded wait rings through. Every ringer pays that on every ring to make one assertion in one test deterministic. |
| **The ear is gone and that is now observable** (a fact about this ring) | `Heard` becomes a legitimate answer for a door whose listener has already died, so a bounded wait can be parked against a run nobody is waiting on. Whoever reads `Heard` inherits the job of noticing that later, and the doorbell stops being the single place that question is answered. |
| **Make the test tolerate the delay** (the cheap option, and the one to reach for first) | It is a few lines and it removes the signal: an assertion that waits or retries until `NoListener` appears can no longer tell a close that propagated late from one that never happened, so a `ring` that wrongly reports `Heard` forever stops being visible here. This is the disposition that costs least today and most later, which is why it is priced rather than left unnamed. |
| Either | The existing assertion in `dropping_the_ear_stops_the_door_being_heard` is rewritten or deleted, so the one test that names this behaviour today stops being evidence for it until the replacement lands. |
| Doing neither | A red that reproduces roughly once in four full runs under load stays on a required check, and the next person to meet it has to re-derive this measurement before they can tell it from a real defect. |
