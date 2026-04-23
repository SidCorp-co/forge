# Issue Status Pipeline

## Statuses (15)

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
| 11 | `released` | Approved for prod, triggers merge + deploy | Human confirms staging |
| 12 | `closed` | Done / archived | forge-release or manual |
| 13 | `reopen` | Rejected, needs fix | Rejection at any gate |
| 14 | `on_hold` | Paused / blocked | Manual or infra failure |
| 15 | `needs_info` | Blocked on clarification | Triage or manual |

## Pipeline Diagram

```
                         ┌──────────────────────────────────────────────────┐
                         │              HAPPY PATH                          │
                         │                                                  │
  ┌──────┐   forge-    ┌──────────┐  forge-  ┌─────────┐  human  ┌────────┐│
  │ open │──triage───▶│ confirmed │──plan──▶│ waiting │──────▶│approved││
  └──────┘            └──────────┘          │(Complex)│        └───┬────┘│
                                             └─────────┘            │     │
                                   Simple/Medium: auto-approve ─────┘     │
                                                                          │
                                              forge-code                  │
                                                   │                      │
                                            ┌──────▼──────┐               │
                                            │ in_progress │               │
                                            │             │               │
                                            │ 1. implement│               │
                                            │ 2. build    │               │
                                            │ 3. test     │               │
                                            │ 4. review   │               │
                                            │    (Simple/ │               │
                                            │     Medium) │               │
                                            │ 5. commit   │               │
                                            └──────┬──────┘               │
                                                   │                      │
                                    ┌──────────────┼──────────────┐       │
                                    │              │              │       │
                              Complex         Simple/Med     Simple      │
                              push ISS-*     push ISS-*    (staging URL) │
                                    │              │         merge to     │
                             ┌──────▼──────┐       │         baseBranch   │
                             │  developed  │       │              │       │
                             └──────┬──────┘       │              │       │
                                    │              │              │       │
                              forge-review         │              │       │
                                    │              │              │       │
                             ┌──────┴──────┐       │              │       │
                             │             │       │              │       │
                          pass          has bugs   │              │       │
                             │             │       │              │       │
                             │      ┌──────▼──┐    │              │       │
                             │      │ reopen  │    │              │       │
                             │      └─────────┘    │              │       │
                             │                     │              │       │
                      ┌──────▼──────┐              │              │       │
                      │  deploying  │◀─────────────┘              │       │
                      └──────┬──────┘                             │       │
                             │                                    │       │
                    ┌────────┴────────┐                            │       │
                    │                 │                            │       │
               CI passed         CI failed                        │       │
               deploy OK              │                           │       │
                    │           ┌─────▼─────┐                     │       │
                    │           │  reopen   │                     │       │
                    │           │(code fix) │                     │       │
                    │           └───────────┘                     │       │
                    │                                             │       │
               server deploy                                     │       │
                    │                                             │       │
             ┌──────┴──────┐                                      │       │
             │             │                                      │       │
          success     server fail                                 │       │
             │        (retry 1-2x)                                │       │
             │             │                                      │       │
             │      ┌──────▼──────┐                               │       │
             │      │   on_hold   │                               │       │
             │      │(infra issue)│                               │       │
             │      └─────────────┘                               │       │
             │                                                    │       │
      ┌──────▼──────┐◀───────────────────────────────────────────┘       │
      │   testing   │                                                     │
      └──────┬──────┘                                                     │
             │                                                            │
        forge-test                                                        │
             │                                                            │
      ┌──────▼──────┐                                                     │
      │   staging   │                                                     │
      └──────┬──────┘                                                     │
             │                                                            │
        human approve                                                     │
             │                                                            │
      ┌──────▼──────┐                                                     │
      │  released   │                                                     │
      └──────┬──────┘                                                     │
             │                                                            │
        forge-release                                                     │
        (squash merge ISS-*                                               │
         → productionBranch                                               │
         + Coolify deploy)                                                │
             │                                                            │
      ┌──────▼──────┐                                                     │
      │   closed    │                                                     │
      └─────────────┘                                                     │
                                                                          │
                   ┌──────────────────────────────────────────────────────┘
                   │  REJECTION (from review/test/staging)
                   │
            ┌──────▼──────┐    forge-fix    ─▶ back to developed (Complex)
            │    reopen   │                    or deploying (Simple/Medium)
            └─────────────┘

  EXCEPTIONS (from any active state):
  ┌───────────┐  ┌────────────┐
  │  on_hold  │  │ needs_info │
  └───────────┘  └────────────┘
```

## Pipeline Steps

1. **open** → forge-triage → **confirmed** (or **needs_info**)
2. **confirmed** → forge-plan → **approved** (Simple/Medium) or **waiting** (Complex, human gate)
3. **waiting** → human approve → **approved**
4. **approved** → forge-code → **in_progress** (implement + build + review + commit + push) → exit varies by complexity
5. **developed** → forge-review → **deploying** (pass) or **reopen** (has bugs) — Complex only
6. **deploying** → deploy success → **testing**
7. **testing** → forge-test → **staging** (pass) or **reopen** (fail)
9. **staging** → human approve → **released**
10. **released** → forge-release → squash merge ISS-* to productionBranch → Coolify deploy → **closed**

**Rejection** → **reopen** → forge-fix (on ISS-* branch, merge to baseBranch) → **developed** (Complex) or **deploying** (Simple/Medium)

## Branching Model

Two branches serve different environments:
- **baseBranch** (e.g. `develop`, `main`) — staging/testing environment. Issues merge here for QA.
- **productionBranch** (e.g. `master`) — production. Only forge-release merges here via squash merge.

```
ISS-* branch ──merge──▶ baseBranch (staging) ──▶ staging env for QA
                  │
                  └─── at released ──squash merge──▶ productionBranch (production)
```

**Key rule:** Never merge baseBranch → productionBranch directly. baseBranch may have commits from many issues. Each issue reaches production independently via its own ISS-* branch.

The ISS-* branch is kept alive through the entire pipeline. forge-code pushes it, forge-fix fixes on it, and forge-release squash-merges it to productionBranch at the end.

## Deploy Routing (forge-code exit)

How forge-code exits `in_progress` depends on project config and issue complexity. In all cases, the ISS-* branch is pushed and kept alive.

| Scenario | Action | Exit Status |
|----------|--------|-------------|
| **Simple / Medium** | Push ISS-*, merge to baseBranch → `forge_coolify_deploy` | `deploying` (auto-transitions to `testing`) |
| **Complex** | Push ISS-* feature branch | `developed` (triggers forge-review) |

Staging is the sole test environment. The `deploying` status auto-transitions to `testing` via the issue lifecycle hook.

## What Happens Inside `in_progress`

forge-code (and forge-fix) handle the full local development cycle before pushing:

```
in_progress:
  1. Implement changes (follow plan)
  2. Run build (`npm run build`) — catch compile/type errors
  3. Test API if applicable (curl affected endpoints)
  4. Code review (tiered by complexity):
     - Simple: self-review (read diff)
     - Medium: quick review agent (Bug-severity only)
     - Complex: full review agent + simplifier
  5. Fix any review findings
  6. Commit (local)
  7. Push → exit status depends on deploy routing (see above)
```

Build and review happen BEFORE push. Only clean, reviewed code gets pushed and deployed.

For **Complex** issues, an additional independent review (forge-review) happens after push at `developed` status, before the code reaches `deploying`.

## Deploy Failure Handling

Deploy has two failure modes with different causes and responses:

### CI Pipeline Failed (code problem)

GitLab webhook sends `status: 'failed'` with job info but no logs.
Fetch build logs via GitLab API: `GET /projects/:id/jobs/:job_id/trace`.

```
deploying → CI fails → reopen
                         │
                    forge-fix reads CI error from comment
                    fixes code (in_progress: build + review + push)
                    → deploying again
```

Post comment with:
- Which job failed (`build-web`, `build-api`)
- `failure_reason` from webhook (`script_failure`, etc.)
- Last N lines of CI job trace (fetched via GitLab API)

### Server Deploy Failed (infra problem)

Docker build/start/health check failed on deploy server.
Logs captured by the deploy service.

```
deploying → server fail → auto-retry (1-2x)
                              │
                         still fails → on_hold
                                        │
                                   human investigates
                                   fixes infra
                                   re-triggers deploy
```

Post comment with:
- Deploy step that failed (clone, build, start, health check)
- Docker compose logs (already captured, sanitized)
- Stuck recovery marks as `on_hold` after 15min timeout

| Failure | Cause | Status | Handler |
|---------|-------|--------|---------|
| CI pipeline failed | Code doesn't build | `reopen` | forge-fix |
| Server deploy failed | Infra issue | `on_hold` | Human/ops |
| Deploy stuck >15min | Unknown hang | `on_hold` | Human/ops |

## Pipeline Orchestrator

The orchestrator (`forge/core/src/pipeline/orchestrator.ts`) watches issue status changes and dispatches the appropriate skill.

### Skill Mapping

```
Status        → Skill          → Config Toggle
─────────────────────────────────────────────────
open          → forge-triage   → autoTriage
confirmed     → forge-plan     → autoPlan
approved      → forge-code     → autoCode
developed     → forge-review   → autoReview
testing       → forge-test     → autoTest
reopen        → forge-fix      → autoFix
released      → forge-release  → autoRelease
```

Human-gated statuses (`waiting`, `staging`) never trigger automated skills.

### Execution Modes

Each pipeline step can run via one of two runners:

| Runner | How it works |
|--------|-------------|
| **desktop** (default) | Creates agent session, sends to desktop device via WebSocket → Claude CLI |
| **antigravity** | Sends prompt to Antigravity service for server-side execution |

### Queue Management

Desktop runners share a single repo checkout per project, so only one agent runs per project at a time:

- If a step triggers while another is running → session created with status `queued`
- On session complete → next queued session promoted (FIFO)
- Deduplication: skip if same issue+status already queued

### Session Continuity

Pipeline steps try to resume existing Claude CLI sessions so context carries across steps (triage → plan → code → review → test → fix). Failed sessions are retried up to 5 times.

### Batching

Related issues (`related_to`) at the same status are batched into a single agent session:
- Avoids duplicate exploration
- Prevents merge conflicts on overlapping files
- Ensures all related changes are on one branch

### Reopen Cycle Protection

Tracks `reopen → fix → deploying` cycles per issue. After 5 cycles, auto-fix stops and the issue stays at `reopen` for human review. Manual triggers bypass this limit.

### Pikachu Shadow Evaluation

Pikachu runs alongside the pipeline as a shadow evaluator — it makes routing and rejection decisions independently and posts them as activity comments for comparison. Does NOT affect pipeline flow.

### Trigger Guards

- `open` from `needs_info` → don't re-triage (prevents loops when users answer questions)
- Manual triggers bypass `enabled` and per-step toggles (user explicitly requested)

## Project Pipeline Configuration

The automated pipeline is opt-in per project. Not all projects use automation — some are manual-only.

### Project-level config

Each project has `agentConfig.pipelineConfig` controlling which steps are automated:

```json
{
  "enabled": true,
  "autoTriage": true,
  "autoPlan": true,
  "autoCode": true,
  "autoReview": true,
  "autoTest": true,
  "autoFix": true,
  "autoRelease": true,
  "previewDeploy": {
    "repoUrl": "...",
    "stagingUrl": "...",
    "stagingApiUrl": "...",
    "testCredentials": [{ "label": "Admin", "username": "...", "password": "..." }]
  }
}
```

Each step toggle supports both boolean and object form:
- `true` — enabled, desktop runner
- `{ "enabled": true, "runner": "antigravity", "model": "..." }` — enabled with specific runner/model

### Behavior

- **`enabled: false`** (default) — no automation, all status transitions are manual
- **`enabled: true`** — orchestrator watches status changes and triggers the next skill
- Individual steps can be toggled off (e.g. `autoTest: false` = human does QA manually)
- **`waiting` and `staging` are always human gates** — no config to auto-approve
- `released` triggers forge-release (merge to production) when `autoRelease` is enabled

### Startup Recovery

On `forge/core` startup, `cleanupStaleSessions()` finds crashed "running" sessions and reverts their issues to the trigger status so they can be re-triggered.

## Pipeline Skills Summary

| Skill | Status Trigger | Exit Status | Agent Name | What It Does |
|-------|---------------|-------------|------------|-------------|
| **forge-triage** | `open` | `confirmed` / `needs_info` | — | Validate completeness, classify complexity (Simple/Medium/Complex), set category/priority |
| **forge-plan** | `confirmed` | `approved` (S/M) / `waiting` (C) | Alakazam | Explore codebase, write implementation plan with QA scenarios |
| **forge-code** | `approved` | `developed` / `deploying` / `testing` | — | Implement from plan, build, test, review (tiered), commit, push |
| **forge-review** | `developed` | `deploying` / `reopen` | Lapras | Independent code review with fresh context, check against project skills |
| **forge-test** | `testing` | `staging` / `reopen` | Forge QA | QA against staging — API + browser testing |
| **forge-fix** | `reopen` | `developed` (C) / `deploying` (S/M) | Blastoise | Scoped fix on ISS-* branch, merge to baseBranch |
| **forge-release** | `released` | `closed` | Dragonite | Squash merge ISS-* to productionBranch, Coolify deploy, cleanup |

## Removed Statuses (Historical)

| Old Status | Replacement |
|-----------|-------------|
| `resolved` | `closed` |
| `in_review` | `developed` (Complex) or removed (Simple/Medium — review inside `in_progress`) |
| `rejected` | `closed` + comment/label |
| `duplicate` | `closed` + label `duplicate` |
| `wontfix` | `closed` + label `wontfix` |
| `failed` | `reopen` (code) or `on_hold` (infra) |

