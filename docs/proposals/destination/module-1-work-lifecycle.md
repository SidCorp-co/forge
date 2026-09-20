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
| 4 | One lease per Intent, as a conditional write (`lifecycle.html` §5) | Real uniqueness: `jobs_active_unique (issue_id, type)` and `pipeline_runs_issue_open_uq (issue_id)`. The `NOT EXISTS` in `devices/admissible.ts` sits on top as an optimisation | **pass** |
| 5 | An attempt is the unit the harness counts (`lifecycle.html` §6) | No `attempt` column on `jobs` or `pipeline_runs`; it exists only on `runner_releases` and `release_attempts`. A retry is a new run naming nothing | missing |
| 6 | The ranking rule is stated (`lifecycle.html` §4) | `devices/admissible.ts` is `ORDER BY i.created_at ASC`. `priority` is selected, returned, never ordered on. The real ranking is in the master prompt — in `forge-plugin`, a different clock from the pool feeding it | divergence |
| 7 | A starvation bound across projects (`lifecycle.html` §8) | One query per project, each with its own `LIMIT`; no cross-project bound, no age override | missing (mild) |
| 8 | An Intent is versioned; a running attempt keeps its revision (`lifecycle.html` §2) | `issues` has no revision column. An edit overwrites and a live session is silently re-aimed | missing |
| 9 | Every kernel row carries a non-null project (`authority.html` §1) | Holds. Tables with no `project_id` are children cascading from a parent that has one. `usage_records.project_id` is nullable — billing, not kernel | **pass** |
| 10 | Five grants, not one `admin` bit (`authority.html` §2) | `projectMemberRoles` is `admin, member, viewer`, but `questions/write.ts:mayChoose` gates each option on its own `authority` and binds a permission to one call by fingerprint. Waiving a floor and forcing past a question have no grant because neither exists | partial pass |
| 11 | **Admission is a core write, with the policy version pinned** (`vision.html` §7) | `devices/admissible.ts` is a pure `SELECT`. No row records that an issue was admitted, when, to which box, or under which policy — so there is nowhere to stamp `policy_version`, which is the hook the whole three-clock rule hangs on | missing |
| 12 | **Core refuses, naming the predicate** (`vision.html` §7) | A held issue is silently absent from the response. A master cannot tell "nothing to do" from "five things blocked", and the repo's own *refused by name* doctrine is not applied to its own admission path | missing |
| 13 | **A box is reached through core admission, never a box-side pull** (`architecture.html` §9) | `GET /me/issues/admissible` (`devices/pool-routes.ts:80`) is exactly a box-side pull | conflict |

## What the thirteen collapse into

Five of them are one mechanism: **admission has no event.** It is a read the box initiates, it
writes nothing, and it names nothing it withheld. Give admission a row — box, predicate outcome,
`policy_version`, attempt number — and 5, 6, 11, 12 and 13 close together, while 1, 2 and 3 stop
being implicit behaviour and become predicate values somebody chose.

That is the module's deliverable, and it is one change, not thirteen.

**It does not need a fact plane built first.** `activity_log` is already the shape in embryo —
`actorType` (user | device), `actorAgency` (human | agent), `action`, `payload`, one clock, and a
redelivery dedupe key. What it lacks is the second clock, `policy_version`, a witness and
`supersedes`, and it is pinned to `issue_id NOT NULL` so it cannot carry a session- or
project-level fact. Extending it *is* the first slice of module 3, so the two overlap rather than
queue. `unaudited_transitions` exists because the repo already knows its state changes are not
uniformly audited.

## Owner decisions this module is blocked on

- **Does `dropped` release dependents?** Today it does, via edge expiry, and the two readers
  disagree about it. The set says it must not. Either answer is defensible; the current state —
  core and master differing — is not.
- **Does `closed` mean shipped?** If it keeps both meanings, `merged_at` is load-bearing for
  correctness and every reader must consult it. If it does not, the non-work exit needs its own
  terminal.
