# R7's subprocess reading has no committed test

**Status: OPEN (2026-09-17). Needs a decision about `conformance-audit.mjs`'s execution model,
which is why no diff carried it — see "Why this is a proposal and not a commit".**

`conformance-audit.mjs:unresolvableEdges` is the only rule in the audit that RUNS anything, and on
2026-09-17 it was found wrong twice independently in the same hour: it reported *"archmap printed no
unresolvable count"* — a sentence about the tool's WORDING — for an `archmap` that had started and
then failed to deliver its stdout, sending a reader to the regex above it rather than to the
subprocess. ISS-1074 fixed it (`5745a31a1`) and ISS-1085 fixed it separately; ISS-1074's landed
first and is the one on the trunk. It is correct. This document is about what neither fix left
behind.

## The shortfall

The fix's whole content is an **ordering**: the count is parsed FIRST, and only a child that
printed no count is judged on its signal and exit status. Inverted — status consulted before the
stdout is parsed — every genuine violation `archmap check` reports becomes `could not run`, because
`archmap` exits non-zero precisely when it has findings to print. That is a gate going quiet in the
one direction a gate must never go quiet, and it is a two-line reordering away at all times.

Nothing committed holds that ordering down. The proof that exists is a `cm:guard` above the
function stating the intent in prose, and stubs its author ran by hand and described in the commit
message (a `kill -9` self-killer, an exit-3 stub, and the real binary). Both are records of a past
run. Neither fails if someone reorders the two branches tomorrow, which is the repo's own bar:
*a test that cannot fail has not been written yet*.

## What the test would assert

Written against ISS-1085's discarded extraction and each watched red before the fix existed:

1. a clean run's `N unresolvable edges` measures, and the `N unresolvable of M possible edges`
   phrasing measures identically (both wordings the tool has shipped);
2. **a non-zero exit that still printed a count is MEASURED, not blocked** — the inversion above,
   and the only assertion that distinguishes the fix from the defect;
3. a kill by signal names the signal, reports `could not run`, and does not report a violation;
4. a non-zero exit with no count names the status and the last line of stderr.

## Why this is a proposal and not a commit

Every route to committing it changes how `conformance-audit.mjs` executes. The function is not
exported, `const resolution = unresolvableEdges()` runs at module scope, and the module ends in
`process.exit`, so importing it runs the whole audit and kills the test process. The repo's own
convention for a testable checker — `check-lazy-module-init.mjs`, which exports its pure function
and guards its main — would mean wrapping the 16 top-level statements below that call in an
`isMain` guard and exporting the function. The alternative is to lift the reading into
`scripts/lib/`, which is where every other tested checker's logic lives.

Either is a defensible shape and both are a structural change to a gate file. ISS-1085 declined to
make it: that file was four hours old, its fix was correct, and a second rewrite of it inside a
Sentry PR would have been a competing implementation nobody reviewed for that reason. The choice
belongs to whoever owns the audit's shape, not to the next diff that happens to go red on it.

## Honest costs

Priced against the two shapes above, not against the false red that found this.

| Cost | Who pays it |
|---|---|
| The audit stops being a script that runs top to bottom. Whichever shape is chosen, `conformance-audit.mjs` gains an execution mode it does not have today — an `isMain` guard around 16 top-level statements, or a second file the rule's logic lives in. Every future reader of the gate pays the indirection. | whoever reads the audit next |
| A third rewrite of a file already rewritten twice in one day, with the conflict cost that implies for anything open against it. `scripts/conformance-audit.mjs` conflicted once already on 2026-09-17, and a conflicting PR on this repo gets no CI runs at all. | whoever holds an open branch touching it |
| The extraction shape splits a rule from its `cm:guard`s. The two guards that make this function comprehensible sit inline; moving the body to `scripts/lib/` either moves them away from the spawn they describe or duplicates them. | whoever maintains the guard text |
| A test harness must fake the child process, so it proves the reading and not the tool. `archmap`'s real wordings stay verified by the regex comment alone, and a third phrasing would pass the new tests and still fail the gate. | whoever upgrades archmap |
| Whatever makes the second spawn come back unreadable is not fixed by any of this, and a green test suite here may read as if it were. The tests would pin the READING of a child process; they say nothing about why a child that ran goes quiet. | whoever next sees R7 red inside a full `verify` |

## One thing to know before picking a shape: the false red had a cause, and it is fixed

The red that started this was **false**, and on 2026-09-18 the cause was established and fixed.
Read this section before picking a shape, because it changes what a test here is for.

**Measured, then.** In one failing `pnpm verify`, `relations · archmap` — the gate, spawning the
same binary over the same graph — reported `ok` four lines above R7's red. One run, one binary, one
graph, two spawns, one answer lost. Run alone, `node scripts/conformance-audit.mjs` is green and
`archmap check --stats` answers its count consistently; five isolated R7 runs were green 5/5. CI's
`conformance` job was green at both heads. The red reproduced only inside a FULL `verify`.

**Established since.** Two explanations had been offered. Resource starvation was withdrawn by the
person who offered it. The second — a collision between the two concurrent `archmap` invocations a
full `verify` makes — was the right one, and it is no longer a hypothesis: two concurrent
`archmap check --stats` over one checkout reproduce it deterministically, one answering with its
count and the other exiting 2 with `scope matched no files (.)`, while five sequential runs answer
5/5. It reproduces on an idle worktree with no changes in it, so it was never about any diff.

`scripts/verify.mjs` now lets a check declare an `exclusive` group and never runs two members of one
group at the same time; the `relations` check and the `conformance audit` both declare `archmap`.
Four consecutive `verify` runs at one commit agree where they used to alternate between exit 0 and
exit 2. What is NOT fixed is archmap itself: the binary is vendored under `.forge/archmap/` and
cannot be made concurrency-safe from this repo, so anything else that learns to spawn it must join
that group. The amnesty ends when archmap is safe to run twice at once in one checkout.

**What this leaves for the test.** The shortfall at the top of this document is untouched by any of
it: the ordering — count parsed before exit status — is still held down by a `cm:guard` and nothing
that fails. The value of the test went UP rather than down, because the honest `could not run` path
is now rare, and a reading bug in a path nobody exercises is a reading bug nobody finds. A harness
here should still plant the child's behaviour rather than race a real `archmap`; racing it is now a
test of `verify`'s pool, which is a different assertion in a different file.
