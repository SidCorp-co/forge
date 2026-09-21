# Module 1 — work lifecycle, audited against the destination set

Intent · order · lease · attempt · terminal. Read on `main` at `fd25e0bcd` across
`packages/core/src/{issues,devices,pipeline,jobs}` and the migrations. Thirteen claims, every
page in the set that touches the module. Nothing here is fixed.

## Findings

| # | Claim, and where the set states it | What the code does | Verdict |
|---|---|---|---|
| 1 | A cancelled blocker does not release (`lifecycle.html` §3, §7) | `issues/drop-cascade.ts` expires a dropped issue's outgoing `blocks` edges; `issues/drop-unblock.ts` comments on each dependent asking a human to re-point. The master ignores `valid_until` (forge-plugin ISS-347), so core releases and the master does not | conflict |
| 2 | `done` and `cancelled` never collapse (`lifecycle.html` §1) | `issueStatuses` has `closed` and `dropped`; `closed` is both the shipped terminal and where a non-work issue goes (`closed` + `unmark`). Only `merged_at` separates them | conflict |
| 3 | Only `done` releases an edge (`lifecycle.html` §3) | `BLOCKER_SETTLED_STATUSES` = `developed, testing, awaiting_release, closed` — a dependent starts four rungs before its blocker ships | deliberate divergence |
| 4 | One lease per Intent, as a conditional write (`lifecycle.html` §5) | Split verdict. **Jobs**: real uniqueness, `jobs_active_unique (issue_id, type)` and `pipeline_runs_issue_open_uq`. **The thing named a lease**: `isIssueLeaseHeld` derives held-ness from `pipeline_runs.metadata->'runIssues'` — a JSONB array — **filtered on the asking device**, with no acquisition endpoint, no uniqueness, and a read-modify-write release | jobs **pass** · lease **fail** |
| 5 | An attempt is the unit the harness counts (`lifecycle.html` §6) | Modelled on two axes: `jobs.attempts` with a cycle-guarded `jobs.retryOf` chain (`jobs/prior-attempts.ts` walks it and refuses to inherit prior sessions — what §6 asks for), and `issue_step_contexts.attempt` unique per `(issue, step, attempt)` | **pass** |
| 6 | The ranking rule is stated (`lifecycle.html` §4) | Stated, and deliberately elsewhere: `devices/pool.ts` opens *"The pool applies no ordering policy and no dependency gate… the master answers what to run."* The rule lives in the master prompt, in `forge-plugin`, a different clock from the pool feeding it | deliberate divergence |
| 7 | A starvation bound across projects (`lifecycle.html` §8) | One query per project, each with its own `LIMIT`; no cross-project bound, no age override | missing (mild) |
| 8 | An Intent is versioned; a running attempt keeps its revision (`lifecycle.html` §2) | `issues` has no revision column. An edit overwrites and a live session is silently re-aimed | missing |
| 9 | Every kernel row carries a non-null project (`authority.html` §1) | Holds. Tables with no `project_id` are children cascading from a parent that has one | **pass** |
| 10 | Five grants, not one `admin` bit (`authority.html` §2) | `projectMemberRoles` is coarse, but `questions/write.ts:mayChoose` gates each option on its own `authority` and binds a permission to one call by fingerprint | partial pass |
| 11 | Admission is a core write with the policy version pinned (`vision.html` §7) | The audited-event plane **exists and is stronger than the set assumed**: `lifecycle/transition.ts` is a single chokepoint that CAS-writes the status and inserts a `kernel_transitions` row (entity, from, to, reason, actor type/agency/id, source) in the same transaction, and stamps `forge.kernel_txn` so a **database trigger** files any bypassing write into `unaudited_transitions`. What it does not cover is admission, because nothing flips — and issues, see row 14 | partial pass |
| 12 | Core refuses, naming the predicate (`vision.html` §7) | Implemented for runner admission — `devices/pool-admission.ts:runnerAdmission` returns `runner_withdrawn` / `device_disabled` / `runner_unbound` with the doctrine written above it. Not implemented for issue admission, where a withheld row is simply absent | partial pass |
| 13 | A box is reached through core admission, never a box-side pull (`architecture.html` §9) | `prepare` and `start` are core writes at claim time (`devices/claim.ts`), so a box cannot help itself. The pull is for candidates only | **pass** |
| 14 | *(not a claim in the set — found by reading)* | Triggers `trg_*_unaudited_transition` and `trg_*_unaudited_deletion` cover `jobs`, `pipeline_runs`, `agent_sessions`. **`issues` has no audit trigger and no `kernel_transitions` row**; `issues/apply-transition.ts` records a transition by writing a comment | **the finding of this module** |

## Retraction ledger — what the first pass got wrong

| Claimed in pass 1 | Actually |
|---|---|
| No `attempt` column anywhere on the work path | `jobs.attempts` (migration 0007) plus a `retryOf` chain, and `issue_step_contexts.attempt`. Pass-1 grep was truncated by `head` and I reported the truncation as the result |
| `approve_rate` / `pass_rate` measure n=0 because attempts are not modelled | The column exists and `pipeline/issue-context-store.ts:writeIssueContext` extracts the verdict from a review or test handoff. The series is empty because the **handoff itself is deliberately best-effort** — never a status gate. A measurement plane fed by an artifact the system on purpose does not require will read zero forever, and no schema change fixes that |
| Core never refuses by name | It does, for runner admission, with the doctrine stated in the source |
| Admission writes nothing, so there is nowhere to stamp `policy_version` | There is an audited-transition plane with database-level bypass detection. It does not reach admission, which is a narrower and different gap |
| The box pulls work | The box pulls *candidates*; taking one is a core write |

## The finding this module turns on

**Forge audits its derivatives and not its source.** `jobs`, `pipeline_runs` and `agent_sessions`
— the three the set calls projections rather than primitives — each have a single transition
writer, an append-only audit row written in the same transaction, and a database trigger that
files any write which bypassed it. `issues` — the Intent, the origin of everything downstream —
has none of the three. Its transitions are recorded as prose in a comment.

Every claim the set makes about provenance back to Intent terminates at the one entity with no
provenance of its own.

## Ordered deliverables

1. **Bring `issues` under the kernel transition plane.** Same chokepoint, same `kernel_transitions`
   row, same trigger. This is the module, and the rest are small beside it.
2. ~~**One held-predicate.**~~ **Done, ISS-1109.** Four call sites answered "is this issue being
   worked" with three different SQL shapes — `devices/admissible.ts` and
   `pipeline/issue-run-invariant.ts` (identical, project-scoped), `devices/pool.ts` (job-level,
   excludes `queued`), and `isIssueLeaseHeld` (device-scoped, and the only one named for the
   lease). The first two and the fourth now call `issues/issue-lease.ts`. `devices/pool.ts` was
   deliberately left: its predicate is over `jobs` for one issue, a different subject, and ISS-1110
   removes the route.
3. ~~**A real lease**, replacing the JSONB array with something a constraint can refuse.~~
   **Done, ISS-1109.** `issue_leases`, primary key `(project_id, issue_key)`, taken by
   `INSERT ... ON CONFLICT DO NOTHING` inside the transaction that opens the run session.
   `runIssues` stays as the run's membership record and says nothing about who holds what.
4. ~~**Address a lease by its project, not by its key alone.**~~ **Done, ISS-1139.** The route,
   `transport/run_sessions.rs:release_lease` and the close loop all carry the project now.
   `releaseIssueLeaseRow` deletes on `(project_id, issue_key)` with `device_id` narrowing it,
   `readDeviceIssueLease` takes the project the caller named, and `resolveLeaseKey` is the one
   place the prefixed key the pool hands out becomes the canonical one the store holds. A release
   that matched no row answers `404` and one this box holds in two projects answers `409` naming
   both, rather than either being acknowledged as done.
5. **Issue revision**, so a live attempt is not silently re-aimed.
6. **Delete `POST /me/pool/claim`** — a live endpoint whose whole body returns
   `{ ok: false, reason: 'runner_too_old' }`, false for most callers, superseded by `prepare`.

## Owner decisions this module is blocked on

- **Does `dropped` release dependents?** Today it does, via edge expiry, and core and the master
  disagree about it. Either answer is defensible; the disagreement is not.
- **Does `closed` mean shipped?** If it keeps both meanings, `merged_at` is load-bearing for
  correctness and every reader must consult it. If not, the non-work exit needs its own terminal.
- **Is the review/test handoff to become mandatory?** If it stays best-effort, `approve_rate` and
  `pass_rate` should be deleted rather than displayed as zero.

## Read so far

`devices/{pool,pool-admission,pool-routes,admissible,claim,run-session}.ts` ·
`pipeline/{issue-run-invariant,issue-context-store}.ts` · `jobs/{prior-attempts,finalize-done}.ts` ·
`lifecycle/transition.ts` · `db/{schema,kernel-marker}.ts` · migrations 0007, 0009, 0054, 0217, 0219.

Not yet read: the order cluster (`issues/dependency-*`, `relations-service`, `cycle-detect`),
the retry cluster (`jobs/retry`, `queue-hop`, `resume-policy`), and the terminal cluster
(`issues/apply-transition` 540 lines, `pipeline/runs-cascade`, `runs-concluded`, `merge-marker`).

## Honest costs

| Cost | What it buys, and who pays |
|---|---|
| The transition chokepoint is the busiest write path | Every status move — pipeline, MCP, REST, CLI, sweeper — routes through one function and grows an audit row plus a trigger. Getting it wrong stalls every issue in the fleet, not one |
| One held-predicate changes answers callers may depend on | `isIssueLeaseHeld` was device-scoped; fleet-wide was the fix, and this audit did not enumerate the callers relying on "held only by me". ISS-1109 did: one, the runner's own close loop, through `daemon/recovery_ports.rs:is_returned`. It reads `heldByThisDevice` now, which is the question it was always asking |
| This document rots | Every row cites a file read on one day. Left a quarter, it will cite code that moved, and be wrong in the direction that flatters the tree |
| Two rows are owner decisions | Until they are answered the module cannot close — not because the work is unclear, but because either answer is defensible and choosing one silently settles a product question |
