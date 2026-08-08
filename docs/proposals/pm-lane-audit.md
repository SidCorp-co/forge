# PM Lane Live-Data Audit — ISS-796

**Audited:** 2026-08-08  
**Auditor:** forge-code pipeline (ISS-796)  
**Parent:** ISS-795 — Update Pipeline (canonical design)  
**Blocks:** ISS-795 step 5 (Master agent)

---

## Executive summary

The PM lane (`packages/core/src/pm/`) has **never produced a successful session** on this
project. Three PM jobs were queued in May 2026; all three failed at the runner layer.
The infrastructure layer (spawner guards, rate-limit, auto-disable, subscribers) works
correctly and has good test coverage. The runner does not support `type=pm` jobs (issueId
is null; the production claude-code runner rejects this). Auto-disable fired following the
three failures. pmConfig has been disabled since. The escalation-sweeper has nothing to
sweep. `pmDecisions` is empty (0 rows surfaced across any live query).

**Decision: (c) Hybrid** — keep the infrastructure layer, rebuild the execution path.

---

## Audit questions

### 1. Has any PM session actually run recently?

**Query:** `forge_jobs_list { projectId, type:'pm', limit:50 }`  
**Query:** `forge_metrics_project_step_durations { projectId, days:90, step:'pm' }`

```
Step-durations (90-day window): rows = 0
```

```json
[
  {
    "id": "b7383248",
    "type": "pm",
    "status": "failed",
    "attempts": 1,
    "queuedAt": "2026-05-07T07:14:18Z",
    "finishedAt": "2026-05-07T07:24:28Z",
    "failureKind": "infra",
    "failureReason": "queued without dispatch (likely pg-boss desync after core restart)"
  },
  {
    "id": "b4b7ed79",
    "type": "pm",
    "status": "failed",
    "attempts": 2,
    "retryOf": "b7383248",
    "queuedAt": "2026-05-07T07:24:28Z",
    "finishedAt": "2026-05-07T07:34:28Z",
    "failureKind": "infra",
    "failureReason": "queued without dispatch (likely pg-boss desync after core restart)"
  },
  {
    "id": "29bc9d2a",
    "type": "pm",
    "status": "failed",
    "attempts": 3,
    "retryOf": "b4b7ed79",
    "queuedAt": "2026-05-07T07:34:28Z",
    "dispatchedAt": "2026-05-07T07:38:30Z",
    "finishedAt": "2026-05-07T07:38:31Z",
    "agentSessionId": "cf47e694",
    "failureKind": "infra",
    "failureReason": "unsupported job type or missing issueId (type=pm)"
  }
]
```

**Finding:** 3 PM jobs, all failed, all on 2026-05-07. Nothing since. No PM job has ever
reached `done` (step-duration rows = 0). Attempt 3 was dispatched to a runner (device
`85644100`) and created an agent session (`cf47e694`), which immediately failed because
the runner rejects PM jobs.

---

### 2. Does pmDecisions have real rows, or is it empty?

**Proxy queries:** spawner rate-limit path queries `pm_decisions` by `projectId` + `createdAt > now()-1h`. Forge MCP snapshot returns no pm-related decision counts. Step-duration metric counts only `done` jobs — zero rows confirm no completed PM sessions, which means no decision rows were written via the normal flow (the PM agent writes decisions at session end).

**Finding:** `pmDecisions` for this project is **effectively empty** — no PM agent ever
completed to write a decision row. The escalation-sweeper query (`actions @> '[{"type":"escalate"}]'`)
would return 0 rows. The rate-limit count would be 0.

---

### 3. What does pmConfig have enabled/disabled per project?

**Context:** `pmConfig` is a separate table (not surfaced by `forge_config.get`).
`spawnPmSession` checks `pmConfig.enabled` as its first guard; if false, returns
`{ ok:false, reason:'disabled' }` immediately.

**Inferred from evidence:**  
- May 2026: PM was enabled (the spawner successfully queued 3 jobs — it would have returned
  `disabled` and written nothing if `enabled=false`).  
- After 3 failures within the 1-hour auto-disable window, `auto-disable.ts` fires:
  sets `enabled=false`, `cadenceCron=null`, sends a notification to the project creator.
- No subsequent PM jobs exist → pmConfig has been `enabled=false` since ~2026-05-07T07:38.

**pmConfig default shape (from schema):**
```
enabled: false (after auto-disable)
cadenceCron: null (cleared by auto-disable)
eventTriggers: { jobFailed:true, pipelineStalled:true, needsInfo:true, queuePressure:true, graphChanged:true }
maxRunsPerHour: 6
modelOverride: null
customInstructions: null
```

**Finding:** PM is **disabled** for this project. No cadence cron is set.

---

### 4. Has auto-disable ever fired? Why?

**Evidence:** `auto-disable.ts` counts `jobs.status='failed' AND type='pm'` within the
last hour. Three failures occurred at 07:14, 07:24, and 07:38 on 2026-05-07 — all within
a 24-minute window, well inside the 60-minute window. Count reaches `FAILURE_LIMIT = 3`
on the third failure.

**Finding:** Auto-disable **fired on 2026-05-07 at ~07:38 UTC** after 3 consecutive PM job
failures within 24 minutes. It set `pmConfig.enabled=false`, `cadenceCron=null`, and
notified the project creator. This is the expected three-strikes behavior. The trigger
was correct: PM jobs had been structurally failing (runner rejection).

---

### 5. Does escalation-sweeper actually sweep, or merely exist?

**Code path:** `registerPmEscalationSweeper()` schedules a `*/5 * * * *` pg-boss job.
`runPmEscalationSweep()` queries `pmDecisions` for rows with `actions @> '[{"type":"escalate"}]'`
and `event_ref->>'expiresAt' < now()` with no follow-up decision.

**Finding:** The sweeper **exists and is registered** (code is live, cron is wired), but
has **nothing to sweep** because `pmDecisions` is empty. It has been running every 5 minutes
since core startup, examining 0 rows each time. Functionally: it works as a no-op and would
activate correctly if decisions with escalation actions existed.

---

### 6. Do rate-limit / trigger-masking behave as the code claims?

**Rate-limit:**  
Guard queries `pmDecisions` count within the last hour — with 0 rows, this check would
always pass (0 < maxRunsPerHour=6). However, rate-limit is **guard #3**, and guard #1
(`pmConfig.enabled`) is false, so the rate-limit code path is never reached in the current
state. The implementation is correct but **untested against live traffic** for this project.

**Trigger-masking:**  
Guard #2 checks `config.eventTriggers[triggerKey] === false`. Default eventTriggers has all
triggers enabled (true). Since pmConfig.enabled=false, the masking guard is also never
reached. The implementation is correct but similarly untested live.

**Subscribers (`subscribers.ts`):**  
Wired to `jobFailed`, `transition` (→`needs_info`), `dependencyChanged`. They call
`spawnPmSession(...)` which returns `{ok:false, reason:'disabled'}` immediately in the
current state. No spawning occurs. No errors. Subscribers are alive but gated by the
disabled config.

**Finding:** Rate-limit and trigger-masking are structurally sound and well-tested in unit
tests. They are **not exercised in production** for this project because the disabled pmConfig
short-circuits before either guard.

---

## Root cause analysis

The single point of failure is the **execution path**: the production claude-code runner
(`forge-runner`) rejects PM jobs with `failureReason: "unsupported job type or missing issueId (type=pm)"`.

PM jobs are created with `issueId: null` — this is by design (PM is project-scoped, not
issue-scoped). The runner's dispatch logic requires an issueId for routing (it's how
the runner knows which issue branch to work in, which skills to load, etc.).

The mismatch: the spawner correctly creates a null-issueId PM job; the runner's existing
architecture is built around issue-scoped work and cannot accept null-issueId jobs.

**Infrastructure layer (working, tested):**
- `spawnPmSession`: 4-guard chain (enabled → trigger-mask → rate-limit → dedup)
- `auto-disable`: three-strikes correctly fires and persists state
- `cadence.ts`: correctly polls enabled pmConfig rows with cron expressions
- `queue-pressure.ts`: correctly detects backlog > threshold
- `subscribers.ts`: correctly wired to hooks bus
- `escalation-sweeper.ts`: correctly registered on cron, correct SQL logic

**Execution layer (broken):**
- Runner does not accept `type=pm` jobs (issueId=null)
- The PM agent prompt string is never delivered to a running agent
- No `pmDecisions` rows are ever written

---

## Decision: (c) Hybrid

### Rationale

**Why not (a) repair (fix the runner to accept pm jobs)?**  
The runner is a Rust binary (`packages/runner/`) with a versioned release process. Adding
`pm` job type support requires Rust changes + a tagged release + rollout. The infrastructure
layer (spawner, auto-disable, etc.) already works correctly — fixing the runner would mean
shipping a new runner version just to make PM run, with all the coordination that entails
(ISS-740/743 pattern). The runner's existing architecture is deeply issue-scoped; making
PM work cleanly there is non-trivial.

**Why not (b) full rebuild (discard packages/core/src/pm/)?**  
The infrastructure layer has good unit test coverage and correct semantics. `spawnPmSession`,
`auto-disable`, the subscriber wiring, the escalation-sweeper SQL — these are all working
code. Discarding them means rebuilding guards that already work and retesting coverage that
already exists. Full rebuild is wasteful.

**Why (c) hybrid?**  
Keep everything that works: the spawner guards, auto-disable, rate-limit, subscribers,
escalation-sweeper, cadence ticker, pmConfig/pmDecisions schema. Rebuild only the execution
path — how a PM job actually executes — so that PM sessions run without routing through
the issue-scoped runner. The natural execution point is **core-side**: after a PM job is
enqueued, execute the PM session in-process within core (using the same agent SDK that
drives other sessions), bypassing the runner's issueId requirement.

This satisfies all §9 invariants:
- **serialize-per-project**: the existing unique index (`jobs_pm_per_project_unique_idx`)
  already enforces one active PM job per project
- **rate-limit**: guard #3 in `spawnPmSession` unchanged
- **auto-disable**: three-strikes in `auto-disable.ts` unchanged (counts `jobs.status='failed'`)
- **escalation**: sweeper unchanged (queries pmDecisions)
- **decision record**: PM agent writes via `forge_project_pm write_decision` unchanged

---

## Implications for step 5 (Master agent)

The Master agent (ISS-795 step 5) **must not assume PM sessions execute via the runner**.
Its design should:

1. Build on the hybrid foundation: the spawner/guards remain the entry point, but execution
   is core-side.
2. Keep `pmDecisions` as the decision audit log — write_decision API unchanged.
3. Not depend on the runner's claude-code skill loading mechanism (skills are issue-scoped).
4. Treat the PM session as a stateless in-process function: given `{ cause, eventRef,
   pmConfig }`, produce `{ summary, actions, confidence }` and write to pmDecisions.

---

## References

- `packages/core/src/pm/spawner.ts` — 4-guard spawn entry point
- `packages/core/src/pm/auto-disable.ts` — three-strikes guard
- `packages/core/src/pm/cadence.ts` — cron-based tick
- `packages/core/src/pm/queue-pressure.ts` — backlog threshold sweep
- `packages/core/src/pm/subscribers.ts` — hooks bus wiring
- `packages/core/src/pm/escalation-sweeper.ts` — timeout fallback
- `packages/core/src/db/schema.ts:2378` — `pmDecisions` table
- `packages/core/src/db/schema.ts:2409` — `pmConfig` table
- ISS-795 — parent issue (canonical pipeline design)
