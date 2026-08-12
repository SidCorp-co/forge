# PM Agent — Requirements

**Status:** draft / pre-implementation
**Author:** requirements session, 2026-05-02
**Scope:** stateless coordinator agent that supplements the existing status-driven pipeline. No code yet — this document gates the build session.

---

## 3.1 Context summary

All paths below are relative to `jarvis-agents/packages/core/` unless noted.

### Pipeline today (status → skill → job)
The current pipeline is **fully deterministic and per-issue**. There is no cross-issue coordinator.

- `src/issues/transition.ts:144` — every status change emits `hooks.emit('transition', …)` on the in-process bus (`src/pipeline/hooks.ts`).
- `src/pipeline/orchestrator.ts:243` — `registerPipelineOrchestrator(bus)` subscribes to `transition` and `issueCreated`, then calls `considerEnqueue()`.
- `src/pipeline/skill-mapping.ts:12` — `STATUS_TO_SKILL` maps `open→forge-triage`, `confirmed→forge-plan`, `approved→forge-code`, `developed→forge-review`, `testing→forge-test`, `released→forge-release`, `reopen→forge-fix`. Statuses `waiting`, `staging`, `on_hold`, `needs_info`, `pipeline_failed` are **human-gated** — no auto-skill.
- `src/jobs/enqueue.ts` + `src/jobs/dispatcher.ts:23` — jobs go through pg-boss (`src/queue/boss.ts`), then `dispatchViaDevice` or `dispatchViaRunner`. `ensureAgentSessionForJob()` (`src/jobs/agent-session-link.ts`) creates an `agent_sessions` row for observability.

### Self-healing already exists (per-issue, not cross-issue)
- `src/pipeline/sweeper.ts` — `registerPipelineSweeper()` ticks every 60s, scans `ACTIVE_PIPELINE_STATUSES` with no active job, calls `decideRecovery()` (recover / escalate / skip), bumps `issues.recovery_attempts`.
- Migration `drizzle/migrations/0036_pipeline_self_healing.sql` added `recovery_attempts`, `last_recovery_at`, `recovery_window_started_at` on `issues`.
- Other watchers: `registerQueuedWatchdog`, `registerStuckWatcher`, `registerRetentionSweeper` (all `src/pipeline/`).

### Memory / pgvector already in place
- `src/db/schema.ts:895` — `memories` table: `(projectId, source, sourceRef, textContent, embedding vector(1536), metadata, embeddedAt)` with HNSW cosine index `embeddingHnswIdx` and uniqueness on `(projectId, source, sourceRef)`. Sources: `issue | comment | job | note | knowledge`.
- `src/memory/indexer.ts:120` — auto-embeds on `issueCreated` and `commentCreated` hooks via `queueMicrotask` (eventual consistency, never blocks the request).
- `src/memory/search-service.ts` `runMemorySearch()` and `src/memory/search.ts:26` `searchMemories()` — cosine-distance KNN, top-k 1–50 (default 10).
- `src/embeddings/client.ts` — `embed(text)` wrapper, dim=1536, model from `env.EMBEDDINGS_MODEL` (LiteLLM-compatible).
- `src/db/schema.ts:1030` — `knowledge_edges` table holds RDF-style `(subject, predicate, object, value, sourceMemoryId, confidence, validFrom, validUntil)` triples per project. Currently sparse; not yet auto-populated.

### MCP surface
- `src/mcp/server.ts:30` — stateless MCP server exposed at `POST /api/mcp` (`src/mcp/handler.ts`), device-token auth.
- Tools today: `forge_version`, `forge_memory.search`, `forge_skills.{list,get,register}`, `forge_issues` (list/get/create/update/transition), `forge_comments`, `forge_config`, `forge_tasks`. **No tool exists today for cross-issue queries (deps, blockers, schedules, runner load).**

### Agent session lifecycle
- `src/db/schema.ts:1248` — `agent_sessions(id, projectId, userId, deviceId, title, status, messages jsonb, claudeSessionId, repoPath, usage, metadata, diff, pipelineControl, pipelineTelemetry, pipelineHealth)`.
- Status enum: `idle | queued | running | completed | failed`.
- `pipelineControl` (`src/agent-sessions/pipeline-control-types.ts`): `paused, pausedBy, pausedAt, reason, abort, updatedAt` — already supports operator pause/abort.
- `metadata` is free-form; existing pipeline sessions use `metadata.type` to scope listings (`metadataType` filter on `GET /api/agent-sessions`).

### Schedules / cron
- `src/db/schema.ts:999` — `schedules(name, cron, prompt, runner, enabled, targetProjectSlug, lastRunAt, nextRunAt)`. `runner` enum: `desktop | antigravity`.
- `src/schedules/` ticker boots a cron loop and emits `scheduleRun` hook → enqueues job. Today the prompt is opaque text shipped to the runner.

### WebSocket fan-out
- `src/ws/broadcast-subscribers.ts:14` — bridges hooks to rooms (`project:<id>`, `device:<id>`, `user:<id>`, `runner:<id>`, `global`). Existing events relevant to PM: `issue.statusChanged`, `issue.updated`, `task.*`, `notification.created`, `schedule.run`, `job.assigned`.

### Auth / device
- `src/auth/deviceToken.ts` — `X-Device-Token: <prefix>.<hash>` matched against `devices` table. PM tools that run on a runner must reuse this; PM tools called by the desktop UI use the user JWT (`src/auth/jwt.ts`).

### Existing "agents" table is **not** PM
- `src/db/schema.ts:1175` — `agents(name, type, focusAreas, schedule, approvalMode, maxProposals, promptTemplate, …)`. This is the **scout/reindex** agent that proposes new issues from product gaps. PM Agent is a different concern (coordinating existing issues), but the schema is a useful reference and may share `approvalMode` semantics.

### Naming conventions to follow
Each domain folder shape: `routes.ts` (Hono handlers), `service.ts` or `*-service.ts` (business logic), `search.ts` for query helpers, `*.test.ts` collocated, Zod schemas inline or `schema.ts`. DB additions go in `src/db/schema.ts` + new migration under `drizzle/migrations/`. Hooks use the typed `HookPayloads` interface in `src/pipeline/hooks.ts`.

### Gap (what the codebase confirms is missing)
There is no cross-issue reasoning anywhere. The orchestrator decides "issue X moved to status Y → run skill Z." Nothing decides:
- Which issue to start next when several are `approved`
- Whether issue X should wait on issue Y
- Whether the same runner is overloaded
- Whether a stalled blocker needs human help vs. another auto-attempt
- Whether the queue mix matches operator intent ("ship the auth epic this week")

That gap is the PM Agent's job.

---

## 3.2 PM Agent lifecycle

PM Agent is a **stateless Claude session per decision cycle**. It is *not* a long-running daemon and *not* a per-issue worker. It is invoked, reads context, writes decisions, and exits.

### Triggers (event → spawn)

PM is spawned by inserting a `pm` job (new job type, see §3.4) which goes through the existing pg-boss queue and a runner. Trigger sources:

1. **Job lifecycle hooks** — subscribe new orchestrator-side handler to:
   - `job.failed` (terminal, post-recovery) → spawn PM with `cause = 'job-failed'`
   - `issue.statusChanged → pipeline_failed` → spawn PM with `cause = 'pipeline-stalled'`
   - `issue.statusChanged → needs_info` → spawn PM with `cause = 'needs-info'` (decide if auto-resolvable from memory or escalate)
2. **Cron / schedule** — a project-level "PM cadence" (e.g. every 30 min, every hour). Implemented via a new `pm_schedules` row or a flag on existing `schedules`. Default off. Emits `cause = 'tick'`.
3. **Queue depth signal** — sweeper-style watchdog: when `count(jobs WHERE status='queued') > N` for a project, spawn PM with `cause = 'queue-pressure'`.
4. **Operator request** — `POST /api/projects/:id/pm/run` (manual trigger from desktop/web UI). `cause = 'operator'`.
5. **Issue-graph change** — when a dependency edge is added/removed (new `issue_dependencies` table, §3.3), spawn PM with `cause = 'graph-changed'`.

PM **does not** spawn on every `transition`. The default pipeline already handles the happy path; PM only wakes when coordination is plausibly needed.

### Spawn dedup
At most one PM session per project may be `running` at a time. Reuse the existing `jobs_active_unique` constraint pattern: add `(projectId, type='pm') WHERE status IN ('queued','dispatched','running')` to prevent thundering-herd PM spawns when many hooks fire at once.

### Step-by-step execution

A PM session is a Claude Code agent that runs the following loop **once** then exits:

1. **Receive trigger payload** — `{ projectId, cause, eventRef, deadline_ms }`. `eventRef` points to the originating job/issue/transition for context. `deadline_ms` defaults to 120 s.
2. **Load lightweight snapshot** — see §3.5. Always loaded, no LLM call.
3. **Classify cause** — short LLM call decides which deeper context to fetch (see §3.5 conditional loads).
4. **Self-assemble context** — call `forge_memory.search`, `forge_pm.graph`, `forge_pm.runner_load`, etc. as needed.
5. **Reason and decide** — produce a structured decision object (see below).
6. **Persist decisions** — call writer tools (`forge_pm.dispatch`, `forge_pm.set_dependency`, `forge_pm.flag_blocker`, `forge_pm.escalate`). Each writer is idempotent and produces a `pm_decisions` row.
7. **Emit completion** — set `agent_sessions.status='completed'`, write summary into `metadata.pmSummary`, broadcast `pm.decision` WS event. Exit.

### Decision object shape
```jsonc
{
  "summary": "string",       // human-readable, surfaced in UI feed
  "actions": [
    { "type": "dispatch",   "issueId": "...", "reason": "..." },
    { "type": "set_dep",    "from": "...", "to": "...", "reason": "..." },
    { "type": "flag",       "issueId": "...", "blocker": "...", "severity": "low|med|high" },
    { "type": "escalate",   "issueId": "...", "to": "operator", "question": "..." },
    { "type": "noop",       "reason": "..." }
  ],
  "confidence": 0.0,
  "nextTickHint": "now|soon|hour|day"  // advisory only
}
```

### Completion / escalation signals
- **Completion (no human needed):** `agent_sessions.status='completed'`, all actions executed by writer tools, WS `pm.decision` broadcast. Operator sees a feed entry only if `severity >= med` or any `escalate` action exists.
- **Escalation (human needed):** PM emits one or more `escalate` actions → writer tool inserts a `notifications` row with `type='pm_escalation'` (new enum value) targeting project owner + assignees, and transitions the issue to `needs_info` or `on_hold` per §3.6.
- **Failure:** session crashes / times out → existing `pipeline-sweeper` recovery applies. Three consecutive PM failures within an hour for the same project → auto-disable PM cadence for that project and notify owner.

### Shutdown
PM is a single-shot agent. It must set `pipelineControl.abort=true` on its own session if it detects mid-flight that it should yield (e.g. operator paused project pipeline). After exit the session row remains for audit; messages and tool calls are preserved in `messages jsonb` exactly like other agent sessions.

---

## 3.3 Memory schema requirements

All additions are **incremental**. We extend `memories` rather than create a parallel store.

### New tables

1. **`issue_dependencies`** — explicit graph edges PM relies on.
   - Columns: `id, projectId, fromIssueId, toIssueId, kind ('blocks'|'relates'|'duplicates'|'parent'), reason text, createdById, createdAt, validUntil`.
   - Unique on `(projectId, fromIssueId, toIssueId, kind)`.
   - Indexed on `(projectId, fromIssueId)` and `(projectId, toIssueId)`.
   - Note: `issues.parent_issue_id` already exists for hierarchy — `issue_dependencies` is for non-hierarchical relations.

2. **`pm_decisions`** — append-only audit log.
   - Columns: `id, projectId, sessionId (→ agent_sessions), cause, eventRef jsonb, summary, actions jsonb, confidence, modelTier, tookMs, createdAt`.
   - Index on `(projectId, createdAt desc)`.

3. **`pm_config`** — per-project PM settings (Q8 locked: separate from `agents` table).
   - Columns: `id, projectId (unique), enabled (bool, default false), cadenceCron (text, nullable — null = event-only), eventTriggers (jsonb, default all on: {jobFailed, pipelineStalled, needsInfo, queuePressure, graphChanged}), customInstructions (text, nullable), modelOverride (text, nullable — null = use app_config default per Q3), maxRunsPerHour (int, default 6), createdAt, updatedAt`.
   - Per-project enable/disable, cadence opt-in, and trigger-mask UI all live here.
   - Routes: new `src/pm/routes.ts` (CRUD), parallel to `src/agents/routes.ts` but independent.

4. **`pm_policies`** — operator-authored constraints PM must respect.
   - Columns: `id, projectId, name, body text, embedding vector(1536), enabled, priority int, createdAt, updatedAt`.
   - Examples: "Never auto-dispatch issues labelled `migration` without operator approval"; "Pause `forge-code` after 5 consecutive `pipeline_failed` in 24h"; "Prefer issues in epic ISS-274 this sprint."
   - Embedded so PM can pull only relevant policies via vector search rather than dumping all of them.

### Extensions to existing tables

- `memories.source` enum gains `'decision' | 'policy'`.
  - PM decisions get embedded (text = `summary` + serialized `actions`) so future PM sessions can recall "we already decided X about issue Y last Tuesday."
  - Policies get embedded on insert/update so PM can fetch by relevance.
- `notifications.type` enum gains `'pm_escalation'`.
- `jobs.type` enum gains `'pm'`.
- `runners.type` enum: PM jobs run on existing `claude-code` runners — no new runner type. (Open question 1, §3.7.)

### What gets embedded (and why)

| Source | Why PM needs it |
|---|---|
| `issue` (existing) | Find related work, prior decisions on similar issues |
| `comment` (existing) | Surface stakeholder context, prior blockers |
| `job` (existing) | Recall failure modes for similar issues |
| `decision` (new) | Avoid re-deciding what a prior PM already settled; detect oscillation |
| `policy` (new) | Pull only relevant rules into context |
| `knowledge` (existing) | Operator-curated long-form docs |

Comments embedded today are already authored ones; PM-authored comments (when PM posts to an issue) re-use that same indexer — no special path.

### Retention / decay strategy

- `memories` table is unbounded today and grows monotonically. PM does **not** add high-volume traffic (a few decisions per hour at most), so no immediate retention is required.
- `pm_decisions` table: keep all rows for 1 year; archive to cold storage (or delete) older rows via `registerRetentionSweeper` extension. Embeddings for archived decisions are deleted from `memories`.
- `issue_dependencies` rows with `validUntil < now()` are filtered out at query time; cleaned up by a quarterly sweep.
- **Decay for relevance, not deletion:** memory search results returned to PM should weight `embeddedAt` (newer scores higher). Implement as a re-rank step in `searchMemories()` — half-life ~30 days. This is a small change to `src/memory/search.ts`, optional for v1.

---

## 3.4 Tool set requirements

PM Agent calls MCP tools via the same `POST /api/mcp` path as other agents. Each tool follows the existing pattern in `src/mcp/tools/` (Zod input schema, device-scoped, returns plain JSON).

### Must-have (v1)

| Tool | Purpose | Input | Output | Wraps |
|---|---|---|---|---|
| `forge_memory.search` | Semantic recall (already exists) | `{projectId, query, topK, sourceFilter[]}` | `{hits[], model, took_ms}` | `runMemorySearch()` |
| `forge_pm.snapshot` | Lightweight project snapshot | `{projectId}` | `{counts_by_status, active_jobs, stalled_issues, queued_count, recent_failures[], runner_health}` | new aggregator over `issues`, `jobs`, `runners` |
| `forge_pm.graph` | Dependency / blocker graph | `{projectId, rootIssueId?, depth?}` | `{nodes[{id, status, priority, assignee}], edges[{from, to, kind}]}` | new query over `issues`, `issue_dependencies` |
| `forge_pm.runner_load` | Runner capacity check | `{projectId}` | `{runners[{id, type, status, lastSeenAt, in_flight, capacity?}]}` | new aggregator over `runners`, `jobs` |
| `forge_pm.dispatch` | Trigger a specific issue's next pipeline step | `{projectId, issueId, reason, jobType, payload?}` | `{ok, jobId}` | **directly calls `enqueueJob()` (bypasses orchestrator)** per Q4 decision. Still validates: jobType must exist in `STATUS_TO_SKILL` values; refuses if `jobs_active_unique` would conflict. Records bypass in `pm_decisions.actions` for audit. |
| `forge_issues` (existing) | Create / update / transition issues | as today | as today | reused for PM-authored issue creation per Q5; PM may file new issues when it detects gaps. |
| `forge_pm.set_dependency` | Add/update edge | `{projectId, fromIssueId, toIssueId, kind, reason, validUntil?}` | `{ok, edgeId}` | inserts `issue_dependencies` |
| `forge_pm.flag_blocker` | Mark issue as blocked + comment | `{projectId, issueId, blocker, severity, expectedResolver?}` | `{ok, commentId}` | wraps `forge_comments` create + sets `issues.status='on_hold'` if severity=high |
| `forge_pm.escalate` | Surface to operator | `{projectId, issueId?, question, options?[], severity}` | `{ok, notificationId}` | inserts `notifications` row, sets `pm_escalation` type |
| `forge_pm.write_decision` | Persist the structured decision | `{projectId, sessionId, summary, actions[], confidence, cause, eventRef}` | `{ok, decisionId}` | inserts `pm_decisions` + triggers memory indexer for `source='decision'` |

### Nice-to-have (v1.x)

| Tool | Purpose |
|---|---|
| `forge_pm.simulate` | Dry-run: given current state, return what the orchestrator would do for each candidate issue, without enqueueing. Useful for PM to compare alternatives before `dispatch`. |
| `forge_pm.epic_progress` | Roll-up across `parent_issue_id` tree: what % done, ETA based on prior similar issues' job durations. |
| `forge_pm.timeline` | Recent N events on the project (transitions, jobs, decisions) — saves multiple roundtrips. |
| `forge_pm.policy.list` | List enabled policies for a project (PM agents will normally pull via memory.search, but explicit listing helps debugging). |

### Read-only vs writer tools
Read tools (`snapshot`, `graph`, `runner_load`, `memory.search`) require only project membership. Writer tools (`dispatch`, `set_dependency`, `flag_blocker`, `escalate`, `write_decision`) require the device token to be associated with a runner whose `type='claude-code'` and whose owning user has `member` or `admin` role on the project. Authorization helper `assertDeviceOwnerIsMember` (`src/mcp/tools/lib.ts`) is reused; a new `assertPmActor` wraps it plus a role check.

### What PM **cannot** do via tools
- Cannot directly modify `agent_sessions.pipelineControl` of *other* sessions (no manual pause of running workers — that is operator-only).
- Cannot write to `pm_policies` (those are operator-curated).
- Cannot change `runners` config or `app_config`.
- Cannot edit issue title/description of *other* authors' issues (only comment + transition + dependency). PM-authored issues (per Q5) are editable by PM.

---

## 3.5 Context assembly strategy

PM begins each cycle context-empty. The strategy is layered to keep the prompt budget small (target < 30k tokens per session pre-reasoning).

### Always loaded (lightweight, no LLM call)
- `forge_pm.snapshot(projectId)` — counts and a small list of items needing attention. Should be < 2 KB.
- The trigger payload itself: `cause`, `eventRef`, originating job/issue summary if present.
- Project metadata: `name`, `baseBranch`, `productionBranch`, `agentConfig` (already available via `forge_config`).
- Top 3 enabled `pm_policies` by `priority` (regardless of relevance, so global rules are never missed).

### Conditionally loaded (per cause)

| Cause | Additional load |
|---|---|
| `job-failed` | Last 50 `job_events` for the failing job; sibling jobs on same issue; `forge_memory.search(query=issue.title + " failure")`. |
| `pipeline-stalled` | Issue's full status history (activity log); recovery_attempts; `forge_pm.graph` rooted at this issue, depth=2. |
| `needs-info` | Issue body + last 5 comments; `forge_memory.search` for similar resolved issues. |
| `tick` | `forge_pm.snapshot` already covers it; only deeper-load if any stalled/queued counts > 0. |
| `queue-pressure` | `forge_pm.runner_load`; `forge_pm.graph` for currently-queued issues; recent decisions to detect oscillation. |
| `operator` | Operator-supplied prompt verbatim; trust them but still validate writer-tool outputs against state machine. |
| `graph-changed` | The new edge's two endpoints + their immediate neighbourhood, depth=1. |

### Never loaded (avoid noise)
- Full issue list (`forge_pm.snapshot` already summarises).
- Raw `messages` jsonb of other agent sessions (huge; dispatcher + completion summaries are enough).
- Chat sessions / chat logs (different domain — user/widget conversations, not project ops).
- Source code or repo state (PM is not a coder; per-issue worker agents handle that).
- `usage_records` / cost data (out of scope for v1; revisit if cost-aware routing per `docs/proposals/cost-aware-model-routing.md` lands).
- Old PM decisions older than 14 days unless surfaced by `forge_memory.search`.

### Recall vs dump
PM never receives a "context dump" prompt-side. Every additional load is a tool call the model chose to make. This keeps cost bounded by the model's actual reasoning depth and produces an inspectable trace in `agent_sessions.messages`.

---

## 3.6 Human gate interface

Operators are scarce. PM should escalate only when it adds value and never silently change state.

### Trigger conditions for escalation

PM **must** escalate when:
1. The decision touches a `pm_policies` entry that the policy text explicitly marks `requires_approval: true`.
2. PM detects oscillation (same issue moved between two statuses ≥ 3 times in 24 h).
3. A blocker is `severity=high` and no prior comment proposes a path forward.
4. PM's confidence < 0.5 and any proposed action is a writer action.
5. A dependency edge would create a cycle.
6. Recovery attempts on an issue exceed `MAX_RECOVERY_ATTEMPTS` (already tracked) AND existing sweeper has not auto-escalated.

PM **may** escalate (operator-tunable per project) when:
- Two issues in the same epic both ready to dispatch and only one runner is free.
- Cross-epic priority conflict: critical issue in epic A vs blocker in epic B.

PM **must not** escalate for:
- Routine pipeline transitions the orchestrator already handles correctly.
- Single failed jobs that have not yet exhausted retries.

### What PM surfaces

Escalation writes a `notifications` row (`type='pm_escalation'`) and broadcasts a `pm.escalation` WS event to `project:<id>`. Payload:

```jsonc
{
  "decisionId": "uuid",
  "projectId": "uuid",
  "issueIds": ["uuid", ...],            // 0..n; 0 means project-wide
  "severity": "low|med|high",
  "summary": "1-2 sentences plain text",
  "question": "the specific question for the operator",
  "options": [                          // optional; null means free-text reply
    { "id": "approve", "label": "Approve dispatch" },
    { "id": "defer",   "label": "Defer 24h" },
    { "id": "reassign","label": "Reassign", "needs": "userId" }
  ],
  "context": {
    "snapshot": { /* lightweight subset, NOT full PM context */ },
    "relevantMemories": [ { "id": "...", "source": "...", "excerpt": "..." } ]
  },
  "expiresAt": "iso8601"                // default: now + 24h; after expiry, fallback action runs
}
```

### Expected operator response

Operator responds via UI (desktop or web). Response shape:

```jsonc
{
  "decisionId": "uuid",
  "choice": "approve|defer|reassign|reject|free_text",
  "payload": { /* option-specific */ },
  "comment": "optional free text"
}
```

Endpoint: `POST /api/projects/:projectId/pm/escalations/:decisionId/respond` (auth: project member). Response:
- Inserts a `comments` row on the related issue(s) with the operator's reply (+ memory-indexed automatically).
- Marks notification read.
- Triggers a follow-up PM spawn with `cause='operator-reply'` so PM can act on the answer immediately.

### Fallback when no operator response by `expiresAt`
Each escalation declares one fallback action authored by the PM at escalation time (e.g. "if no answer in 24h, defer issue 48h and re-evaluate"). On expiry, a sweeper executes the fallback and records it as a new `pm_decisions` row with `cause='escalation-timeout'`.

### Where it lives in the UI
Surface in the existing notifications feed (`src/notifications/`). New badge on project home: "PM has 2 questions for you." This is a UI concern outside this requirements doc but the schema above is sufficient for it.

---

## 3.7 Decisions and open questions

### Decisions (locked 2026-05-03)

| # | Question | Decision | Implication |
|---|---|---|---|
| 1 | Runner type for PM jobs | **(a)** shared `claude-code` runner pool now; option (b) `runners.type='pm'` later if load demands | Three isolation layers ship in v1 — see §3.7.1 details below |
| 2 | Cadence default for new projects | **off** | Operator must explicitly enable PM tick per project. PM still spawns from event triggers (job-failed, pipeline-stalled, etc.) regardless. |
| 3 | Model tier strategy | **fixed default** model for all PM runs in v1 | Use the project's default chat/runtime model from `app_config` (`src/db/schema.ts:1288`). Per-cause routing deferred to v1.x — `jobs.modelTier` column stays available for that future tweak. |
| 4 | Authority over `dispatch` | **(b) PM directly enqueues**, bypassing the orchestrator | Faster, fewer roundtrips. Risk-mitigation: `forge_pm.dispatch` still rejects unknown `jobType`s and respects `jobs_active_unique`. Every bypass is logged in `pm_decisions.actions` for audit. State-machine drift is the cost — accept it. |
| 5 | Can PM create issues | **yes, via existing `forge_issues` MCP tool** | No new tool needed. PM may file new issues (gap detection, missing migrations, etc.). This sharpens the overlap with the scout `agents` table — see Q8 still open. |
| 6 | Cross-project decision visibility | **keep current behaviour: project-scoped only** | `notifications` stay user+project scoped per `src/notifications/`. No new global feed. |
| 7 | Policy authoring UX | **free-text Markdown first** | `pm_policies.body` is plain MD; LLM interprets at reasoning time. Structured DSL revisited only if operators report ambiguity in practice. |

### Q1 detail (isolation layers under decision a)

- **(a.1) Separate pg-boss queue.** Add `PM_QUEUE_NAME='forge-pm-jobs'` alongside `JOB_QUEUE_NAME` (`src/jobs/queue-name.ts`). `src/jobs/dispatcher.ts` registers a second handler with its own concurrency cap so PM and coder jobs never contend at the queue layer.
- **(a.2) Runner opt-in capability flag.** Reuse `runners.capabilities` (jsonb). Mark eligible runners with `capabilities.pm=true`; `dispatchViaRunner()` filters PM jobs to those runners only. Default in dev: every `claude-code` runner accepts PM; prod operators can pin PM to a subset.
- **(a.3) Per-type in-flight cap.** Extend `jobs_active_unique` with `(projectId, type='pm') WHERE status IN ('queued','dispatched','running')` so at most one PM session per project runs at a time. Coder capacity unaffected.
- Migration path to (b): split `runners.type` enum and promote `capabilities.pm` to a dedicated runner type. No v1 schema rework needed.

### Q8 (locked 2026-05-03): separate `pm_config` table

PM gets a dedicated `pm_config` table; the existing `agents` table stays scout-only. Rationale:

- 5 of 13 `agents` columns (`focusAreas`, `maxProposals`, `excludeCategories`, `reindexPromptTemplate`, `knowledge/memory` text fields) do not apply to PM and would become awkwardly optional.
- `agents.approvalMode` semantics (preview-then-accept proposals) does not match PM's escalate-when-needed gate (§3.6).
- PM lifecycle differs (event triggers + cron, vs. cron-only scout).
- Two contracts evolve independently — avoids a god-table after 2–3 sprints of feature work.

### Still open

(none — all 8 questions resolved.)
