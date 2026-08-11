# UX Completeness Contract

Per-project rule set (`ux_contract_rules`) that projectFacts-injects into the pipeline
system prompt, plus the finding log (`ux_findings`) agents write to during
review/verify-live. REST/MCP only — **no UI anywhere**: `packages/web-v2/src`,
`packages/dev/src` have zero `ux-contract`/`uxContract`/`uxFinding` references.

## `ux_contract_rules` table

`packages/core/src/db/schema.ts:3196`. One row per rule; `orderIndex` controls compile order.

| Column | Notes |
|--------|-------|
| `id`, `projectId` | cascade-deletes with the project |
| `group` | enum `uxRuleGroups`: `designSystem` \| `states` \| `flows` \| `a11y` \| `microcopy` \| `responsive` |
| `text` | the rule prose (≤4000 chars) |
| `severity` | enum `uxRuleSeverities`: `must` \| `should` (default `must`) |
| `source` | enum `uxRuleSources`: `preset` \| `detected` \| `learned` \| `manual` (default `manual`) |
| `status` | enum `uxRuleStatuses`: `active` \| `proposed` \| `retired` (default `active`) — only `active` rows compile |
| `evidenceIssueIds` | jsonb array, unused by any current writer |
| `orderIndex` | compile order within a group |

## `ux_findings` table

`schema.ts:3224`. One row per gap an agent observed against a rule.

| Column | Notes |
|--------|-------|
| `id`, `projectId`, `issueId` (cascade), `runId` (`set null`) | provenance, resolved server-side (see MCP below) |
| `stage` | enum `uxFindingStages`: `review` \| `verify-live` |
| `ruleId` | `set null` on rule delete — a finding outlives the rule it cited |
| `kind` | enum `uxFindingKinds`: `missing-state` \| `a11y` \| `microcopy` \| `responsive` \| `design-system` \| `other` |
| `detail`, `severity` | `severity` reuses `uxRuleSeverities` |

## The loop: presets → compiler → `projectFacts['ux-contract']`

1. An admin calls `apply-preset` (or hand-edits rules) → `ux_contract_rules` changes.
2. `recompileAndPersistUxContract` (`ux-contract-recompile.ts`) re-reads all `active` rules
   for the project, ordered by `orderIndex`, and runs them through `ux-contract-compiler.ts`
   with the project's stack scaffold (from `agentConfig.uxContractProfile`, set by
   `apply-preset`'s `profile` — falls back to `DEFAULT_UX_SCAFFOLD` when absent).
3. The compiled prose is merged into `agentConfig.projectFacts['ux-contract']`
   (`mergeProjectFacts`) — the same fact key every pipeline skill's `{{project:ux-contract}}`
   template resolves. This is the contract's only interface to an agent: a project fact,
   not a table read.
4. During `review`/`verify-live`, agents that find the changed UI failing a rule call
   `forge_ux_findings action=write` → a `ux_findings` row. Findings are observations, not
   gates — nothing reads `ux_findings` to compute a verdict (see Invariants).

## REST endpoints (`ux-contract-routes.ts`, mounted `index.ts:400,423`)

Two Hono routers: project-scoped (`/api/projects/:id/...`) and rule-id-scoped
(`/api/ux-contract-rules/:ruleId`). All require `requireAuth()` + `assertEmailVerified()`.

| Method | Path | Role | Notes |
|--------|------|------|-------|
| `GET` | `/api/projects/:id/ux-contract-rules` | viewer | optional `?status=` filter |
| `POST` | `/api/projects/:id/ux-contract-rules` | admin | creates one rule, recompiles |
| `GET` | `/api/projects/:id/ux-findings` | viewer | optional `?issueId=` filter |
| `POST` | `/api/projects/:id/ux-contract/apply-preset` | admin | replaces the rule set (see Invariants) |
| `PATCH` | `/api/ux-contract-rules/:ruleId` | admin | recompiles |
| `DELETE` | `/api/ux-contract-rules/:ruleId` | admin | recompiles |

## MCP: `forge_ux_findings` (`mcp/tools/forge-ux-findings.ts`)

- `action=write` — `stage`, `kind`, `detail` required; `severity` (default `must`), `ruleId`
  optional. **`issueId`/`runId` are resolved server-side** from the calling device's active
  job (`resolveActiveJobContext`) — a caller must not (and cannot) supply them.
- Three return shapes: `{ok:true,id}` · `{ok:false,reason:"no_active_issue"}` (no issue-bound
  job running — interactive/PAT callers always get this) · `{ok:false,reason:"rate_limited",limit:50}`
  (per-job cap, `MAX_FINDINGS_PER_JOB = 50`, keyed by `(issueId, runId)`).
- `action=list` — project-member read; `filters.issueId`/`.stage`/`.kind`, `limit` (default 25).
  Finding `detail` is wrapped `markUntrusted` before return (agent-authored text). Response
  self-truncates under a 38,000-char cap, oldest-first, with `truncated`/`notice` fields.

**The write→learning loop is live**, not just designed. `active-job-context.ts:13` carries a
`cm:guard` recording that ISS-573/ISS-787 — the historical bug where the job-status resolver
narrowed to `= 'running'` and matched zero rows, so every write answered `no_active_issue` — is
fixed: the resolver now matches job status `IN ('dispatched','running')` and session status
`IN ('queued','running','idle')`. `forge-review`, `forge-test`, and `forge-skills` already call
`forge_ux_findings` from their SKILL.md bodies.

## Invariants

1. **Every mutating rule endpoint recompiles** — `ux-contract-routes.ts:108` (create),
   `:222` (apply-preset), `:269` (patch), `:290` (delete). No code path can change
   `ux_contract_rules` without the project fact catching up in the same request.
2. **`apply-preset` REPLACES, never merges** — `:193` `DELETE`s every existing rule for the
   project before inserting the compiled preset. Hand-added rules are lost on the next
   apply-preset call.
3. **Findings never gate a verdict.** `ux_findings` is a log for the (currently unimplemented,
   see Known gaps) learning loop, not a check reviewers or verify-live consult.
4. **`projectFacts['ux-contract']` is the whole contract surface.** Nothing outside
   `ux-contract-recompile.ts` reads `ux_contract_rules` directly for prompt purposes.
5. **Delete semantics differ by side of the relation** — a rule delete `SET NULL`s
   `ux_findings.ruleId` (findings survive); an issue delete cascades and takes its findings
   with it.

## Known gaps

- **No promotion path.** `uxRuleSources` includes `'learned'` and findings exist to feed it,
  but no code reads `ux_findings` to create or propose a rule. The learning loop is designed,
  not implemented.
- **`ux-contract-recompile.ts` does not write through `knowledge_entries`.** When
  `KNOWLEDGE_INJECTION_ENABLED` is on, `prompt/facts/resolve.ts` sources always-inject facts
  from `knowledge_entries` instead of `agentConfig.projectFacts`
  (see [memory-knowledge](../memory-knowledge/README.md#known-gaps)) — but
  `ux-contract-recompile.ts` still only writes `agentConfig.projectFacts['ux-contract']`.
  Flipping the flag would silently drop every project's compiled UX contract from agent
  prompts, with no error (tracked, parked at `waiting`, flag defaults `false`).
- **No threat-model entry.** `docs/security/mcp-threat-model.md` is organized by attack class
  (T1–T7), not by tool; `forge_ux_findings` adds no new PAT/auth surface over the existing MCP
  device-principal model, so it has no natural row there.
