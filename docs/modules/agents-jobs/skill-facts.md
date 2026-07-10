# Forge Skill Facts

> Status: SHIPPED (2026-06-04, `8ae43673`) — moved here from `docs/skill-facts-design.md`.
> Skill authors write **business logic only**; all fixed Forge mechanics + project context are
> injected into the **system prompt** at dispatch, from one versioned registry
> (`packages/core/src/prompt/facts/registry.ts`). Skill files are pure user content — no template syntax.

## Architecture

```
┌─ SYSTEM PROMPT (core assembles per job; buildPipelinePreambleStructured) ──────┐
│ 1 pipeline-rules + tool-reference      (mandatory facts — registry.render)     │
│ 2 project-config + project-context     (branches, projectId)                   │
│ 3 ## Forge context                     (NEW — renderStageFactsBlock)           │
│     · contextual forge facts: universal (no appliesTo) + appliesTo ∋ stage     │
│       (headers demoted to ### so they nest under the block)                    │
│     · integrations (derived, inline) + projectFacts as fetch-on-demand INDEX   │
│ 4 state-block + state-extras           (per-state depth + operator override)   │
└─────────────────────────────────────────────────────────────────────────────────┘
   SKILL.md  = pure author content (business logic). Synced verbatim — never templated.
   USER PROMPT = issue fields (+ resume fallback embeds the preamble head).
```

- Delivery: runner passes the preamble via `--append-system-prompt` (verified honored by the CLI);
  on `--resume` the dispatcher already embeds it at the head of the user prompt
  (`injectTurnLevelRules`) as fallback — required: append is invocation-only, `--resume` drops it.
- Caveat: subagents spawned by the job's main agent (Task tool) do NOT inherit
  `--append-system-prompt` — Pipeline Rules/facts reach the main loop only. Safe today because all
  status/handoff/comment MCP writes happen in the main loop; do not move them into subagents.
- A fact change applies on the **next dispatch** — no skill re-sync, no hash churn.
- Skills resolve raw (`skills/effective.ts`): a synced SKILL.md is exactly what the author wrote.

## Fact registry (single source of truth)

`packages/core/src/prompt/facts/registry.ts` — pure (type-only schema import), unit-tested.

```ts
ForgeFact { id, title, category, tier: 'mandatory'|'contextual',
            scope: 'global'|'project-resolved', appliesTo?: JobType[], version,
            render(ctx: { projectId, stage, ladder }) }
```

| id | tier | appliesTo | notes |
|---|---|---|---|
| `pipeline-rules` / `mcp-tool-reference` | mandatory | — | rendered into preamble blocks 1 |
| `complexity-scale` | contextual | triage, plan | xs/s/m/l/xl |
| `priority-scale` / `category-enum` | contextual | triage | enums/conventions |
| `relations` | contextual | triage, plan | real kinds + warns off `blocked_by` |
| `status-ladder` | contextual | issue stages (not `pm`) | **project-resolved**: CANONICAL_LADDER minus disabled stages; OVERRIDES the default chain in pipeline-rules |
| `decompose-protocol` | contextual | triage, plan | system-owned D1–D5 |
| `comment-authoring` | contextual | issue stages (not `pm`) | |
| `handoff` | contextual | stages with a handoff schema (not release/custom/pm) | renders per-stage payload keys; `DONE` on its own line |
| `release-notes-format` | contextual | clarify, release | `{section,userFacing,technical}` |
| `worktree-protocol` | contextual | code, fix | |

`appliesTo` absent ⇒ universal (injected for every stage). Mandatory facts are never duplicated
into the stage block.

**Inline vs fetch-on-demand policy**: inline ONLY what steers mandatory behaviour (ladder, enums,
protocols, integrations tool-routing). Anything the agent can fetch through a Forge tool is
pointed-to, not inlined — `projectFacts` guides render as a key INDEX + `forge_config` fetch hint;
test URLs/creds stay behind the `forge_projects.get` pointer in Project Context. Keeps the
preamble inside Anthropic's 1.5–6K-token system-prompt budget regardless of how many guides an
author adds.

## Project facts (free-text guides — we run an LLM, no structured fields)

Stored at `agentConfig.projectFacts` (kebab key → text ≤8k), managed via
`forge_config update { projectFacts }` (per-key merge; `null` removes; whole-map `null` wipes).
Injection: the stage block lists only the KEYS (`### Project guides (fetch on demand)`) — the
agent fetches a guide's text via `forge_config` get when the task needs it; bodies never inline.
**Never store secrets** (text reaches prompts/disk). Recommended keys: `build-commands`,
`test-commands`, `git-remote`, `feature-flags`, branch model.

Reserved derived keys (not author-settable; `projects/project-facts.ts`):

| key | source |
|---|---|
| `base-branch` / `production-branch` / `repo-path` | `projects` columns |
| `test-urls` | `previewDeploy.testingUrls` |
| `test-creds` | renders a runtime **pointer** to `forge_projects.get` (never the secret) |
| `integrations` | active `project_integrations` + how-to-use hint (coolify→`forge_coolify_deploy`, postman→`forge_postman_target`/`mcp__postman__*`) |

## Resolution (`prompt/facts/resolve.ts`)

- `loadProjectFactInputs(projectId)` → `{ ladder, project(key), projectFactKeys }` — one projects
  read + active-integrations read; defensive defaults on any failure.
- Ladder = `CANONICAL_LADDER` (NOT `STAGE_FORWARD` — that map only has soft-skip edges and would
  truncate at `approved`) filtered by `pipelineConfig.states[s].enabled === false`.
- `renderStageFactsBlock(projectId, stage)` → the `## Forge context` text (or `''` when no stage).

## Author-facing surfaces

- REST `GET /api/skill-facts?projectId=&stage=` — list with project-resolved `preview`
  (future Skill Studio palette/preview).
- MCP `forge_skill_facts.list/get` — an agent AUTHORING a skill queries the real values instead of
  guessing; `forge_config` get/update covers `projectFacts`.

## Step check-in — `forge_step_start`

PIPELINE_RULES mandates one first action per step: `forge_step_start { projectId, issueId, stage }`.

- Sets the step's **working status** when the registry defines one — `PIPELINE_STEPS.workingStatus`
  (`pipeline/registry.ts`, registry v5; mirrored in contracts `pipelineStepSchema`). Sparse by
  design: `code`/`fix` → `in_progress`; `test`'s trigger `testing` already IS in-flight; other
  steps stay on their trigger (short steps — `pipeline_runs.currentStep` gives visibility).
- Guarded to the trigger→working edge (never stomps `needs_info`/`on_hold`); idempotent on resume.
- Returns the working bundle in one call: full issue + comments + latest handoffs + resolved
  `branchConfig` — replaces the per-skill fetch boilerplate (issue get / comments list / config get).
- Agent-initiated, not server-stamped (user decision): the agent owns its status updates; core
  observes. Retry/re-dispatch is keyed on `job.type`/run, NOT issue status, so an issue parked at
  a working status retries fine; the reconciler rescue set intentionally excludes working statuses
  (same accepted wedge class as pre-existing `code`).

## Authoring contract

Write the skill body free-form: the stage's mechanics arrive via the system prompt. Don't restate
status ladders, enums, decompose rules, or handoff schemas in skill text — they will drift; the
preamble version is canonical and always current.

## Open follow-ups

Core (registry + resolve + projectFacts + forge_config + REST/MCP + preamble injection) is shipped. Still open, tracked as issues — not here: bootstrap/domain-template seeding of business-logic-only skills; Skill Studio facts palette + resolved-preamble preview.

Two standing policies from the 2026-06-04 design review: facts are delivered via **system prompt** (never skill-file templating — no `{{forge:}}` syntax exists), and tool-fetchable settings are **pointed to, never inlined** (projectFacts bodies / test URLs stay behind `forge_config` / `forge_projects.get`).
