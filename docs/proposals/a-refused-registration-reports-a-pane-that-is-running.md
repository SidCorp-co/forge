# A refused registration reports "no master pane placed" while the pane keeps running

Found while working ISS-1233, which owns the master-session route. Left here rather than fixed,
because the change is in `packages/runner/crates/forge-runner-core/src/daemon/master.rs` and that
file was declared held by another run's tree when this one was dispatched.

## What the daemon says, and what is true

`Unplaced::lead` in `daemon/master.rs` chooses what to say before a reason. Every variant but two
takes the default `no master pane placed`; only `Unplaced::StoodDown` with a pane, and
`Unplaced::StaleCapability`, carve themselves out — each of those was bought by ISS-1118
criterion 20, one symptom at a time.

`Unplaced::RegisterFailed` is not one of the two, and it cannot be treated as one by inspection of
the variant alone, because whether a pane is running is not in the value. `ensure_master` calls
`master_api::register` **before** it calls `terminal::alive`, so on a sweep that finds a resident
pane and a refusing core, the daemon emits:

```
[master] <slug>: no master pane placed — core refused this box's master registration for it: …
```

with the pane alive and nudged seconds later. Measured on 2026-09-24 at 23:18:43–23:19:27 and
recorded on ISS-1233: pane placed, nudged, then the line saying it was not placed, then nudged
again. The line fired 46 times that day.

## Why it is worth a change rather than a note

The true statement is different and more useful: the registration was refused, and the pane that
already exists keeps running **unregistered**. That is the shape ISS-1099 was filed over. An
operator reading the journal during a burst acts on `no master pane placed` by restarting the
daemon to get a pane — and a restart during live work is how a job is lost.

## What the mechanism is, not the symptom

`lead` answers from the variant alone, and three of its variants now depend on something the variant
does not carry: whether a pane is running. Adding a fourth carve-out buys the fourth symptom and
leaves the fifth. The deliverable is that the pane's state at the moment the line is written is an
input to `lead` rather than a property some variants happen to encode — which also makes
`Unplaced::is_error` answerable on the same reading.

## What ISS-1233 did take

The other half: `transport/master.rs` and `transport/runners.rs` no longer format a status with
`reqwest::StatusCode`'s `Display` or paste a gateway's HTML page, and both now carry
`transport::CALL_DEADLINE`. The reason string an operator reads through `RegisterFailed` is the
transport error verbatim, so it is legible now whatever `lead` says in front of it —
`transport/status.rs`'s `the_unplaced_reason_an_operator_reads_is_the_transport_error_itself` pins
that coupling.

## Honest costs

- **`lead` gains an input, so every caller has to supply it.** The pane's state is read from tmux,
  which is a syscall on a path that today decides from a value already in hand; the sweep would
  either read it twice or carry the first read further than it does now.
- **Four carve-outs become one rule, and the wording of three existing lines moves with it.**
  `Unplaced::StoodDown` and `Unplaced::StaleCapability` say what they say because ISS-1118 asked
  for exactly those sentences; a rule that computes the lead will change them unless it is made to
  reproduce them, and reproducing them is most of the work.
- **Leaving it costs an operator a restart.** `no master pane placed` under a live pane reads as a
  project with no master, and the reflex is to restart the daemon during live work, which is how a
  job is lost. That is the price of not doing this, and it is the one the record already shows.
- **Whoever takes it re-reads a file this run deliberately did not open.** The measurements here are
  from ISS-1233's comments rather than from a fresh run of the daemon, so the 46-a-day figure is a
  starting point to reproduce and not a result to cite.
