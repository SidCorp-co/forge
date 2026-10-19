# A pane placed under the full suite once lacked the daemon's TMPDIR

I hit this while running ISS-1265's round-3 gate. It happened once and has not been reproduced. It
goes on record here because a test that gives two answers against one tree proves nothing either
way, and a residual found while working an issue is written down, not filed and not dropped.

## What happened

`packages/runner/crates/forge-runner-core/src/daemon/daemon_env.rs`'s
`a_pane_on_a_server_older_than_the_daemons_tmpdir_carries_it` (ISS-1325 criterion 1) failed in the
first of three `cargo test --workspace` runs on branch `ISS-1265-r3-no-server-means-no-session`:

```
assertion `left == right` failed: a pane placed on a server that never had the daemon's TMPDIR must still carry it
  left: None
 right: Some("/home/dev/.cache/forge-tmp")
```

The pane's `/proc/<pid>/environ`, read by `terminal::testing::environ_once_running`, held no
`TMPDIR` at all. That is not a wrong `TMPDIR`. It is a missing one.

## What was ruled out

- **This branch's diff.** The change touches how a presence answer is classified
  (`terminal::has_session`, `recovery_ports::absent_or_unanswered`), the inbox's log wording, and
  test helpers. `daemon_env::for_pane`, `terminal::ensure`'s `-e` arguments and the environ read are
  untouched. `alive`, which `ensure` reads, gives the same answer it did before.
- **Determinism.** Runs 2 and 3 of the workspace passed, with 2674 tests. Two more full
  `forge-runner-core --lib` runs passed, and eight runs of `daemon_env::` alone passed. That makes
  one failure in five full runs, and none in isolation.

## What it most likely is, with the gap stated

`World::new` sets `TMPDIR` through `ScopedVar` while it holds `ENV_TEST_LOCK`, and `for_pane` reads
the daemon's value from the process environment when the pane is placed. A test elsewhere in the
crate that sets or removes `TMPDIR`, or replaces the whole environment, without that lock would
produce exactly this. The writers named in `daemon/pool_jobs.rs` and `daemon/master.rs` both take
the lock. No writer that skips it was found. So the chain has a gap at its first link.

## What ends it

Either a reproduction that names the writer, followed by that writer taking `ENV_TEST_LOCK`, or a
change that hands the pane a value captured once at daemon start rather than read when it is
placed. Before choosing the second, check how the daemon's own environment is refreshed on reload.

## Honest costs

- **Leaving it costs a red that does not reproduce.** The next run to meet it pays a cycle
  establishing that it is not theirs, just as this run did.
- **Capturing `TMPDIR` once at daemon start costs the live refresh.** A daemon whose unit file
  changed `TMPDIR` would keep handing panes the old value until it restarts.
