# Issue Status Pipeline

## Statuses

The status enum is the source of truth in
[`packages/core/src/db/schema.ts`](../../../packages/core/src/db/schema.ts)
(`issueStatuses`, 17 entries). Keep this table in lockstep with it.

| # | Status | Meaning | Set by |
|---|--------|---------|--------|
| 1 | `open` | New, untriaged | Issue created |
| 2 | `confirmed` | Triaged, ready to plan | forge-triage |
| 3 | `waiting` | Plan written, awaiting human approval (gate) | forge-plan (Complex) |
| 4 | `approved` | Plan approved, ready to code | forge-plan (Simple/Medium) or human |
| 5 | `in_progress` | Being coded + built | forge-code start |
| 6 | `developed` | Code pushed, awaiting review | forge-code |
| 7 | `deploying` | Deploy in progress (reserved — projects with an external deploy step) | external deploy trigger |
| 8 | `testing` | Verify gate after review | forge-review (APPROVE) |
| 9 | `tested` | Verification passed (auto-advance step) | forge-test |
| 10 | `pass` | Auto-advance step toward release | forge-test |
| 11 | `staging` | Final gate before release (no-op / human in most projects) | forge-test |
| 12 | `released` | Cleared for release — triggers release note + close | forge-test |
| 13 | `closed` | Done / archived | forge-release or manual |
| 14 | `reopen` | Rejected, needs fix | Rejection at review/test |
| 15 | `on_hold` | Paused / blocked | Manual or infra failure |
| 16 | `needs_info` | Blocked on clarification — triggers forge-clarify | forge-triage or manual |
| 17 | `draft` | AI-proposed issue awaiting human confirm (Dream / Doc-Sync schedules) | scheduled agent |

## Flow

The happy path is driven by the pipeline registry
([`packages/core/src/pipeline/registry.ts`](../../../packages/core/src/pipeline/registry.ts) →
`PIPELINE_STEPS`), the single place the status × jobType × toggle × skill
mapping is written down:

```
open ──forge-triage──▶ confirmed ──forge-plan──▶ approved (S/M)
   │                                            └─▶ waiting ──human──▶ approved (Complex)
   └─(needs more info)─▶ needs_info ──forge-clarify──▶ confirmed

approved ──forge-code──▶ in_progress ──▶ developed ──forge-review──▶ testing
                                                                       │ APPROVE
                                                                       ▼
                              forge-test:  merge ISS-*→target + deploy + live verify
                                                                       │
                              testing ─▶ tested ─▶ pass ─▶ staging ─▶ released
                                                                       │ forge-release
                                                                       ▼
                                                                     closed

Rejection at review/test  ──▶ reopen ──forge-fix──▶ developed
Infra failure / unknown hang ──▶ on_hold (manual)
Triage needs clarification   ──▶ needs_info ──forge-clarify──▶ confirmed
```

`waiting` and `staging` are human/no-op gates — no skill auto-runs there.
`forge-test` auto-advances the issue through `tested → pass → staging →
released` once its merge + live-verify gate passes (see Verification below),
so those statuses are traversed automatically rather than gated.

## Branching Model

- **baseBranch** (project config, e.g. `main`) — the trunk issues merge into.
- The ISS-* branch is cut from baseBranch by forge-code, kept alive across the
  whole pipeline (forge-fix fixes on it), and merged into baseBranch at the
  verify gate (see below).

Branch config is resolved per project via `forge_config` (`branchConfig.targetBranch`);
skills never hard-code `main`. See [trunk-based-development.md](../../guides/trunk-based-development.md).

## Verification (forge-test merge + live gate)

`forge-test` runs at `status=testing` — the last auto-dispatched stage before
`released`. In this repo it is the **merge + live-verify gate**, not a local
test run (pre-merge build/unit checks live in forge-code; the diff smoke lives
in forge-review):

1. Resolve the target branch from `forge_config` (`branchConfig.targetBranch`).
2. Merge the reviewed ISS-* branch into the target branch and push.
3. Deploy the target branch to the live beta (Coolify).
4. Run the full Playwright E2E (`forge-verify-live`) against the live beta.
5. **PASS** → auto-advance `tested → pass → staging → released`; forge-release
   then writes the release note + deletes the branch + closes.
   **FAIL on live** → `reopen` + handoff (no revert).
   **Merge conflict** → halt at `testing` with a comment.

There is **no external CI / staging-VPS deploy path**. The legacy VPS staging
deploy was retired on 2026-05-12; `forge-staging` is now a thin no-op kept only
so the dispatcher does not error on a legacy `staging`-status job. See
[`.claude/skills/forge-staging/SKILL.md`](../../../.claude/skills/forge-staging/SKILL.md)
and [`.claude/skills/forge-test/SKILL.md`](../../../.claude/skills/forge-test/SKILL.md).

## What Happens Inside `in_progress`

forge-code (and forge-fix) run the full local cycle before pushing:

1. Implement changes per plan
2. Build — catch compile/type errors
3. Test affected packages if applicable
4. Tiered self/agent review
5. Fix review findings
6. Commit locally
7. Push the ISS-* branch → exit at `developed`

Build and review happen **before** push. An independent fresh-context review
(forge-review) then runs at `developed` before the issue reaches the verify gate.

## Orchestrator

The orchestrator watches issue status changes and dispatches the matching skill.
The mapping is derived from `PIPELINE_STEPS`
([`packages/core/src/pipeline/registry.ts`](../../../packages/core/src/pipeline/registry.ts));
the same payload is served at `/api/pipeline/registry`.

### Skill mapping

| Status | Skill | Per-project toggle |
|--------|-------|--------------------|
| `open` | forge-triage | `autoTriage` |
| `needs_info` | forge-clarify | `autoClarify` |
| `confirmed` | forge-plan | `autoPlan` |
| `approved` | forge-code | `autoCode` |
| `developed` | forge-review | `autoReview` |
| `testing` | forge-test | `autoTest` |
| `reopen` | forge-fix | `autoFix` |
| `released` | forge-release | `autoRelease` |

Statuses with no auto-dispatch skill (`waiting`, `deploying`, `tested`, `pass`,
`staging`, `on_hold`, `draft`) are either human gates or auto-advance steps that
`forge-test` walks through.

### Execution modes

Each step runs through one of:

- **desktop / device runner** (default) — agent session over WebSocket → device
  runs Claude CLI in a git worktree
- **antigravity** — server-side execution via the Antigravity service

### Concurrency

Device runners share one repo checkout per project, so only one agent runs per
project at a time. Concurrent triggers are queued (FIFO) with deduplication on
`issueId+status`.

### Reopen cycle protection

After repeated `reopen → fix` cycles for the same issue, auto-fix stops and the
issue stays at `reopen` for human review. Manual triggers bypass this limit.

## Project pipeline configuration

The automated pipeline is opt-in per project via `agentConfig.pipelineConfig`.
Each step toggle is either:

- a boolean (`true` = enabled, device runner, default model), or
- an object `{ enabled, runner, model }` for runner / model overrides per step.

Top-level `enabled: false` (default) disables all automation — every status
transition becomes manual. Individual `auto*` toggles let projects opt out of
specific steps (e.g. `autoTest: false` for human verification only). The Zod
schema in
[`packages/core/src/pipeline/pipeline-config-schema.ts`](../../../packages/core/src/pipeline/pipeline-config-schema.ts)
is the source of truth.

## Pipeline skills summary

| Skill | Trigger status | Exit status | What it does |
|-------|---------------|-------------|--------------|
| **forge-triage** | `open` | `confirmed` / `needs_info` | Validate completeness, classify complexity, set category/priority |
| **forge-clarify** | `needs_info` | `confirmed` | Resolve missing info, then re-enter the plan path |
| **forge-plan** | `confirmed` | `approved` (S/M) / `waiting` (C) | Explore code, write implementation plan + QA scenarios |
| **forge-code** | `approved` | `developed` | Implement, build, tiered review, commit, push ISS-* branch |
| **forge-review** | `developed` | `testing` / `reopen` | Independent fresh-context code review + diff smoke |
| **forge-test** | `testing` | `released` (via tested/pass/staging) / `reopen` | Merge ISS-* + deploy beta + full live E2E gate |
| **forge-fix** | `reopen` | `developed` | Scoped fix on ISS-* branch |
| **forge-release** | `released` | `closed` | Append release note, delete branch, close |

## Removed statuses (historical)

Older revisions of the pipeline used additional statuses; they are no longer
valid and should not appear in new code or fixtures.

| Old status | Replacement |
|-----------|-------------|
| `resolved` | `closed` |
| `in_review` | `developed` |
| `rejected` | `closed` + comment / label |
| `duplicate` | `closed` + label `duplicate` |
| `wontfix` | `closed` + label `wontfix` |
| `failed` | `reopen` (code) or `on_hold` (infra) |
