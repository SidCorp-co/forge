# Control & Observability

**The dashboard is not where the work happens — it is the control plane.** Its job is: see →
understand → control → intervene.

```mermaid
flowchart LR
  EXEC([execution]) --> EV[(job_events<br/>streamed, 30-day prune)]
  EXEC --> AL[(activity_log<br/>durable audit)]
  EXEC --> UP[(uploads<br/>screenshots · artefacts)]
  EXEC --> UX[(ux_findings)]
  EXEC --> UR[(usage_records<br/>cost)]
  EV --> Q1[What is running?]
  AL --> Q2[What changed, and who?]
  EV --> Q3[What is blocked, and why?]
  UP --> Q4[What proves it?]
  Q1 & Q2 & Q3 & Q4 --> ACT[intervene:<br/>cancel · retry · nudge · answer]
```

## What it owns

| Concern | Where it lives |
|---|---|
| Live event stream, replay | `schema.ts:jobEvents`, `core/src/ws/` |
| Durable audit trail | `schema.ts:activityLog` |
| Evidence retention policy | `core/src/jobs/retention-sweeper.ts` |
| Attachments and artefacts | `core/src/uploads/`, `core/src/storage/` |
| UX contract findings | `schema.ts:uxFindings`, `schema.ts:uxContractRules` |
| Metrics and analytics | `core/src/metrics/`, `core/src/pipeline/analytics-routes.ts` |
| Cost and usage | `core/src/usage-records/` |
| Telemetry helpers, secret scrubber | `packages/observability` |
| Operator-facing feedback loops | `core/src/feedback/`, `core/src/improvement-messages/` |
| Instance administration | `core/src/admin/` |
| UI | web `features/overview/`, `operator/`, `project-dashboard/`, `recent-changes/`, `usage/`, `whats-new/`, `activity/` |

## The retention split

| Surface | Lives | Use it for |
|---|---|---|
| `job_events` | pruned 30 days after the job goes terminal | what a run did, moment by moment |
| `activity_log` | durable | who changed what, and when |
| `uploads` | durable | evidence a human or agent must be able to re-open later |

Anything that must outlive 30 days does **not** belong in the event stream.

## The interventions metric, defined by the event and not by the recorder

The north star is **interventions per issue closed**, and the thing counted is *a human hand
entering a run that was supposed to proceed without one*. That sentence is the definition. It is
written this way on purpose, because ISS-452 originally defined the metric as *"wedge events plus
audited manual cancels"* — by its own instrument — and a metric defined as what its recorder
recorded cannot undercount by construction. Manual SQL was therefore never missing from the number;
it was outside the definition. It is inside it now, and the instrument was widened to reach it
(ISS-884).

`issue_intervention_events` is that instrument. Four arms, one row per event, per project and per
issue:

| Arm | Event it counts | Written by |
|---|---|---|
| `wedge` | a hop stopped progressing and a human was told | `notifications` type `pipeline_wedge` |
| `manual_<action>` | someone cancelled, resumed, answered or injected through an audited surface | `job_events` kind `intervention` |
| `user_run_flip` | someone flipped a run terminal | `kernel_transitions`, `entity='run'`, `actor_type='user'` |
| `direct_sql` | someone flipped a job or run terminal **by hand, outside the app** | the `forge_detect_unaudited_transition` trigger |

The fourth arm counts what the first three cannot see. `applyKernelTransition`
(`lifecycle/transition.ts`) stamps `forge.kernel_txn` inside the transaction that performs a
terminal flip; a terminal flip on `jobs` or `pipeline_runs` arriving without that stamp did not come
from this application, and the trigger records it with the database role, the client's
`application_name` and the two statuses.

**What it deliberately does not reach**, because reaching further would overcount rather than count:
`agent_sessions` (the runner's own `PATCH /:id` legitimately writes a session status directly), any
**non-terminal** flip (dispatch, claim, requeue and pause are ordinary code that stamps nothing), and
row deletion (retention sweeps delete jobs legitimately). A hand-written `failed`→`queued` re-dispatch
is therefore still uncounted, and that is a known edge of the ruler, not an oversight.

Manual SQL is **not blocked**. Sometimes it is the only way to free a stuck fleet. The work was to
make it countable.

## Guards

- **A state transition without evidence is a kernel bug** (`VISION: state-never-lies`). Forge must
  always be able to distinguish what happened · what was verified · what failed · what may retry ·
  what needs human judgment.
- **Do not drive an intervention count to zero by stopping the surfacing of what needs one.** A
  single operating number is a number that can be gamed
  (`VISION: measured-together-never-apart`). The same rule forbids the quieter version: narrowing
  the metric's definition until the interventions it misses stop being interventions.
- **The secret scrubber is not optional on this path.** Telemetry carries agent output verbatim;
  `packages/observability` is where that is handled, and no surface here may bypass it.

## Boundaries

*Which human* an intervention should reach is [human-routing](../human-routing/). This domain makes
the state visible and the intervention possible; it does not decide who acts.
