# Step Handoffs

Per-step pipeline context: each state inherits the prior step's output without re-deriving from raw issue fields.

## Overview

- On advance (triage → plan → code → review → test → fix), each step's agent records a small schema-validated JSON "handoff" before terminating.
- Next step's prompt is seeded with prior handoffs under `## Prior step handoffs`; overlapping raw issue field is dropped to save tokens (triage handoff replaces raw `description`; plan handoff replaces raw `plan`).
- **Best-effort context, not a completion gate** — job stays `done` with or without a handoff; missing handoff → downstream falls back to raw issue field. (Proposal's hard `/complete` gate + `handoff_not_written` failure were *not* shipped — see "Not yet".)
- **Default-on system-wide** (since 2026-05-29). No opt-in; explicit per-state config still wins per field.

## Data Model

### `issue_step_contexts` table

Migration `packages/core/drizzle/migrations/0081_issue_step_contexts.sql`; schema `packages/core/src/db/schema.ts` (`issueStepContexts`). **Dedicated table** — handoffs do not live in `memories`/`memory_sources`.

| Column | Notes |
|--------|-------|
| `id` | uuid PK |
| `project_id` | FK → `projects` (cascade delete) |
| `issue_id` | FK → `issues` (cascade delete) |
| `pipeline_run_id` | FK → `pipeline_runs` (cascade delete) — ties a handoff to the run that produced it, so a cancelled/superseded run never leaks into a later run |
| `kind` | discriminator; v1 only writes `'handoff'` (`issueStepContextKinds`) |
| `step` | `triage` \| `plan` \| `code` \| `review` \| `test` \| `fix` |
| `attempt` | int, default 1 |
| `payload` | jsonb — validated by the per-step schema |
| `created_at` / `updated_at` | timestamps |

Indexes: partial unique on `(issue_id, step, attempt) WHERE kind='handoff'` (upsert key), plus `(issue_id, kind)` and `(pipeline_run_id)`.

`kind` is intentional headroom: future per-issue/per-run artifacts (blocker notes, retrospectives, cross-step decisions) reuse the table without a migration.

### Payload schema

`packages/core/src/memory/step-handoff-schema.ts` defines `stepHandoffSchema`, a Zod discriminated union on `step`; each branch carries `schema_version: 1` plus bounded fields:

| Step | Key fields |
|------|------------|
| `triage` | `summary`, `suggestedApproach`, `complexity` (xs–xl), `risks[≤5]`, `affectedAreas[≤10]` |
| `plan` | `planSummary`, `affectedFiles[≤30]`, `acceptanceChecklist[≤15]`, `unknowns[≤10]` |
| `code` | `filesModified[≤50]` (path+op), `decisions[≤10]` (what/why), `verificationCommands[≤10]`, `knownLimitations[≤5]`, `commitSha?` |
| `review` | `verdict` (pass/needs_fix/no_change), `findings[≤20]` (file/severity/note), `reviewedDiffSha` |
| `test` | `result` (pass/fail), `failures[≤20]` (test/trace), `flakyTests[≤10]` |
| `fix` | `filesModified[≤50]`, `decisions[≤10]`, `reviewItemsResolved[≤20]`, `knownLimitations[≤5]` |

Steps outside this union (`clarify`, `release`, `custom`, `pm`) emit no handoff — gated by `isHandoffStep()` / `HANDOFF_STEPS`.

## Write / Read API

- Storage: `packages/core/src/pipeline/issue-context-store.ts` (`writeIssueContext` / `getIssueContexts` / `deleteIssueContext`).
- Writes do **not** check authorization — every caller (REST + MCP) verifies project membership first.
- Store cross-validates `payload.step === scope.step` so an agent cannot file a plan payload under a triage slot.
- Writes upsert on `(issueId, step, attempt)` natural key.

### REST

Mounted at `/api/issue-step-contexts` (`packages/core/src/pipeline/step-handoff-routes.ts`, mounted in `src/index.ts`). All routes require auth + verified email + project membership.

| Method | Path | Body / Query | Description |
|--------|------|--------------|-------------|
| `POST` | `/api/issue-step-contexts` | `{projectId, issueId, pipelineRunId, step, attempt?, payload}` | Upsert a handoff (201) |
| `GET` | `/api/issue-step-contexts` | `?projectId&issueId&pipelineRunId?&steps=triage,plan&limit&orderDir` | List handoffs (`steps` is CSV) |
| `DELETE` | `/api/issue-step-contexts` | `?projectId&issueId&step&attempt` | Idempotent delete → `{deleted}` |

### MCP tools

`packages/core/src/mcp/tools/forge-step-handoff.ts`, registered in `mcp/server.ts`. Thin wrappers over the same store with `kind='handoff'` hardcoded; require the device owner to be a project member.

- `forge_step_handoff.write` — upsert a handoff (validated by `stepHandoffSchema`).
- `forge_step_handoff.get` — list handoffs; filter by `pipelineRunId` and/or `steps` allow-list.
- `forge_step_handoff.delete` — delete by `(issueId, step, attempt)`.

## Handoff policy

`packages/core/src/pipeline/handoff-policy.ts` (`resolveHandoffsPolicy`) merges optional per-state `userPromptPolicy.handoffs` config (`pipeline-config-schema.ts`) with system defaults; default-on resolution applies even with no/partial config:

| Field | Default | Meaning |
|-------|---------|---------|
| `enabled` | `true` | Inject prior handoffs + append the termination block |
| `injectFromSteps` | per-step (below) | Which prior steps' handoffs to inject |
| `requireHandoffWrite` | `true` | (config flag; the hard write-gate is not enforced — see "Not yet") |
| `missingMarkerPolicy` | `'warn'` | (config flag; not enforced at `/complete`) |
| `fallbackToRawIssueFieldIfMissing` | `true` | Keep the raw issue field when its handoff is absent |

Default `injectFromSteps` follows the pipeline ladder so each step inherits all relevant predecessors:

```
triage → []                       plan → [triage]
code   → [triage, plan]           review → [triage, plan, code]
test   → [triage, plan, code]     fix → [triage, plan, code, review]
```

> Note: raw Zod schema in `pipeline-config-schema.ts` declares `enabled` default `false` for an *explicitly supplied* config object; `resolveHandoffsPolicy` makes the feature default-on when no config is present (`enabled ?? true`). The resolver is the single source of truth — `handoff-prefetch.ts` and `prompt/user.ts` both call it.

## Pipeline integration

1. **Prefetch** — `packages/core/src/pipeline/handoff-prefetch.ts` (`fetchHandoffPromptInputs`), called by orchestrator + PM dispatch (`pipeline/orchestrator.ts`) right before building the job prompt: resolves policy, queries `getIssueContexts` for the current run scoped to the policy's `injectFromSteps`, returns `{priorHandoffs, handoffScope}` (or `null` when disabled / no issue).
2. **Prompt build** — `packages/core/src/prompt/user.ts` renders `priorHandoffs` under `## Prior step handoffs` (one fenced JSON block per step), drops the overlapping raw field, and — for handoff-emitting steps — appends `## Termination protocol` last (so system + handoff prefix cache stays stable). The block (`renderTerminationBlock` in `step-handoff-schema.ts`) instructs the agent to (1) call `forge_step_handoff.write` with exact scope literals, (2) advance issue status via `forge_issues.update` (mandatory, non-best-effort), then (3) reply `DONE`.
3. **Termination** — agent writes its handoff during the run; on `/complete` the lifecycle handler (`packages/core/src/jobs/lifecycle-routes.ts`) treats the handoff as best-effort and does **not** gate the job on it.

## Not yet (proposed but not shipped)

- `/complete` **verification gate** — `requireHandoffWrite` / `missingMarkerPolicy` exist as config fields but are not enforced; no `handoff_not_written` / `handoff_no_done_marker` job failure. Handoffs never block completion.
- No `step_handoff` value was added to the `memory_source` enum; handoffs live in their own `issue_step_contexts` table rather than extending `memory_sources` as the proposal sketched.

## See also

- `memory-knowledge/README.md` — semantic memory / RAG (separate subsystem)
- `packages/core/src/memory/step-handoff-schema.ts` — payload schema + prompt rendering
- `packages/core/src/pipeline/{handoff-policy,handoff-prefetch,issue-context-store,step-handoff-routes}.ts`
