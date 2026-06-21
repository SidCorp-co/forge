# Decompose execution (runtime: code / test / release)

Shared reference for how the **execution** stages handle an issue that is part of a
decomposed epic. The plan-time "how to split an epic" mechanics live in
`decompose-protocol.md`; this file is what forge-code / forge-test / forge-release
do when they pick up a child or the parent. Each of those skills points here instead
of inlining the rules, so the model lives in ONE place.

## The model (recap)

A decomposed epic shares ONE integration branch (`feature/ISS-<parent>`), created and
pushed by core (ISS-138) on the first `decomposes` edge. Children branch **off** that
branch and merge **back into** it; the base branch only ever sees the finished epic,
which **only the parent** squash-merges in — once, after verifying the assembled result.
There is therefore **no "is child X an ancestor of base?" check anywhere** — that guess,
run while a child's merge was still propagating, is the ISS-144 false-negative.

## Detect your role (read `metadata` from `forge_issues → get`)

- **Decompose child** — `metadata.branchConfig.baseBranch` points at a `feature/ISS-*`
  branch (and a `decomposes` parent / `metadata.integrationParent` is present).
- **Decompose parent / integration step** — `metadata.useIntegrationBranch === true`
  (and `metadata.integrationBranch` names the shared branch).
- **Neither** — no such metadata → ordinary issue, ignore this file entirely.

Trust `child.merged_at` as the readiness signal. Git is only the confirmation: **if a
child looks missing, `git fetch` and retry before concluding** — never declare a child
unmerged (or the epic incomplete) from a single stale fetch.

## Child execution

A child is a normal slice EXCEPT for which branch it lives on:

- **forge-code** — in the branch step use `<effectiveBase> = metadata.branchConfig.baseBranch`
  (the integration branch), not the project `baseBranch`. Build / test / review / simplify /
  commit are unchanged. Push the `ISS-*` branch.
- **forge-test** — the child is **not deployed individually** (the integration branch has no
  preview of its own). Don't try to walk acceptance criteria against a non-existent preview;
  the child's build + independent review validated its slice, and the full end-to-end QA runs
  once on the parent. Post a short "decompose child — verified via build+review; e2e deferred
  to parent integration" note; don't FAIL a child merely for lacking a preview.
- **Merge target (wherever this project performs the merge — forge-code in merge-on-code
  projects, forge-test/forge-release in merge-later projects):** the integration branch
  (`metadata.branchConfig.targetBranch`), stamped `mark_merged target:'feature'`.
  **Never** merge a child to `baseBranch`/`productionBranch`, and **never** deploy a child.
- **forge-release** — the child already landed on the integration branch; it must NOT merge
  to production. Skip the merge steps; append its CHANGELOG entry if present, optionally delete
  its own `ISS-*` branch (NOT the integration branch), comment ("folded into epic <parent>;
  promotion happens on the parent"), and close.

## Parent execution (the integration step)

The `decomposeChildrenPending` gate held the parent until every child landed on the
integration branch. Now the parent integrates and is the single promotion point:

- **forge-code** — do NOT write feature code. `git fetch <remote>`, check out the integration
  branch (`metadata.integrationBranch`), then **verify the branch you own** (never a
  base-ancestry guess). Refresh it against the project `baseBranch` (`git merge <remote>/<baseBranch>`
  — merge, don't rebase) to surface base drift; resolve conflicts. Run the cross-component build
  + the parent plan's integration scenario over the combined result; fix only integration glue
  (don't re-implement a child's slice). Do NOT squash to base and do NOT deploy here. End at
  `developed` so review + the parent's promote step follow.
- **forge-test** — QA the full assembled epic flow (the parent plan's integration scenario)
  against the deployed integration result. This is where the epic gets its real end-to-end QA.
- **forge-release (or whichever step promotes in this project)** — the parent is the ONLY
  issue that reaches base/production. Squash-merge the **integration branch**
  (`metadata.integrationBranch`) → `productionBranch` (substitute the integration branch for the
  `ISS-*` branch in the normal merge steps; `git fetch` + retry if a child looks missing),
  deploy, append CHANGELOG, **delete the integration branch** (`git push <remote> --delete
  <integrationBranch>`), then close the parent AND cascade-close any still-open children.
