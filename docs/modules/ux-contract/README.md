# UX Completeness Contract

Per-project rule set (`ux_contract_rules`) that projectFacts-injects into the pipeline
system prompt, plus the finding log (`ux_findings`) agents write to during
review/verify-live, plus the improver (ISS-579) that turns accumulated findings back into
proposed rules. The surface is REST + MCP + one web-v2 tab: project settings → "UX
Contract" (`packages/web-v2/src/features/project-settings/components/ux-contract-tab.tsx`,
ISS-577) — preset picker, rule list, proposed-changes inbox, compiled-prose preview.

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
| `evidenceIssueIds` | jsonb array of the issue ids that taught the rule; written by the improver |
| `supersedesRuleId` | self-FK (`set null`). Set on a `proposed` row that REPLACES another — approving it retires the target in the same request |
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
   not a table read. When `KNOWLEDGE_INJECTION_ENABLED` is on, the same call ALSO write-throughs
   to `knowledge_entries` (slug `ux-contract`), because `prompt/facts/resolve.ts` sources
   always-inject facts from there instead of `agentConfig.projectFacts` — two `cm:edge lockstep`
   annotations in `ux-contract-recompile.ts` tie that block to the two other write-through sites.
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
| `GET` | `/api/projects/:id/ux-improver/candidates` | viewer | dry run — candidates + refusals, no write |
| `POST` | `/api/projects/:id/ux-improver/propose` | admin | commits selected candidate `keys` at status `proposed`; `forge_ux_improver action=propose` gates at the same level |
| `POST` | `/api/projects/:id/ux-contract/apply-preset` | admin | replaces the rule set (see Invariants) |
| `PATCH` | `/api/ux-contract-rules/:ruleId` | admin | recompiles |
| `DELETE` | `/api/ux-contract-rules/:ruleId` | admin | recompiles |

## MCP: `forge_ux_findings` (`mcp/tools/forge-ux-findings.ts`) and `forge_ux_improver`

- `action=write` — `stage`, `kind`, `detail` required; `severity` (default `must`), `ruleId`
  optional. **`issueId`/`runId` are resolved server-side** from the calling device's active
  job (`resolveActiveJobContext`) — a caller must not (and cannot) supply them.
- Three return shapes: `{ok:true,id}` · `{ok:false,reason:"no_active_issue"}` (no issue-bound
  job running — interactive/PAT callers always get this) · `{ok:false,reason:"rate_limited",limit:50}`
  (per-job cap, `MAX_FINDINGS_PER_JOB = 50`, keyed by `(issueId, runId)`).
- `action=list` — project-member read; `filters.issueId`/`.stage`/`.kind`, `limit` (default 25).
  Finding `detail` is wrapped `markUntrusted` before return (agent-authored text). Response
  self-truncates under a 38,000-char cap, oldest-first, with `truncated`/`notice` fields.

`forge_ux_improver` (`mcp/tools/forge-ux-improver.ts`) is the improver's agent surface:
`action=candidates` (member, read-only — finding text and refusal samples come back wrapped
`markUntrusted`, since they are agent-authored) and `action=propose` (writer, commits selected
`keys`). It cannot activate a rule; only the PATCH route can, and only for a human.

**The write→learning loop is live**, not just designed. `active-job-context.ts:13` carries a
`cm:guard` recording that ISS-573/ISS-787 — the historical bug where the job-status resolver
narrowed to `= 'running'` and matched zero rows, so every write answered `no_active_issue` — is
fixed: the resolver now matches job status `IN ('dispatched','running')` and session status
`IN ('queued','running','idle')`. `forge-review`, `forge-test`, and `forge-skills` already call
`forge_ux_findings` from their SKILL.md bodies.


## The improver (`ux-improver-detect.ts` + `ux-improver.ts`, ISS-579)

Two tiers, split so the testable half is not a prompt.

**Deterministic — `ux-improver-detect.ts`, pure.** Findings + the current rule set in,
`{candidates, refused, thresholds}` out.

1. Findings citing the same `ruleId` cluster together. Uncited findings cluster greedily by
   same `kind` + Jaccard similarity `>= SIMILARITY_THRESHOLD` (0.5) over normalized detail
   tokens, seeded — never single-linkage, or `A~B~C` chains two unrelated gaps into one rule.
2. A cluster is RECURRING only when it spans `MIN_RECURRENCE_ISSUES` (3) **distinct issue
   ids**. Ten findings on one issue is one agent's habit, not a pattern.
3. Recurring clusters become `add` (nothing active covers it), `strengthen` (an existing
   `should` rule does — proposed as the same text at `must`, linked by `supersedesRuleId`),
   or nothing. `retire` covers only the improver withdrawing its OWN `learned` proposals
   after `STALE_PROPOSAL_DAYS` (60) with the gap no longer recurring.
4. The `add` text is the cluster medoid's finding detail, run through
   `prompt/sanitize.ts` first (`sanitizeUntrusted` + `stripFrameTokens`). An approved rule is
   injected verbatim into every agent prompt on the project, and the detail was authored by an
   agent — so it goes through the same chokepoint as any other untrusted prompt input. The
   human approving it in the inbox is the second control, not the first.
5. Everything refused is RETURNED, with a reason (`one-off` / `already-covered` /
   `already-proposed`). A refusal the caller cannot read is indistinguishable from a gap the
   detector never saw.

**Judging — the standing `ux-contract-improve` schedule** (`schedules/messages/
ux-improver-prompt.ts`, wired in `dispatch.ts` and listed in `NON_STEWARD_STANDING_KEYS`).
Its agent reads the candidates via `forge_ux_improver action=candidates`, tries to refute
each, and commits at most `MAX_PROPOSALS_PER_RUN` (5) survivors via `action=propose`.

**Retire-on-drift is NOT here.** "The project shipped dark theme, so retire the
dark-reserved rule" is ISS-576 (auto-detect)'s acceptance criterion. No finding kind says
*this rule is wrong*, so findings data cannot justify retiring an active rule.

**Severity does not reach the prose.** `compileUxContract` renders `text` only, so a
should→must strengthen is metadata that drives this doc's tables, the settings tab and the
preset toggles — not the contract an agent reads. Making severity visible in the prose would
break ISS-574's byte-for-byte golden test against forge-dev's hand-authored contract; that
is a live gap, not an oversight.

## Invariants

1. **Every mutating rule endpoint recompiles** — `ux-contract-routes.ts:108` (create),
   `:222` (apply-preset), `:269` (patch), `:290` (delete). No code path can change
   `ux_contract_rules` without the project fact catching up in the same request.
2. **`apply-preset` REPLACES, never merges** — `:193` `DELETE`s every existing rule for the
   project before inserting the compiled preset. Hand-added rules are lost on the next
   apply-preset call.
3. **Findings never gate a verdict.** `ux_findings` is a log the improver learns from, not a
   check reviewers or verify-live consult.
4. **`projectFacts['ux-contract']` is the whole contract surface.** Nothing outside
   `ux-contract-recompile.ts` reads `ux_contract_rules` directly for prompt purposes.
5. **The improver is propose-only.** Nothing in `ux-improver.ts` can write `status: 'active'`
   — it writes `proposed` + `source: 'learned'`, and a human approves in the settings inbox.
   Re-running is safe by construction: a candidate matching an existing proposal unions its
   evidence instead of queueing a second row, because the schedule fires every cadence tick.
6. **An approved supersede retires its target in the same request** — `ux-contract-routes.ts`
   PATCH, before the recompile. Skip it and both rules are `active`, so the compiled prose
   states the same requirement twice at two severities.
7. **Delete semantics differ by side of the relation** — a rule delete `SET NULL`s
   `ux_findings.ruleId` (findings survive); an issue delete cascades and takes its findings
   with it.

## Decided: the proposals inbox has no edit-text action

ISS-577's AC #5 asked for three inbox actions — approve, reject, **edit text** — and the
shipped tab has only approve + reject. That is deliberate, decided 2026-08-12: **do not build
it**, and do not read the gap as unfinished work.

The reason is the contract's own purpose. AC #20 makes the inbox a "choose, not write" surface,
and an active rule compiles straight into `projectFacts['ux-contract']`, i.e. into every agent's
prompt. A free-text box there lets an admin author a rule that never came from a preset,
detection or a finding, so it carries no `evidence_issue_ids` — one more channel for unverified
prose to reach the prompt. A wrong proposal is **rejected**, not reworded; the source that
proposed it can propose again.

The backend can technically do it (`rulePatchSchema` accepts `text`, used by the severity
toggle and by approve-via-`status`), so this is a product decision, not a missing capability.
If it is ever revisited, the safe shape is severity + group re-assignment only — still choosing.

## Known gaps

- **The inbox cannot reword a proposal**, by decision (above). The improver's `add` text is
  the clearest observed finding detail, so a badly-worded proposal is rejected and re-proposed
  next run rather than fixed in place.
- **No auto-apply tier.** The epic reserved "auto-apply for low-risk rules" as a later step;
  every proposal still costs one human decision.
- **No threat-model entry.** `docs/security/mcp-threat-model.md` is organized by attack class
  (T1–T7), not by tool; `forge_ux_findings` adds no new PAT/auth surface over the existing MCP
  device-principal model, so it has no natural row there.
