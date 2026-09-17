# R7's subprocess reading has no committed test

**Status: OPEN (2026-09-17). Needs a decision about `conformance-audit.mjs`'s execution model,
which is why no diff carried it — see "Why this is a proposal and not a commit".**

`conformance-audit.mjs:unresolvableEdges` is the only rule in the audit that RUNS anything, and on
2026-09-17 it was found wrong twice independently in the same hour: it reported `could not run` for
an `archmap` that had started, spoken and died, sending a reader to the regex above it rather than
to the machine that ran out of memory. ISS-1074 fixed it (`5745a31a1`) and ISS-1085 fixed it
separately; ISS-1074's landed first and is the one on the trunk. It is correct. This document is
about what neither fix left behind.

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
| The starvation that produced the false red is not fixed by any of this, and a green test suite here may read as if it were. | whoever next sees R7 red under load |

## One thing to know before picking a shape

The red that started this was **false**, and it is reproducible only under load: the audit's second
spawn was starved at load average 14/25/28 on 48 cores while `relations · archmap` in the same
verify run reported `ok, 2760 files` four lines above it. At load 6.6 the same tree is green. So a
test harness for this rule should plant the child's behaviour rather than race a real `archmap` —
and the starvation itself remains unhandled by either fix, since a child that is killed for
resources reports `could not run` correctly but says nothing about why a quiet box would not.
