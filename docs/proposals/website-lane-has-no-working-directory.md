# A `website` project's job has no working directory to run in

**Status:** found 2026-09-05 while working ISS-920, not fixed there. Reported rather than filed,
because the fix is a decision about what a repo-less job's cwd should be, and nothing in a
lock-scoping change can make it.

## What the code does

`requires_preflight` (`daemon/dispatch.rs`) exists so a `website` project — an Epodsystem
storefront whose deliverable is store content, not commits — never enters a git check. ISS-387
declared the kind, ISS-808 closed the `reconcile` half, and the guard on that function records that
the pipeline half was left out of scope on the premise that storefront projects "already do not"
run git-based stages. `mowment` received a `triage` job on 2026-08-14 and held on
`preflight_failed: origin_remote`, so the premise was already known to be false.

The half nobody has looked at is what happens *after* the preflight is skipped. Every claimed job
gets a worktree branch — `let worktree_branch = Some(ja.agent_name.clone())`, no fallback, by
design — so `git worktree add` runs for a `website` job too, in a folder that is not a checkout,
and the job dies. Before ISS-920 that happened inside `ClaudeCodeRunner::start` and surfaced as
`failed to start job: git worktree add failed: …`; ISS-920 moved the call into `dispatch::handle`
and kept the message byte-identical precisely so this pre-existing failure did not change shape
under it.

Two things follow that are worth writing down:

- The `preflight_failed:` namespace is a **box-quarantine** namespace. `classifyBoxFault` keys the
  runner-quarantine streak on that prefix and `maybeQuarantineRunner` takes a box off a project
  after three matching keys. So a repo-less lane must never be routed there for a fault that is
  about the project, not the box.
- `worktree_start_point` is computed only inside the `requires_preflight` block, so a lane that
  skips preflight would create its tree with no start point even if the tree were creatable.

## What the decision is

A repo-less job either has a working directory that is not a git worktree, or it is refused by
name. CLAUDE.md's rule is that the new path refuses the case it cannot serve rather than widening
a filter to swallow it — so the shape is probably an explicit `no working directory for a
repo-less project` failure, with its own cause, not a silent fall back to the repo path.

What it must not become is a `preflight_failed:` variant.

## Honest costs

| Cost | What it takes from whoever adopts this |
|---|---|
| A new failure cause | `FAILURE_CAUSES` exists twice on purpose (core and contracts, kept equal by `failure-causes-parity.test.ts`), plus `FAILURE_CAUSE_ORIGIN`, `FAILURE_CAUSE_PRESENTATION` and web-v2's `FAILURE_REASON_LABEL` — five places for one member. Reusing `runner_unsupported_type` avoids all five and says something less true. |
| A live storefront finds out first | No `website` project on the fleet has a pipeline anybody watches, so a job that dies fast today will start dying differently on a real store before any test sees it. |
| Isolation has to be decided, not deferred | "Run in the project folder" makes that folder a shared mutable working directory with no worktree and no root lock over it — the `repo_lock.rs` hazard arriving from a direction it does not cover. Refusing by name costs nothing and ships no storefront pipeline. The middle option is the one that costs later. |
