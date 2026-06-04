# Forge Skill Facts — Design

> Status: implemented in core (2026-06-04). Goal: skill authors write **business logic only**;
> all fixed Forge mechanics + project context are injected into the **system prompt** at dispatch,
> from one versioned registry. Skill files are pure user content — no template syntax.

## Problem (evidence)

Audited 3 live skill sets. Per skill, the share that is **copy-pasted, drift-prone Forge mechanics**:

| Project | Forge-mechanics boilerplate | Genuine business logic | Status ladder |
|---|---|---|---|
| jarvis-agents | 65–75% | 25–35% | `developed → testing → released` |
| dodgeprint-api | ~35% (+57% scaffold) | 5–8% | `tested → staging` (terminal) |
| anhome | 45–50% | 50–55% | `deploying → testing → staging → released` |

Authors had to rediscover + hand-copy, and a wrong copy fails silently: per-project status ladders,
decompose D1–D4, complexity/priority enums, relation kinds (skills wrote `blocked_by`/`depends_on`
— real kinds are `blocks/relates/duplicates/parent/decomposes`), handoff schemas, build/test
commands, integrations.

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
  (`pipeline/registry.ts`, registry v3; mirrored in contracts `pipelineStepSchema`). Sparse by
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

## Rollout

```
DONE  registry + resolve + projectFacts + forge_config + REST/MCP + preamble injection
P3    codemod the 3 projects' skills: strip hand-written Forge-mechanics prose
      (now redundant — the preamble carries it); keep business logic only
P4    bootstrap/domain-template seeds minimal business-logic-only skills
TODO  Skill Studio web UI (facts palette + resolved preamble preview)  — issue to be filed
```

## Decisions log

- 2026-06-04: two namespaces (forge/project) ✓ · unknown handling n/a (no template vars) ·
  issue-detail enums incl. priority/category ✓ · project facts = free-text guides ✓ ·
  **facts delivered via system prompt, not skill-file templating** (user decision after verifying
  the CLI honors `--append-system-prompt`; earlier `{{forge:}}`/`{{project:}}` file-expansion +
  frontmatter `facts:` directive were implemented then removed in favor of this).
- 2026-06-04 final review (vs Claude Code system-prompt research): ladder precedence made explicit
  (pipeline-rules defers to `### Status ladder`) · issue-bound facts scoped off `pm` via
  `appliesTo` · fact headers demoted to `###` inside the block · `DONE` marker self-contained in
  the handoff fact · **inline-vs-pointer policy** (user decision): tool-fetchable settings/config
  are indexed + pointed-to, never dumped — projectFacts bodies and test URLs left to
  `forge_config`/`forge_projects.get`.
