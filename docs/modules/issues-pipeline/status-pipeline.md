# Issue Status Pipeline

## Statuses

| # | Status | Meaning | Trigger |
|---|--------|---------|---------|
| 1 | `open` | New, untriaged | Issue created |
| 2 | `confirmed` | Triaged, needs plan | forge-triage |
| 3 | `waiting` | Plan written, awaiting human approval (Complex only) | forge-plan (Complex) |
| 4 | `approved` | Planned, ready to code | forge-plan (Simple/Medium) or human (Complex) |
| 5 | `in_progress` | Being coded + built | forge-code start |
| 6 | `developed` | Code pushed, awaiting review (Complex) or deploy (Simple/Medium) | forge-code push |
| 7 | `deploying` | Deploying to staging | forge-review pass, or forge-code push (Simple/Medium) |
| 8 | `testing` | QA against staging | Deploy success (auto-transitions from deploying) |
| 9 | `staging` | Human final check before release | forge-test pass |
| 10 | `released` | Approved for prod, triggers merge + deploy | Human confirms staging |
| 11 | `closed` | Done / archived | forge-release or manual |
| 12 | `reopen` | Rejected, needs fix | Rejection at any gate |
| 13 | `on_hold` | Paused / blocked | Manual or infra failure |
| 14 | `needs_info` | Blocked on clarification | Triage or manual |

## Flow

```
open ──forge-triage──▶ confirmed ──forge-plan──▶ approved (S/M)
                                                 └─▶ waiting ──human──▶ approved (Complex)

approved ──forge-code──▶ in_progress ──▶ developed (Complex)  ──forge-review──▶ deploying
                                       └▶ deploying  (Simple/Medium, auto)         │
                                                                                    ▼
                          deploying ──CI+deploy success──▶ testing ──forge-test──▶ staging
                                                                                    │
                                                       human approve ◀──────────────┘
                                                                │
                                                                ▼
                                                            released ──forge-release──▶ closed

Rejection at review/test/staging  ──▶ reopen ──forge-fix──▶ developed (Complex) or deploying (S/M)
Infra failure / unknown hang      ──▶ on_hold (manual)
Triage cannot proceed             ──▶ needs_info (manual)
```

`waiting` and `staging` are always human gates — no auto-approve.

## Branching Model

- **baseBranch** (e.g. `develop`, `main`) — staging environment. Issues merge here for QA.
- **productionBranch** (e.g. `master`) — production. Only forge-release merges here, via squash merge.

The ISS-* branch is kept alive across the whole pipeline. forge-code pushes it; forge-fix fixes on it; forge-release squash-merges it to productionBranch at the end.

**Never merge baseBranch → productionBranch directly** — baseBranch may carry commits from many issues. Each issue reaches production independently via its own ISS-* branch.

## Deploy Routing (forge-code exit)

How forge-code exits `in_progress` depends on issue complexity. The ISS-* branch is always pushed.

| Complexity | Action | Exit Status |
|------------|--------|-------------|
| Simple / Medium | Push ISS-*, merge to baseBranch → trigger deploy | `deploying` (auto-transitions to `testing`) |
| Complex | Push ISS-* feature branch only | `developed` (triggers forge-review) |

Staging is the sole automated test environment.

## What Happens Inside `in_progress`

forge-code (and forge-fix) run the full local cycle before pushing:

1. Implement changes per plan
2. Build (`npm run build`) — catch compile/type errors
3. Test affected endpoints if applicable
4. Tiered code review:
   - Simple: self-review (read diff)
   - Medium: quick review agent (Bug-severity only)
   - Complex: full review agent + simplifier
5. Fix review findings
6. Commit locally
7. Push — exit status per Deploy Routing above

Build and review happen **before** push. Only clean code reaches `deploying`.

For Complex issues, an additional independent review (forge-review) runs at `developed` before `deploying`.

## Deploy Failure Handling

Two failure modes with different responses:

### CI Pipeline Failed (code problem)

CI returns `status: 'failed'`. Build logs are fetched from the CI provider and posted as a comment. The orchestrator transitions to `reopen`; forge-fix reads the comment, fixes the code, re-pushes.

```
deploying → CI fails → reopen → forge-fix → deploying
```

### Server Deploy Failed (infra problem)

Docker build/start/health check failed on the deploy server. Auto-retry 1–2x; if still failing, transition to `on_hold` for human ops.

```
deploying → server fail → retry → on_hold (after retries exhausted or 15min hang)
```

| Failure | Cause | Status | Handler |
|---------|-------|--------|---------|
| CI pipeline failed | Code doesn't build | `reopen` | forge-fix |
| Server deploy failed | Infra issue | `on_hold` | Human / ops |
| Deploy stuck >15 min | Unknown hang | `on_hold` | Human / ops |

## Orchestrator

The orchestrator watches issue status changes and dispatches the matching skill. Source: `forge/core/src/pipeline/orchestrator.ts`.

### Skill mapping

| Status | Skill | Per-project toggle |
|--------|-------|--------------------|
| `open` | forge-triage | `autoTriage` |
| `confirmed` | forge-plan | `autoPlan` |
| `approved` | forge-code | `autoCode` |
| `developed` | forge-review | `autoReview` |
| `testing` | forge-test | `autoTest` |
| `reopen` | forge-fix | `autoFix` |
| `released` | forge-release | `autoRelease` |

Human-gated statuses (`waiting`, `staging`) never trigger automated skills.

### Execution modes

Each step runs through one of:

- **desktop** (default) — agent session over WebSocket → device runs Claude CLI in a git worktree
- **antigravity** — server-side execution via the Antigravity service

### Concurrency

Desktop runners share one repo checkout per project, so only one agent runs per project at a time. Concurrent triggers are queued (FIFO) with deduplication on `issueId+status`.

### Reopen cycle protection

After 5 `reopen → fix → deploying` cycles for the same issue, auto-fix stops and the issue stays at `reopen` for human review. Manual triggers bypass this limit.

## Project pipeline configuration

The automated pipeline is opt-in per project via `agentConfig.pipelineConfig`. Each step toggle is either:

- a boolean (`true` = enabled, desktop runner, default model), or
- an object `{ enabled, runner, model }` for runner / model overrides per step.

Top-level `enabled: false` (default) disables all automation — every status transition becomes manual. Individual `auto*` toggles let projects opt out of specific steps (e.g. `autoTest: false` for human QA only).

`previewDeploy` carries the staging URL + test credentials used by forge-test. Schema lives next to the orchestrator code; consult that as the source of truth.

## Pipeline skills summary

| Skill | Trigger status | Exit status | What it does |
|-------|---------------|-------------|--------------|
| **forge-triage** | `open` | `confirmed` / `needs_info` | Validate completeness, classify complexity, set category/priority |
| **forge-plan** | `confirmed` | `approved` (S/M) / `waiting` (C) | Explore code, write implementation plan + QA scenarios |
| **forge-code** | `approved` | `developed` / `deploying` | Implement, build, tiered review, commit, push |
| **forge-review** | `developed` | `deploying` / `reopen` | Independent fresh-context code review |
| **forge-test** | `testing` | `staging` / `reopen` | API + browser QA against staging |
| **forge-fix** | `reopen` | `developed` (C) / `deploying` (S/M) | Scoped fix on ISS-* branch |
| **forge-release** | `released` | `closed` | Squash merge ISS-* to productionBranch, trigger production deploy |

## Removed statuses (historical)

Older revisions of the pipeline used additional statuses; they are no longer valid and should not appear in new code or fixtures.

| Old status | Replacement |
|-----------|-------------|
| `resolved` | `closed` |
| `in_review` | `developed` (Complex) or removed entirely (Simple/Medium — review inside `in_progress`) |
| `rejected` | `closed` + comment / label |
| `duplicate` | `closed` + label `duplicate` |
| `wontfix` | `closed` + label `wontfix` |
| `failed` | `reopen` (code) or `on_hold` (infra) |
