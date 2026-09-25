# Scratch outside a repository has no reaper, and the one inside it is too slow to be one

A runner box fills with directories that no owner removes, and on 2026-09-25 one of them filled far
enough that an agent lost its shell: `/tmp` on `sid-xeon-1` — a 61G tmpfs, so RAM — reached
`ENOSPC`, and every shell call that agent made died before it ran with
`ENOSPC: no space left on device, open '/proc/self/fd/11/<id>.output'`. It could take none of the
acts that would have freed space, and nothing anywhere named the disk (ISS-1260).

The daemon now reads that filesystem and says so before the ceiling —
`packages/runner/crates/forge-runner-core/src/daemon/headroom.rs`, on both axes, at a level that
rises. **It reclaims nothing.** This page is what the next change in this area has to start from.

## The two properties of the reaper that keep it out of reach

`packages/runner/crates/forge-runner-core/src/workspace/worktree_reap.rs` is the only thing on a box
that removes a finished run's checkout, and two of its properties put every tree that filled
`sid-xeon-1` outside it.

**It removes no checkout younger than fourteen days.** `MIN_AGE` in that module is
`14 * 24 * 3600` seconds. The trees measured on the day of the failure were 26 hours old at their
oldest, and the box consumed roughly 93,000 inodes — 9% of that filesystem's total — in four hours.
A reaper whose youngest candidate is a fortnight old cannot defend a box that fills in a morning,
and nothing about running its sweep more often changes that: the predicate, not the cadence, is what
declines.

The fourteen days are not an oversight. That module's own opening says why the predicate is
deliberately timid — it deletes work, and a wrong judgement there is unrecoverable — and a
well-behaved park has exactly the shape of an abandoned tree. A change that simply lowers the number
trades that protection for disk and owes the trade a price.

**Both of its roots lie inside a repository.** `WORKTREE_ROOTS` in the same module is
`[".claude/worktrees", ".worktrees"]`, joined to each bound repo's path. Nothing outside a
repository is in its reach by construction, and every tree that filled the box was outside one:
`/tmp/iss<n>-judge-XXXXXX` trees at 16.8G and 30,199 inodes between four of them, five
per-judgement checkouts inside one live session's scratchpad at about 66,000 inodes each, and 115
`/tmp/iss1153-XXXXXX` directories from a single run.

**What is on the box is agent scratch, not the runner's.** Re-measured 2026-09-26, `/tmp` stood at
622,848 of its 1,048,576 inodes used. `/tmp/claude-1000` held 383,375 of them and per-judgement
trees — `iss1190-judge8`, `judge-iss488`, `judge-1218` — another 88,132, so 461,507 of the 622,848
belong to agent scratch. The 290 `/tmp/forge-*` directories on the box are a separate and much
smaller population: 6,946 inodes and 42M between them, test fixtures left by `cargo test` under
prefixes (`forge-inflight`, `forge-ledger`, `forge-terminate-*`, `forge-wt-reap-*`) that no longer
appear anywhere in the tree, so they are litter from code that has since moved rather than evidence
of the mechanism this names. Counting them as scratch accumulation reads the number the wrong way.

**The reporting half reads both filesystems, and had to be corrected to.** A daemon here runs with
`TMPDIR=/home/dev/.cache/forge-tmp`, which is on the root disk at 88% of its inodes free, while the
tmpfs above is at 40%. `headroom::scratch_roots` therefore reads the configured root *and* `/tmp`
when the two are different filesystems, and reports the shorter. Reading only the configured one —
which is what it did when first written — reports `Clear` for this box while the filesystem that
actually fills is the one nobody is looking at.

## Why this repository could not close it

A reaper needs an owner and a condition, and outside a repository this box has neither. Nothing in
either runner crate creates a run scratch tree and leaves it: the one site that makes one,
`stage_attachments` in `packages/runner/crates/forge-runner-core/src/daemon/chat.rs`, removes it on
every exit, and `/tmp` held no `forge-attach-*` directory when this was measured.

The trees that do accumulate are minted by hand by the runs themselves, because they are told to be.
The `forge` CLI models a run's scratch already — a `forge-run-<run-id>` directory recorded beside the
tree's git directory — but only its workspace start mints one, and this fleet dispatches by brief.
Measured across the five repositories this box drives: 17 run-id records, **zero** scratch records,
**zero** `forge-run-*` directories. So `forge doctor` tells every run here to make its own with
`mktemp -d`, each one does, and the result is a tree no record names.

That half is `github.com/SidCorp-co/forge-plugin`, which this repository reaches by issue and never
by diff. It is filed as forge-plugin ISS-2525.

## What the next change here needs

Once a run's scratch carries a record, the reap becomes attributable and this repository owns it:
the daemon is the only process on a box that outlives every run, and its ledger is the only thing
that knows a run has ended. Two things are then worth having, and neither is worth having before it:

- A sweep over the scratch root that keeps a tree whose record a live run still holds, removes one
  whose run the ledger says has ended, and **keeps, loudly, one it cannot attribute at all**. The
  last of those three is the whole difference between this and a name-matching sweep that deletes a
  judge's evidence.
- A second, much shorter minimum age for a scratch tree than for a checkout. The fourteen days buy
  protection for unpushed commits and unsaved edits; a scratch tree holds neither, and what it does
  hold that matters — a verdict's evidence — is attached to the issue rather than left on disk.

Until then the report is the whole of this box's defence, and the report says so: every line it
writes about pressure states that the worktree sweep will not reclaim it.

## Honest costs

| What adopting this costs | The price |
|---|---|
| A reading every five minutes for the life of the daemon | One `statvfs` per tick, on almost every box finding nothing at all. That wakeup is paid on every box for ever so that the one box in four hours of filling is seen rather than inferred afterwards from a shell that stopped working. |
| Thresholds set from one box's measurement | 8% and 20% are right for a filesystem of about a million inodes whose unit of work costs sixty-odd thousand of them. A box whose runs are much larger is warned too late by the ratio, and one whose runs are much smaller is warned too early; nothing here tunes them per box, and a wrong threshold is worse than none because it trains the reader to ignore the line. |
| Stopping at a report | The defence is now a person reading a journal. A box that crosses the threshold with nobody watching fails exactly as it did on 2026-09-25, and the only thing that has changed is that the failure is explicable afterwards. Anyone adopting this should read it as buying diagnosis, not protection. |
| Saying what the sweep will not do, in every pressure line | The line is longer than an operator wants and repeats the same clause every hour a condition stands. That is the price of the alternative, which is a warning that reads as though something is already handling it. |
