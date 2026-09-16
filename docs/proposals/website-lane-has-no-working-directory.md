# A `website` project has no lane at all, and one decision has to be made before it can

**Status:** rewritten 2026-09-16 by ISS-1047. The 2026-09-05 version of this file described the
behaviour of `requires_preflight`, a function that has never existed in this repository. Everything
it concluded rested on that. What is below is measured, and the decision it asks for is still
nobody's.

## What the code actually does

`projects.kind` was added by ISS-387 (migration 0100, `text NOT NULL DEFAULT 'standard'`) to
declare an Epodsystem storefront — a project whose deliverable is store content, not commits, and
which therefore should never enter a git check. Since then:

- **Nothing has ever read it.** Core selected it into `GET /api/devices/me/runners`; the runner
  deserialised it into `MeRunner.kind`; the only code that touched that field was two of its own
  tests and one struct literal in `doctor.rs`. Four comments in two languages described a
  `requires_preflight` reading it and deciding whether to run the git preflight. No such function
  was ever written, in either crate, at any commit. ISS-1047 removed the wire field, the send and
  all four comments.
- **`daemon::preflight` was a `pub` module with no caller.** 186 lines, reached only by its own
  three tests. ISS-1047 deleted it. The `ls-remote` budget it held is now stated once, in
  `workspace/refresh.rs`.
- **The value is set, and it is inert.** Measured through `/me/runners` on 2026-09-16: of 28
  projects bound to this device, 27 read `standard` and one — `mowment` — reads `website`.
  Somebody declared that storefront after ISS-808 made the field patchable, and nothing has
  happened as a result, then or since.

So the 2026-09-05 claim that a `website` project "skips the preflight and then dies on
`git worktree add`" is wrong in its first half. No project skips anything. `mowment` received a
`triage` job on 2026-08-14 and held on `preflight_failed: origin_remote` — that is a real event and
it is the whole of the evidence, but the reason is that a repo-less project ran a git-based job,
not that a switch was consulted and answered.

## The decision this is here for

**Is `projects.kind` a shape Forge supports, or a column to drop?** It cannot be both, and it has
been neither for four months.

- **Dropping it** discards `mowment`'s declaration. Running the migration backwards restores
  `standard`, not `website`, so the drop is destructive by the classification this repo uses.
  `repoUrl IS NULL` does not recover it either: eleven of thirty-two projects have a null
  `repoUrl` and only one of them is the storefront, so the column carries information the other
  columns do not.
- **Keeping it and wiring it** means answering the question the 2026-09-05 note was right about
  even though its premise was wrong: **a repo-less job has no working directory**. Every claimed
  job gets a worktree branch — `let worktree_branch = Some(ja.agent_name.clone())`, no fallback,
  by design — so `git worktree add` runs in a folder that is not a checkout and the job dies.

Two things stay true from the original note and are worth keeping:

- The `preflight_failed:` namespace is a **box-quarantine** namespace. `classifyBoxFault` keys the
  runner-quarantine streak on that prefix and `maybeQuarantineRunner` takes a box off a project
  after three matching keys. A repo-less lane must never be routed there for a fault that is about
  the project, not the box.
- CLAUDE.md's rule is that a new path refuses the case it cannot serve rather than widening a
  filter to swallow it — so the shape is probably an explicit `no working directory for a repo-less
  project` failure with its own cause, not a silent fall back to the repo path.

## Honest costs

| Cost | What it takes from whoever adopts this |
|---|---|
| Dropping the column | One person's recorded intent, unrecoverably. It is one row, and it is the only row, which makes it cheap to ask about and dishonest to delete quietly. |
| A new failure cause | `FAILURE_CAUSES` exists twice on purpose (core and contracts, kept equal by `failure-causes-parity.test.ts`), plus `FAILURE_CAUSE_ORIGIN`, `FAILURE_CAUSE_PRESENTATION` and web-v2's `FAILURE_REASON_LABEL` — five places for one member. Reusing `runner_unsupported_type` avoids all five and says something less true. |
| A live storefront finds out first | No `website` project on the fleet has a pipeline anybody watches, so a job that dies fast today will start dying differently on a real store before any test sees it. |
| Isolation has to be decided, not deferred | "Run in the project folder" makes that folder a shared mutable working directory with no worktree and no root lock over it — the `repo_lock.rs` hazard arriving from a direction it does not cover. Refusing by name costs nothing and ships no storefront pipeline. The middle option is the one that costs later. |
| Doing nothing | What has happened for four months: a column an operator can set, an API that accepts it, and no behaviour behind either. The cost is that the next person to read `projects.kind` believes it does something, which is what produced the file this one replaces. |
