# Pipeline Prompt & Per-State Config

How each pipeline step's system prompt, model, tools, and MCP config are assembled from one SSOT and tuned per project. Drills into the prompt-building leg of "enqueue → dispatch → execute" ([Agents & Jobs](./README.md)).

## Overview

Every pipeline job (`triage`, `clarify`, `plan`, `code`, `review`, `test`, `fix`, `release`) reaches the runner with two prompts:

- **System prompt** — process rules + tool catalogue + project config + per-state policy block, optionally extended/replaced by the operator. Built once at dispatch from one module; identical-prefix-friendly so the Anthropic prompt cache hits across jobs.
- **User prompt** — per-issue body (description / plan / acceptance criteria / sessionContext), built at enqueue time by the orchestrator.

All dispatch parameters (system prompt, model, allowed tools, permission mode, timeout, MCP servers, session group) default to the previous hardcoded values, individually overridable per state via project settings — no migration, no Tauri release.

## System Prompt Builder (SSOT)

- `packages/core/src/prompt/system.ts` — SSOT for system-prompt assembly across all callers (dispatcher, chat, preview endpoint).
- `packages/core/src/lib/chat-preamble.ts` — back-compat re-export shim; new code imports from `prompt/system.ts`.

`buildPipelinePreambleStructured(projectId, { step, override })` returns `{ content, blocks }`, layered in order:

| # | Block id | Source | Cache role |
|---|----------|--------|-----------|
| 1 | `pipeline-rules` | `PIPELINE_RULES` const | shared prefix |
| 2 | `tool-reference` | `TOOL_REFERENCE` const | shared prefix |
| 3 | `project-config` | `projects.baseBranch` / `productionBranch` | shared prefix |
| 4 | `project-context` | `projectId` (+ hint to call `forge_projects.get`) | shared prefix |
| 5 | `state-block` | built-in per-step default (`prompt/state-prompts/<step>.ts`) | shared per step |
| 6 | `state-extras` | operator override (`systemPrompt.extras`) | last, project-specific |

Layers 1–4 are identical across every job in a project → prompt cache (5-min TTL) hits broadly. Per-issue dynamic content lives in the **user** prompt only.

### Built-in per-state blocks

`packages/core/src/prompt/state-prompts/` holds one file per step — 8 files: `triage.ts`, `clarify.ts`, `plan.ts`, `code.ts`, `review.ts`, `test.ts`, `fix.ts`, `release.ts` — exported via `index.ts` as `DEFAULT_STATE_SYSTEM_PROMPTS`, resolved with `getStatePrompt(step)`. Each is short, stable platform policy (objective + emphasis + exit/status contract); detailed procedure stays in the per-state skill. No default block for stepless intermediate states (`deploying`, `tested`, `staging`) or non-pipeline steps (`custom`, `pm`).

### Operator overrides — append vs replace

Per-state `systemPrompt` override (schema below), two modes:

- **`append`** (default) — `extras` appended after the built-in state block; shared cache prefix preserved.
- **`replace`** — `extras` REPLACE the entire static prefix and state block; operator owns the whole prompt. Cache misses every job. Zod requires non-empty `extras` when `mode === 'replace'`.

## Per-State Config Schema

Stored under `projects.agentConfig.pipelineConfig.states[<state>]` (jsonb, no migration). Validated by `stageConfigSchema` in `packages/core/src/pipeline/pipeline-config-schema.ts`, written through the project config / pipeline-config PATCH path. Every field optional; absent field preserves prior hardcoded behavior.

| Field | Type | Effect |
|-------|------|--------|
| `enabled` | bool | `false` soft-skips the stage (auto-transition past it) |
| `mode` | `auto` \| `manual` | `manual` blocks auto + PM dispatch; human-only |
| `skillName` | string | Override the skill run at this state |
| `model` | string | Opaque model id passed to the adapter (not validated) |
| `allowedTools` | string[] \| null | `null` = skill self-grant; array = hard whitelist |
| `permissionMode` | `default`\|`plan`\|`acceptEdits`\|`bypassPermissions` | Claude CLI permission mode |
| `timeoutSeconds` | int (≤86400) | Per-state runner timeout |
| `mcpServers` | record | Per-state MCP server config (forwarded as `mcpServersOverride`) |
| `systemPrompt` | `{ mode, extras }` | System-prompt override (see above); `extras` ≤ 32k chars |
| `userPromptPolicy` | object | Tunes user-prompt fields/caps/handoffs (consumed at enqueue) |
| `budget` | `{ perRunUsd, perMonthUsd, action }` | Pre-dispatch + in-flight cost caps |
| `sessionGroup` | string | Joins this state to a named session group |

Session groups declared under `pipelineConfig.sessionGroups: { [name]: state[] }` with top-level `onResumeFail: 'fresh' | 'abort'`. A cross-field `superRefine` rejects any `states[x].sessionGroup` that isn't a declared group.

`userPromptPolicy` (`userPromptPolicySchema`) tunes `includeFields`, `sessionContext.{depth,fields}`, `fieldCaps`, `truncationStrategy`, and the step-handoff injection block. Consumed by the orchestrator at enqueue time (the resulting `promptString` already reflects it), not at dispatch.

## Dispatch-Time Resolution

`packages/core/src/jobs/stage-overrides.ts` — `resolveStageOverrides(projectId, payload)` reads the `stageStatus` the orchestrator stamped on `job.payload` at enqueue, looks up `pipelineConfig.states[stageStatus]`, returns a normalized `StageOverrides` (all fields nullable; `null` = default). A DB read failure logs at warn and falls back to defaults — best-effort, never crashes a dispatch.

The dispatcher (`packages/core/src/jobs/dispatcher.ts`) then:

1. Resolves overrides once before runner selection (reused after, so the pinned `sessionGroup` matches what's forwarded).
2. Calls `buildPipelinePreambleStructured(projectId, { step, override })` to build the runner system prompt + blocks.
3. For session-group resume, embeds the system prompt as turn-level rules at the head of the user prompt (`injectTurnLevelRules`) — fallback for the undocumented case where the CLI ignores `--append-system-prompt` on `--resume`.
4. Persists a prompt snapshot (below).
5. Merges override fields onto `job.payload` via `buildOverridesPayload` (`model`, `allowedTools` joined to CSV, `permissionMode`, `timeoutSeconds`, `mcpServersOverride`, `sessionGroup`) and dispatches.

The `claude-code` adapter (`packages/core/src/runners/adapters/claude-code.ts`) lifts those payload keys plus `claudeSessionId` to top-level fields on the `job.assigned` WS message and forwards `systemPrompt` directly — fixing the earlier bug where the runner fell back to the chat preamble.

## Prompt Snapshot & Hashing

`packages/core/src/jobs/prompt-snapshot.ts` — `persistPromptSnapshot` runs on every dispatch (observability-only; failures logged and swallowed):

1. `sha256(systemPrompt)` → UPSERT into `prompt_blobs (hash, content, ref_count)` incrementing `ref_count` on conflict (content-addressable dedupe).
2. UPDATE the `jobs` row with `systemPromptHash` (FK to `prompt_blobs.hash`), `userPromptSnapshot`, `promptInputTokenEst`, `modelUsed`, and structured `promptBlocks`.

## Surfaces

| Surface | Endpoint / file | What |
|---------|-----------------|------|
| Preview | `POST /api/prompts/preview` (`prompt/routes.ts`) | Build the system + user prompt + `blocks` + `hash` for a `state`/`issueId` with optional overrides. Read-only; does not mutate config or enqueue. |
| Inspector | `GET /api/jobs/:id/prompt` (`jobs/routes.ts`, envelope in `jobs/prompt-route.ts`) | Returns the persisted snapshot: system prompt (resolved via `prompt_blobs`), user prompt, blocks, hash, redacted `mcpConfig`, and `resolvedFlags` (the values that reached the runner). |

`resolvedFlags` (`extractResolvedFlags`) reads the dispatcher-stamped payload keys (`stageStatus`, `model`, `allowedTools`, `permissionMode`, `timeoutSeconds`, `sessionGroup`, `claudeSessionId`). MCP secrets in the Inspector envelope pass through `redactMcpSecrets`.

## Not Yet Shipped

State Editor UI (only `POST /api/prompts/preview` backend exists) · dispatcher doesn't stamp `systemPromptMode` (Inspector renders null) · CLI flag-override behavior on `--resume` never empirically verified (the `injectTurnLevelRules` fallback covers it).
