# PM Lane Live-Data Audit — ISS-796

**Audited:** 2026-08-08  
**Auditor:** forge-code pipeline (ISS-796), re-audited by forge-fix  
**Parent:** ISS-795 — Update Pipeline (canonical design)  
**Blocks:** ISS-795 step 5 (Master agent)

---

## Executive summary

The PM lane (`packages/core/src/pm/`) has **never produced a successful session** on this
project. Three PM jobs were queued in May 2026; all three failed. The infrastructure layer
(spawner guards, rate-limit, auto-disable, subscribers) works correctly and has good test
coverage. Auto-disable fired following the three failures; pmConfig has been disabled since.

**Corrected root cause:** The execution path (`handlePmDispatch` → `dispatchViaRunner(pm:true)`
→ runner) is **complete and functional** in current code. The failure is a **runner capability
gap**: `dispatchViaRunner` requires `{ pm: true }` in the runner's `capabilities` JSONB, but
production runners are initialized with `{}` by default — only dev-mode auto-grants `pm: true`.
No eligible runner existed, so `selectRunnerForJob` returned `null` on every attempt, the
dispatcher returned `'skipped'`, and the loop monitor eventually failed the queued jobs.

**Decision: (a) Repair** — grant `pm: true` to the production runner; no rebuild required.

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
reached `done` (step-duration rows = 0).

**Failure mode analysis (corrected vs. original):**

- **Jobs 1 & 2** (`"queued without dispatch (likely pg-boss desync after core restart)"`):
  The `"pg-boss desync"` wording is the loop monitor's default interpretation of a job that
  was never dispatched (no `dispatchedAt`). The actual cause: `handlePmDispatch` called
  `dispatchViaRunner(job, { pm: true }, ['claude-code'])`, which passed `requiredCapabilities
  = { pm: true }` to `selectRunnerForJob`. The SQL gate `AND capabilities @> '{"pm":true}'::jsonb`
  (`runners/select.ts:355`) found no matching runner (production runners default to `{}`),
  so the dispatcher returned `'skipped'` and the job stayed queued until the loop monitor
  reaped it. Not a pg-boss infrastructure failure.

- **Job 3** (`"unsupported job type or missing issueId (type=pm)"`): This error string does
  **not exist as a production emitter in current code** — it appears only in
  `packages/tests/web/features/pipeline/job-failure.test.ts` (for `type=test`). The
  presence of `dispatchedAt` and `agentSessionId` suggests a runner with `pm: true` was
  available at that moment (possibly a dev-mode runner or one manually configured), and the
  failure came from an older runner binary that explicitly rejected PM — a code path removed
  in current HEAD. This is a historical artifact, not a current failure mode.

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
notified the project creator. This is the expected three-strikes behavior. The underlying
cause was the runner capability gap (no runner with `pm: true` in production), not a
structural defect in the PM path itself.

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

The PM execution path is **complete and working** in current code. The three independent
verifications:

1. **PM is exempt from the runner type gate.** `dispatcher.ts:449`:
   ```ts
   if (job.type !== 'pm' && !runnerSupportsJobType(runner.type, job.type)) { … }
   ```
   PM jobs can never fail the `runner_unsupported_type` gate.

2. **`handlePmDispatch` is a live pg-boss worker.** Registered at `dispatcher.ts:807`
   (`PM_QUEUE_NAME`), it calls `dispatchViaRunner(job, { pm: true }, ['claude-code'])`
   (`dispatcher.ts:239`). The function is reachable and wired.

3. **The runner accepts null `issueId`.** `frames.rs:21` declares `issue_id: Option<String>`
   with `#[serde(default)]`. `dispatch.rs` creates a worktree only when `worktreeBranch`
   is present in the payload; a PM job (no worktreeBranch) runs in the repo root. There is
   no runner-side issueId validation.

**The real failure point is runner capability registration.** `dispatchViaRunner` passes
`forcedCapabilities = { pm: true }` to `selectRunnerForJob`. The selector queries:

```sql
AND capabilities @> '{"pm":true}'::jsonb
```

(`runners/select.ts:355`). Production runners are initialized with `capabilities = {}`
by default — `pm: true` is only auto-granted in dev-mode (`NODE_ENV !== 'production'`,
`select.ts:34-38`). No production runner has ever been explicitly configured with
`pm: true` on this project. Result: `selectRunnerForJob` returns `null`, the dispatcher
returns `'skipped'`, the job stays queued, and the loop monitor eventually fails it with the
generic "queued without dispatch" message.

The `pm: true` gate is an **intentional security design** (`dispatcher.ts:195-198`):
PM agents run project-scoped with broader authority than issue-scoped agents, so the
operator must opt-in per runner. The dev-mode auto-grant is convenience only. The
production opt-in step was never performed for this project's runner.

**Infrastructure layer (working, tested):**
- `spawnPmSession`: 4-guard chain (enabled → trigger-mask → rate-limit → dedup)
- `auto-disable`: three-strikes correctly fires and persists state
- `cadence.ts`: correctly polls enabled pmConfig rows with cron expressions
- `queue-pressure.ts`: correctly detects backlog > threshold
- `subscribers.ts`: correctly wired to hooks bus
- `escalation-sweeper.ts`: correctly registered on cron, correct SQL logic

**Execution layer (working in code, blocked by configuration):**
- `handlePmDispatch` → `dispatchViaRunner(pm:true)` → runner (all wired correctly)
- Runner accepts null issueId, runs in repo root (no Rust changes needed)
- Gap: no production runner has `capabilities.pm = true`

---

## Decision: (a) Repair

### Rationale

**The execution path does not need rebuilding.** The original audit dismissed option (a)
as requiring "Rust changes + a tagged release" — that was based on the incorrect premise
that the runner rejects PM jobs. In reality, `handlePmDispatch` already dispatches to
`claude-code` runners (`dispatch.ts:239`), and the runner's Rust code already accepts
null `issueId` and runs PM jobs in the repo root. No Rust change is required.

**Why not (b) full rebuild (discard packages/core/src/pm/)?**  
The infrastructure layer has good unit test coverage and correct semantics. `spawnPmSession`,
`auto-disable`, the subscriber wiring, the escalation-sweeper SQL — these are all working
code. Discarding them means rebuilding guards that already work and retesting coverage that
already exists. Full rebuild is wasteful.

**Why not (c) hybrid (keep infra, rebuild execution)?**  
The execution path already exists and is correct. Building an in-process core-side execution
path would duplicate the existing `handlePmDispatch` → runner path, adding complexity and
bypassing the intentional `capabilities.pm` security gate without good reason.

**Why (a) repair (grant capability)?**  
The only missing piece is `capabilities.pm = true` on the production runner. The fix is
a runner capability configuration change, available via `PATCH /api/runners/:id`. This
unblocks PM immediately with no code changes. The operator opt-in requirement is correct
(PM agents are project-scoped with broad authority); the gap was simply that it was never
performed.

ISS-795 step 5 should include: re-enable pmConfig and grant `pm: true` to the project's
bound runner before the Master agent is deployed. Optionally, the PM enable UI could
auto-prompt the operator to grant the capability when enabling PM.

This satisfies all §9 invariants unchanged:
- **serialize-per-project**: `jobs_pm_per_project_unique_idx` unchanged
- **rate-limit**: guard #3 in `spawnPmSession` unchanged
- **auto-disable**: three-strikes in `auto-disable.ts` unchanged
- **escalation**: sweeper unchanged (queries pmDecisions)
- **decision record**: PM agent writes via `forge_project_pm write_decision` unchanged

---

## Implications for step 5 (Master agent)

The Master agent (ISS-795 step 5) **should use the existing runner dispatch path**, not
build a new in-process execution path. Specifically:

1. The spawner/guards remain the entry point — no changes needed.
2. Before activating PM, ensure the bound runner has `capabilities.pm = true` (PATCH
   `/api/runners/:id`). Consider adding a preflight check or a UI prompt when enabling
   pmConfig to surface this requirement to the operator.
3. The PM agent session runs on the runner in the repo root (no worktreeBranch), using
   `promptString` from the job payload. The Master agent skill should be designed for this
   execution context: no worktree, project-level scope, `forge_project_pm` MCP tool for
   writing decisions.
4. Keep `pmDecisions` as the decision audit log — `write_decision` API unchanged.
5. Skills sync via `project_id` (not issue_id) — the PM agent can load PM-specific skills
   if they are registered on the project.

---

## References

- `packages/core/src/pm/spawner.ts` — 4-guard spawn entry point
- `packages/core/src/pm/auto-disable.ts` — three-strikes guard
- `packages/core/src/pm/cadence.ts` — cron-based tick
- `packages/core/src/pm/queue-pressure.ts` — backlog threshold sweep
- `packages/core/src/pm/subscribers.ts` — hooks bus wiring
- `packages/core/src/pm/escalation-sweeper.ts` — timeout fallback
- `packages/core/src/jobs/dispatcher.ts:200` — `handlePmDispatch` (live pg-boss worker)
- `packages/core/src/jobs/dispatcher.ts:449` — PM type-gate exemption
- `packages/core/src/runners/select.ts:34` — `defaultRunnerCapabilities` (dev-mode auto-grant)
- `packages/core/src/runners/select.ts:355` — JSONB capability containment filter
- `packages/runner/crates/forge-runner-core/src/transport/frames.rs:21` — `issue_id: Option<String>`
- `packages/core/src/db/schema.ts:2395` — `pmDecisions` table
- `packages/core/src/db/schema.ts:2426` — `pmConfig` table
- ISS-795 — parent issue (canonical pipeline design)
