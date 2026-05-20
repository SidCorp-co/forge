# Proposal: Pipeline observability + cost control — Wave 2

- **Status:** Draft proposal (pre-RFC)
- **Date:** 2026-05-21
- **Depends on:** v0.1.34 Wave 1 (preamble + issueSnapshot + sessionContext + cost-tracking fix)
- **Design reference:** [`docs/architecture/pipeline-workflow.html`](../architecture/pipeline-workflow.html)

Wave 1 cut per-step token cost ~30–60% and fixed cost tracking. This doc enumerates what's left from the same SoT, grouped into 4 epics. Each row is one Forge issue when ready to dispatch.

## Epic 1 — Prompt-snapshot observability

Foundation + Inspector UI. Unlocks downstream analytics.

| # | Goal | Affected files | LOC |
|---|---|---|---|
| 1.1 | **Orchestrator snapshot write path (S1.3).** Populate `jobs.system_prompt_hash` + `user_prompt_snapshot` + `prompt_blocks` + `model_used` at dispatch. UPSERT into `prompt_blobs` for content-addressable dedup. | `core/src/jobs/dispatcher.ts` (both dispatch paths), `lib/chat-preamble.ts` (structured return option) | ~70 |
| 1.2 | **`GET /api/jobs/:id/prompt` endpoint.** Returns system + user + payload + blocks + actualUsage + redacted MCP config. Auth: project member. | `core/src/jobs/routes.ts` | ~80 |
| 1.3 | **Prompt Inspector drawer.** 6-tab drawer (Prompt / Response / Usage / Timing / MCP / History) from issue timeline. Block-breakdown table + cache-hit pill. | `web/src/features/jobs/components/PromptInspectorDrawer.tsx` | ~250 |
| 1.4 | **History tab + run-vs-run diff.** List runs of same step on same issue; compare 2 runs (system-hash equality short-circuit; user prompt unified diff; token delta). | `core/src/issues/routes.ts` (job-history endpoint) + `JobDiffPanel.tsx` | ~200 |
| 1.5 | **Retention + archival cron.** Nightly archive of snapshots older than `FORGE_PROMPT_RETENTION_DAYS` (default 90) to object storage; GC `prompt_blobs` ref_count=0. | `core/src/jobs/prompt-archival-cron.ts`, env var wiring | ~150 |

Total ~750 LOC. 1.1 + 1.2 unblock 1.3 + 1.4. 1.5 only matters after ~90 days of data.

## Epic 2 — Cost analytics + optimization suggestions

| # | Goal | Affected files | LOC |
|---|---|---|---|
| 2.1 | **Cost views + endpoints (C1–C3).** SQL view extending `pipeline_run_step_durations` with cache-hit + p95 + outlier flag. Three endpoints: cost-summary, cost-trend (with `activity_log` annotations), outliers. | `core/src/pipeline/analytics-routes.ts`, new migration | ~150 |
| 2.2 | **Insights page UI.** `/projects/[slug]/insights` with 3 chart panels. Tremor or recharts. Config-change annotations on trend chart. | `web/src/app/projects/[slug]/insights/*` | ~400 |
| 2.3 | **Block contribution (C4).** Aggregate `jobs.prompt_blocks` across recent runs of each state → mean / stddev / cacheHitRate per block. Sortable table with variance flag. | analytics-routes + `BlockContributionTable.tsx` | ~350 |
| 2.4 | **Rule-based suggestion engine + apply.** Rules: bloat-cap, system→user move, model downgrade, disable-unused. Auto-apply via `POST /api/analytics/apply-suggestion`. Audit-logged. | `pipeline/optimization-suggestions.ts` + UI cards | ~350 |
| 2.5 | **Cost per outcome (C5).** Cost by `issues.complexity` + first-time-right rate (`reopenCount=0`). | analytics-routes + small UI panel | ~160 |
| 2.6 | **Cross-project workspace dashboard.** N-project comparison table + heatmap state × project. Cross-project apply scope on suggestions. | new `workspace/analytics-routes.ts` + UI page | ~400 |

Total ~1800 LOC. 2.3 + 2.4 depend on Epic 1.1 (need block data).

## Epic 3 — Token budgets + enforcement

| # | Goal | Affected files | LOC |
|---|---|---|---|
| 3.1 | **Budget schema + read endpoints.** Store under `projects.appConfig.stateContext[state].budget` (no migration). Zod validation; `forge_config.update` accepts the sub-path. | `core/src/projects/routes.ts`, `mcp/tools/forge-config.ts` | ~80 |
| 3.2 | **Pre-dispatch monthly cap.** Block dispatch when month-to-date `(project, state)` cost >= `perMonthUsd` AND `action='pause'`. 80% warn emits `pipeline.budget_warning` event. | `core/src/jobs/dispatcher.ts` (top of `handleDispatch`) | ~120 |
| 3.3 | **In-flight kill on per-run overrun.** Extend Wave 1's `usageAccByJob` to estimate running cost; `graceful_kill` agent when > `perRunUsd × 1.5`. Requires desktop rebuild. | `dev/src/hooks/use-web-socket.ts` + `dev/src-tauri/src/claude_cli/agent.rs` | ~180 |
| 3.4 | **Notifications.** Wire `pipeline.budget_warning` (80%) + `pipeline.budget_breach` (100%) → Slack + email. Dedup per `(project, state, threshold, hour)`. | `core/src/notifications/channels/*` + `pipeline/hooks.ts` | ~120 |
| 3.5 | **Settings UI.** Per-state budget table in Project Settings → Pipeline → Budgets tab. | `web/src/app/projects/[slug]/settings/pipeline/page.tsx` | ~250 |

Total ~750 LOC. 3.3 needs a release tag (touches Tauri). 3.5 is last polish.

## Epic 4 — Phase 2 micro-optimizations

Three independent, parallel-shippable items.

| # | Goal | Affected files | LOC |
|---|---|---|---|
| 4.1 | **CONTEXT_SAVE @ 65% trigger (P2.1).** Append save-instruction to next `send_chat` when running token usage > 65% of context window. Per-session flag to inject once. | `dev/src/hooks/use-web-socket.ts` + `use-agent-commands.ts` | ~120 |
| 4.2 | **rollingStats project-health cache (P2.2).** Pre-compute issue counts / blockers / stale; debounced 60 min from issue lifecycle hooks; inject `## Project Health` block into `plan`-step preamble only. | new migration + `core/src/projects/rolling-stats.ts` + `chat-preamble.ts` | ~150 |
| 4.3 | **RAG gate (P2.3).** Cheap Haiku call before `forge_memory.search` to classify intent + condense query. Flag-gated via `appConfig.useRagGate`. LRU cache 200 entries; fallback on Haiku failure. | new `core/src/memory/rag-gate.ts` + extend MCP tool | ~180 |

Total ~450 LOC.

## Phase 3 — deferred (no implementation plan yet)

- Background memory consolidation (`memory-dream` cron, 24h cadence, CREATE/UPDATE/PROMOTE/PRUNE actions on `memories`).
- Knowledge-graph multi-hop PageRank traversal for `forge_memory.search`.
- Session-context embedder → `knowledge_edges` for cross-issue discovery.
- Structured `sessionContext` schema (typed `testEvidence`, `reproEvidence`, structured `reviewFeedback`).
- Interactive chat session cost tracking (Wave 1's fix only covered the pipeline path).

These are valuable but not blocking. File as separate proposals when a consumer surface justifies one.

## Recommended order

1. Epic 1.1 + 1.2 — data foundation; unlocks every analytics-flavoured surface.
2. Epic 3.1 + 3.2 — basic budget safety net; small effort, large operational value.
3. Epic 1.3 — Inspector UI; first user-visible win from Epic 1.
4. Epic 2.1 + 2.2 — cost dashboard; admin-facing value.
5. Epic 2.3 + 2.4 — block contribution + suggestion engine; the optimization story.
6. Everything else as capacity allows. Each epic is independently abandonable.
