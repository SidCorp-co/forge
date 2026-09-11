# ISS-587 — walk the epic's own ladder against the deployed instance

This epic's five bullets are built and merged under its children; what it has never had is a walk
of its own. The deliverable is the walk and the verdict, not a build.

## Files touched

None in this repository, unless the walk finds a defect. A defect the walk turns up is fixed in
this issue, named under `Extra fixes:`, and the file list written into a correction at that moment
rather than guessed here.

The walk does write to the deployed instance, and that is the point of it: a criterion about a
refusal cannot be judged by reading. Those writes are named in Steps and each is reverted or kept
deliberately, said per step.

## Before

ISS-587 sits at `confirmed` with a merge mark from PR #282 (`26a547ea`) and no plan, no criteria
and no verdict. Every child is closed and merged: ISS-586 (Tier 1), ISS-588 (Tier 2) with its
593/594/595, ISS-947 (slug and the knowledge-node binding), ISS-948/949/950/951 (Tier 3 under
ISS-589) and ISS-952 (the anhome migration). The 2026-09-07 park was BLOCKED-FIXTURE on
`release-gate` condition 4 — forge-beta was then serving a process older than the merge.

## After

The epic carries twenty-six numbered criteria, each with a typed verdict citing what was read off
or written to the deployed instance, and the epic is `closed` on a PASS — or parked at
`needs_info` naming the criterion that failed.

## Deliberately unchanged

The epic body. Every claim in it was checked by the 2026-09-06 session and held. The tier table is
out of date only in the sense that the work is now done, which the close records; rewriting a body
to say "done" duplicates the status.

The children. All fourteen are closed and each carries its own record; this run re-judges none of
them and re-opens none of them.

`docs/flows/`. ISS-950 settled that this epic does not generate into it, and that reading stands.

## Verified in code

Two reads make this walk possible and both were taken in the source before it was planned.

`packages/core/src/labels/routes.ts` — the `PATCH /api/labels/:id` handler carries
`cm:guard the slug moves on exactly two edits and never on a rename`, and derives `slug` only on a
promotion or a demotion. So criterion 8 is a live rename, not a code reading, and it already
answered: renaming the probe module to `walk-probe-RENAMED` left `slug: walk-probe-delete-me`.

`packages/core/src/pipeline/issue-context-store.ts:135` — `isPassingTestHandoff(payload)` is what
calls `refreshModuleKnowledgeForIssue`. The refresh is therefore reachable from here by writing a
passing-test handoff, which is what makes criteria 11-13 an exercise rather than an inference.

## Conventions reversed

None.

## Declarations

- screen change: no
- schema coupling: no
- deploy coupling: no
- user-facing outcome: no

## Steps

1. Seed a module fixture on forge-dev, which today declares no taxonomy at all: module rows with a
   parent, a description and a knowledge-node binding, sourced from the seven domains under
   `docs/modules/` that ISS-950 named as this repo's own taxonomy. Read every row back.
   criteria: 6, 7, 9
2. Rename a fixture module's display name through the deployed API, read it back, and compare the
   slug to the one captured before the rename. Restore the display name. criteria: 8
3. Bind a second module to a knowledge node the first already holds, and read the refusal code.
   criteria: 10
4. Attribute issues truthfully to the fixture: this epic and its closed children are module-axis
   work, so the attribution is true and is kept. Write a primary, read the issue back, then write
   two secondaries and read back again. criteria: 1, 5
5. Attribute an issue with a label that is not a module in the project, and read the refusal.
   criteria: 2
6. Send a second primary on an already-attributed issue, read the refusal, then read the issue
   back and compare its primary to the one captured before. criteria: 3, 4
7. Capture an attributed module's knowledge node, write a passing-test handoff for that issue, and
   compare the node after. criteria: 11
8. Capture every node, write a passing-test handoff for an issue carrying no module, and compare.
   Read the handoff's own response. criteria: 12, 13
9. Call the rollup on forge-dev with the fixture attributed and on anhome, and read primary against
   secondary, a zero-issue module's row, and the unattributed count. criteria: 14, 15, 16
10. Call each of the four diagram kinds and match each against a marker only this project's own
    module knowledge could produce — the seeded parent hierarchy for the mindmap, the module set
    for the context diagram, a named step string from a knowledge node for user-flow and swimlane,
    and a module left without a node for the render-anyway case. criteria: 17, 18, 19, 20, 21
11. Call drift on forge-dev where step 4 produced co-occurrence, and read the per-edge issue count
    and the `undeclared` set. Re-read the handoff written in step 7 and confirm its verdict.
    criteria: 22, 23, 25
12. Call drift on a project declaring no module graph and read the declaration state. criteria: 24
13. Read anhome for the retired convention: module labels carrying what the `**Module:**` comments
    used to. criteria: 26
14. Remove the fixture rows this walk created that carry no truth worth keeping, post the verdicts,
    the release note and the close. criteria: all

## The way back

Not owed by the declarations: neither schema nor deploy coupling. The walk's own writes have one
anyway, because they touch a live project.

Triggered by: a fixture row or attribution that should not persist, or any verdict being wrong
about one.

Steps: module rows created by step 1 are removed with `DELETE /api/labels/:id`, which the walk
calls in step 14 for every row it does not deliberately keep. Attributions written in step 4 are
cleared by re-sending the issue's label set without them. The rename in step 2 is restored inside
that step. The handoffs written in steps 7 and 8 are step contexts on closed issues and are removed
with `forge_step_handoff_delete`.

Who is told: the report on this issue names every row kept and every row removed, so the next
reader can check the fixture against what is there.
