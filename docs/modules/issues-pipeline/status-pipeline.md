# Issue Status Pipeline

Issue lifecycle: 18 statuses, skill mapping, transitions. Per-project `pipelineConfig.auto*` gates auto-run.

## Statuses

Source of truth: [`packages/core/src/db/schema.ts`](../../../packages/core/src/db/schema.ts) (`issueStatuses`, 18 entries). Keep this table in lockstep.

| # | Status | Meaning | Set by |
|---|--------|---------|--------|
| 1 | `open` | New, untriaged | Issue created |
| 2 | `confirmed` | Triaged — clarify validates/reproduces next | forge-triage |
| 3 | `clarified` | Repro/UX validated (or auto-skipped), ready to plan | forge-clarify, or auto-skip |
| 4 | `waiting` | Plan written, awaiting human approval (gate) | forge-plan (Complex) |
| 5 | `approved` | Plan approved, ready to code | forge-plan (Simple/Medium) or human |
| 6 | `in_progress` | Being coded + built | forge-code start |
| 7 | `developed` | Code pushed, awaiting review | forge-code |
| 8 | `deploying` | Deploy in progress (reserved — projects with an external deploy step) | external deploy trigger |
| 9 | `testing` | Verify gate after review | forge-review (APPROVE) |
| 10 | `tested` | Verification passed (auto-advance step) | forge-test |
| 11 | `pass` | Auto-advance step toward release | forge-test |
| 12 | `staging` | Final gate before release (no-op / human in most projects) | forge-test |
| 13 | `released` | Cleared for release — triggers release note + close | forge-test |
| 14 | `closed` | Done / archived | forge-release or manual |
| 15 | `reopen` | Rejected, needs fix | Rejection at review/test |
| 16 | `on_hold` | Paused / blocked | Manual or infra failure |
| 17 | `needs_info` | Human-gated bounce: blocked on reporter clarification (no auto-dispatch) | forge-triage, forge-clarify, or manual |
| 18 | `draft` | AI-proposed issue awaiting human confirm (Dream / Doc-Sync schedules) | scheduled agent |

## Flow

Happy path driven by pipeline registry ([`packages/core/src/pipeline/registry.ts`](../../../packages/core/src/pipeline/registry.ts) → `PIPELINE_STEPS`) — the single place the status × jobType × toggle × skill mapping lives:

```
open ──forge-triage──▶ confirmed ──forge-clarify──▶ clarified ──forge-plan──▶ approved (S/M)
   │                       │ skipComplexities ▲  │                          └─▶ waiting ──human──▶ approved (Complex)
   │                       └─(xs/s auto-skip)──┘  └─(cannot reproduce)─▶ needs_info ──human──▶ confirmed
   └─(needs more info)─▶ needs_info ──human answers──▶ open/confirmed

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
Missing info (any stage)     ──▶ needs_info — human-gated bounce, no auto-dispatch
```

- **Clarify-on-happy-path**: `confirmed` dispatches forge-clarify (reproduce the bug
  in a live env / validate UX vs mockups, write a root-cause hypothesis) and exits to
  `clarified`, where forge-plan picks up. Cannot-reproduce/ambiguous → `needs_info`.
- **Complexity auto-skip**: a stage with `states.<stage>.skipComplexities` (e.g.
  `states.confirmed.skipComplexities: ["xs","s"]`) is treated as skippable by the
  soft-skip resolver for issues whose sized `complexity` matches — same chain and
  telemetry as disabled-stage skips, skip reason `complexity_skip` (breadcrumb +
  `pipeline_runs.metadata.skipChain`). Unsized issues never skip.
- Projects that don't want clarify: leave no skill registered at `confirmed`
  (missing-skill soft-skip) or set `states.confirmed.enabled: false`. The 0093
  migration backfilled `enabled: false` for every project without `autoClarify`.

- `waiting` and `staging` are human/no-op gates — no skill auto-runs there.
- `forge-test` auto-advances `tested → pass → staging → released` once its merge + live-verify gate passes (see Verification); those statuses are traversed automatically, not gated.

## Branching Model

- **baseBranch** (project config, e.g. `main`) — trunk issues merge into.
- ISS-* branch is cut from baseBranch by forge-code, kept alive across the pipeline (forge-fix fixes on it), merged into baseBranch at the verify gate.
- Branch config resolved per project via `forge_config` (`branchConfig.targetBranch`); skills never hard-code `main`. See [trunk-based-development.md](../../guides/trunk-based-development.md).

## Verification (forge-test merge + live gate)

`forge-test` runs at `status=testing` — last auto-dispatched stage before `released`. It is the **merge + live-verify gate**, not a local test run (pre-merge build/unit checks → forge-code; diff smoke → forge-review):

1. Resolve target branch from `forge_config` (`branchConfig.targetBranch`).
2. Merge reviewed ISS-* branch into target branch and push.
3. Deploy target branch to live beta (Coolify).
4. Run full Playwright E2E (`forge-verify-live`) against live beta.
5. **PASS** → auto-advance `tested → pass → staging → released`; forge-release writes release note + deletes branch + closes. **FAIL on live** → `reopen` + handoff (no revert). **Merge conflict** → halt at `testing` with a comment.

**No external CI / staging-VPS deploy path.** Legacy VPS staging deploy retired 2026-05-12; `forge-staging` is now a thin no-op kept only so the dispatcher does not error on a legacy `staging`-status job. See [`packages/core/skills/forge-staging/SKILL.md`](../../../packages/core/skills/forge-staging/SKILL.md) and [`packages/core/skills/forge-test/SKILL.md`](../../../packages/core/skills/forge-test/SKILL.md).

## What Happens Inside `in_progress`

forge-code (and forge-fix) run the full local cycle before pushing:

1. Implement changes per plan
2. Build — catch compile/type errors
3. Test affected packages if applicable
4. Tiered self/agent review
5. Fix review findings
6. Commit locally
7. Push ISS-* branch → exit at `developed`

Build and review happen **before** push. Independent fresh-context review (forge-review) then runs at `developed` before the verify gate.

## Orchestrator

Watches issue status changes, dispatches the matching skill. Mapping derived from `PIPELINE_STEPS` ([`packages/core/src/pipeline/registry.ts`](../../../packages/core/src/pipeline/registry.ts)); same payload served at `/api/pipeline/registry`.

### Skill mapping

| Status | Skill | Per-project toggle |
|--------|-------|--------------------|
| `open` | forge-triage | `autoTriage` |
| `confirmed` | forge-clarify | `autoClarify` |
| `clarified` | forge-plan | `autoPlan` |
| `approved` | forge-code | `autoCode` |
| `developed` | forge-review | `autoReview` |
| `testing` | forge-test | `autoTest` |
| `reopen` | forge-fix | `autoFix` |
| `released` | forge-release | `autoRelease` |

No-auto-dispatch statuses (`waiting`, `needs_info`, `deploying`, `tested`, `pass`, `staging`, `on_hold`, `draft`) are human gates or auto-advance steps `forge-test` walks through.

### Execution modes

Each step runs via one of:

- **desktop / device runner** (default) — agent session over WebSocket → device runs Claude CLI in a git worktree
- **antigravity** — server-side execution via the Antigravity service

### Concurrency

Device runners share one repo checkout per project → one agent per project at a time. Concurrent triggers queued (FIFO) with dedup on `issueId+status`.

### Reopen cycle protection

After repeated `reopen → fix` cycles for the same issue, auto-fix stops and the issue stays at `reopen` for human review. Manual triggers bypass this limit.

## Project pipeline configuration

Pipeline is opt-in per project via `agentConfig.pipelineConfig`. Each step toggle is either:

- a boolean (`true` = enabled, device runner, default model), or
- an object `{ enabled, runner, model }` for runner / model overrides per step.

Top-level `enabled: false` (default) disables all automation — every transition becomes manual. Individual `auto*` toggles opt out of specific steps (e.g. `autoTest: false` for human verification only). Zod schema in [`packages/core/src/pipeline/pipeline-config-schema.ts`](../../../packages/core/src/pipeline/pipeline-config-schema.ts) is source of truth.

## Pipeline skills summary

| Skill | Trigger status | Exit status | What it does |
|-------|---------------|-------------|--------------|
| **forge-triage** | `open` | `confirmed` / `needs_info` | Validate completeness, classify complexity, detect relations, set category/priority |
| **forge-clarify** | `confirmed` | `clarified` / `needs_info` | Reproduce bug / validate UX in live env, evidence + root-cause hypothesis |
| **forge-plan** | `clarified` | `approved` (S/M) / `waiting` (C) | Explore code, write implementation plan + QA scenarios |
| **forge-code** | `approved` | `developed` | Implement, build, tiered review, commit, push ISS-* branch |
| **forge-review** | `developed` | `testing` / `reopen` | Independent fresh-context code review + diff smoke |
| **forge-test** | `testing` | `released` (via tested/pass/staging) / `reopen` | Merge ISS-* + deploy beta + full live E2E gate |
| **forge-fix** | `reopen` | `developed` | Scoped fix on ISS-* branch |
| **forge-release** | `released` | `closed` | Append release note, delete branch, close |

## Removed statuses (historical)

Older revisions used additional statuses; no longer valid, must not appear in new code or fixtures.

| Old status | Replacement |
|-----------|-------------|
| `resolved` | `closed` |
| `in_review` | `developed` |
| `rejected` | `closed` + comment / label |
| `duplicate` | `closed` + label `duplicate` |
| `wontfix` | `closed` + label `wontfix` |
| `failed` | `reopen` (code) or `on_hold` (infra) |
