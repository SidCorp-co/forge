# A moved-worktree fixture gave two answers under real CI, and never once locally

Met while landing ISS-1265's PR #733: `runner (ubuntu-latest)` went red on a test the branch's own
diff never touches, then passed clean on an immediate rerun of the identical commit. That is not
"flaky, therefore harmless" — a test that answers two ways against one tree is a green that proves
nothing either way, in this repository's own terms, and the rule for a residual met while working an
issue is to record it here rather than go quiet or file a new issue for it.

## What happened

`packages/runner/crates/forge-runner-core/src/runner/terminate.rs`'s
`the_sweep_does_not_conclude_a_release_from_a_path_that_does_not_resolve` failed once, in CI, on
ISS-1265-b2 at `bcd440d5f`:

```
thread '...the_sweep_does_not_conclude_a_release_from_a_path_that_does_not_resolve' panicked at
crates/forge-runner-core/src/runner/terminate.rs:2476:9:
an absent path is a question for git's registry, never proof of removal
test result: FAILED. 1679 passed; 1 failed; 1 ignored; 0 measured; 0 filtered out; finished in 15.45s
```

(`runner (ubuntu-latest)`, run 36397778979, job 108848230848, finishing in 1m48s against
`runner (macos-latest)`'s 3m46s and `runner (windows-latest)`'s 3m37s on the same push — the ubuntu
leg was the fastest of the three and still the one that lost an assertion.)

The test drives `runner::close_loop::close` against a fixture (`moved_worktree`) that really runs
`git worktree move` on a real scratch repo, then asserts that a ledger row naming the *old*,
now-gone path is not marked `worktree_gone_at` — because git's registry says the checkout moved,
not that it vanished. `close_loop::checkout_returned` reads that registry through
`workspace::worktree::residence_of`, which is where "an absent path is a question for git's registry,
never proof of removal" comes from as a design rule (`residence_of`'s own doc), quoted back in the
test's assertion message.

## What was ruled out, and how

**Not this branch's diff.** ISS-1265-b2 touches only `daemon/inbox.rs` and `daemon/terminal.rs`;
`runner/terminate.rs` and everything `close_loop`/`residence_of` reach are untouched, and the test
predates this branch (last changed by `b20102782`, ISS-1250, before ISS-1265 was ever opened).

**Not deterministic against this commit.** The exact failing test, in isolation, 15/15 on the box
this repair was built on. The full `cargo test --workspace` — the same invocation CI runs —
1680/1680 (0 failed) three times running, back to back, on `bcd440d5f` itself.

**Not deterministic against a clean `origin/main`.** A separate worktree at `6a0bd84a4` (main, no
ISS-1265 content at all) ran the same full suite five times: 1670/1670 every time, this test always
`ok`. (The count differs from the branch's 1680 only because `main` had moved past the branch's
merge-base by the time this was run — ten more tests landed from other work, not from this one.)

**A GitHub Actions rerun of the exact same commit's exact same job passed.** `gh run rerun
36397778979 --failed` on `runner (ubuntu-latest)` alone came back green, and `ci-passed` recomputed
green with it — so the tree this PR carries has now been judged both ways by the same CI, on the
same commit, roughly two minutes apart.

So the one thing this is not is a regression ISS-1265 introduced, and the one thing it is not either
is a bug that only exists in the writer's head — the assertion really did fail, once, on real
hardware, against code nobody here changed.

## What is left standing

A timing- or load-dependent path through `residence_of` (or the fixture's own `git worktree move`,
which is a real subprocess doing real filesystem work) that this repository's own sandbox has not
been able to force in eighteen-plus attempts across two trees, but that GitHub's `ubuntu-latest`
runner produced once, in a build that otherwise finished faster than its passing siblings — the
opposite of the "the box was overloaded" story a slow, timed-out leg would tell. A next run with
time to spend on it starts from `residence_of`'s git subprocess handling: whether a `git worktree
list`-shaped read can observe the repository mid-write from `git worktree move` and answer something
other than `MovedTo`, and whether that answer is `Gone` (this test's failure) or `Unknown` (which
would not have failed it, per `checkout_returned`'s own match arms).

## Honest costs

| Cost | To whom | Measured |
|---|---|---|
| A reproduction that may not exist on this box at all | whoever picks this up | 0 failures in 18 attempts (15 isolated + 3 full-suite) on the branch, 0 in 5 full-suite runs on a clean `main` |
| The only evidence is a single CI job's log | the next run | a rerun of the identical commit already destroyed the chance to inspect the failing process further; nothing here captured git's stderr or a strace |
| Riding past it costs nothing today, and that is the risk | the project | `close_loop` prefers the fail-safe direction (`Unknown` keeps holding the checkout) for exactly this reason, so a wrong `Gone` here is the one direction that is NOT fail-safe: it is the same shape ISS-1265 itself exists to stop for `session.send`, one layer down, in a different subsystem |
