# Issue field surface

Status: **Shipped** in `5d69e35f`, live on forge-beta 2026-08-27 — all six columns dropped by migration
`0188`, verified against `information_schema` and the deployed MCP schema · measurements below verified
against the tree and the live DB 2026-08-27

The `issues` table carried 33 columns. Nine drive machinery. Five were written at create, read by
nothing, and plumbed through 81 non-test source sites. One more was consumed by live code but
written by nobody — `0` rows fleet-wide.

All six are gone; the table is 27 columns wide. What follows is the measurement that justified each
cut, the test that decides any future one, and why the decision this was blocked on turned out to
have already been made.

## The read half already shipped — this is about the write half

`ISSUE_FIELDS_PER_STATE` in `packages/core/src/prompt/user.ts:118` is `[]` for **all sixteen** job
types, and `SESSION_FIELDS_PER_STATE` is all-off. No issue field is inlined into any agent prompt.
The agent calls `forge_step_start`, gets a lean manifest (`field → {chars}`), and pulls only what it
wants via `forge_issues.get { fields: [...] }`.

That is the *"để agent chủ động trong việc cần lấy gì"* directive, already won and shipped. So
"simplify" cannot mean "stop pushing fields at the agent" — nothing is being pushed. What is left
rigid is **storage and write surface**: every column is a thing a skill must be told to fill.

## Three tiers

| Tier | Fields | Verdict |
|---|---|---|
| **Kernel — do not touch** | `status`, `blocks` edges, `merged_at`, `waiting_kind`, `complexity`, `reopen_count`, `detector_key`, `metadata.branchConfig`, `release_batch_run_id` | VISION №11: dispatch, gating and dedupe read these. Collapsing any one breaks the kernel. |
| **Stage-owned handoff — keep addressable** | `description`, `plan`, `acceptance_criteria` | Different stages write and read them. See the test below. |
| **Cut** | `suggested_solution`, `ai_summary`, `ai_suggested_solution`, `ai_acceptance_criteria`, `ai_confidence` | Write-only. No stage reads them. |

## The cut, measured

Fleet-wide, 3,442 issues, 2026-08-27:

| Column | Filled | % | Source sites (non-test) |
|---|---|---|---|
| `suggested_solution` | 215 | 6.2% | 20 |
| `ai_acceptance_criteria` | 148 | 4.3% | 21 |
| `ai_summary` | 143 | 4.2% | 16 |
| `ai_confidence` | 141 | 4.1% | 9 |
| `ai_suggested_solution` | 7 | **0.2%** | 15 |
| | | | **81 total** |

Three facts make these a cut rather than a low-usage-but-working set:

1. **No pipeline stage reads them.** `IssueField` (`prompt/user.ts:68`) is exactly
   `'description' | 'plan' | 'acceptanceCriteria'`. The other five cannot be inlined into a prompt
   at all — there is no code path that puts them in front of an agent.
2. **No agent updates them through the pipeline surface.** The MCP writable list
   (`prompt/facts/registry.ts:134`) is *title, description, status, priority, category, complexity,
   acceptanceCriteria, plan, sessionContext, relations* — every one of the five is absent. They
   remain writable at `create` and via REST PATCH (`issues/patch-fields.ts:25,32-35`). So the value
   an issue carries is whatever intake set, never revised by the stage that would know better.
3. **The writes that still happen contradict a standing directive.** 21 `ai_summary` and 24
   `suggested_solution` writes came in via MCP between 2026-07-29 and 2026-08-24 — after the
   *no-AC-at-create* rule ("strip `acceptanceCriteria` AND `aiAcceptanceCriteria` from drafts";
   AC is decided when an issue RUNS, not when it is filed). Dropping the fields from the create
   schema **enforces that rule structurally** instead of by prompt text that agents keep missing.

The 81 sites are not idle. Each field is threaded through `sanitizeUntrusted`, the heavy-field size
accounting (`forge-issues.ts:580-584`), the `bodyManifest` builder (`:625-630`), the REST create
schema, the MCP create schema, and `patch-fields.ts`. Five fields nothing reads cost five
edits every time that machinery changes.

## Why `plan` / `acceptance_criteria` / `description` do NOT collapse

They look like three redundant text boxes. They are not — they are **the three addressable keys the
pull model has**. `IssueField` (`prompt/user.ts:68`) is exactly these three, and they are what a
stage can name in `forge_issues.get { fields: [...] }`.

Each is written by a different stage, and the state prompts direct different stages to pull each:
`clarify.ts` writes `acceptance_criteria` and `review.ts:9` tells review to "walk each
acceptanceCriteria"; `plan` is written by the plan stage and `code.ts:6` tells code to "implement the
approved plan". Note this is **prompt-layer direction, not wiring** — nothing is inlined
(`ISSUE_FIELDS_PER_STATE` is `[]` for all sixteen job types), so the pull is discretionary.

That is exactly why they must stay separate. Merge them into one agent-owned document and the
selective-pull mechanism — which shipped from the owner's own earlier directive — has nothing left
to name in `fields`. And a later stage loses the ability to tell **which prior stage asserted what**:
review can currently distinguish AC written by clarify from prose added by the coder who just wrote
the diff.

**The test for any future merge:** *does more than one stage read it, and does a reader need to know
which stage wrote it?* Two yeses → it stays separate. The five cut fields score no on both.

## Two dead columns with live consumers

`parent_issue_id`: **0 of 3,442** fleet-wide. Decompose has run daily for months and writes
`issue_dependencies` edges instead — it never touches this column. Yet two consumers read it:

- `mcp/tools/forge-pm-graph.ts:101,186` **synthesizes** extra `kind: 'parent'` graph edges from the
  column. That synthesis is dead code and contributes nothing. The edge kind itself is very much
  alive — `issue_dependencies` holds 20 real `parent` rows, and `web-v2` handles it as a
  decompose-equivalent in three places — so removing the synthesis is safe and leaves the kind fully
  supported. The module header at line 5 describes "the implicit `issues.parent_issue_id`" as though
  it were a live mechanism; it is not.
- `web-v2/.../properties-rail.tsx:155,243` gates a `ParentFallback` row on
  `issue.parentIssueId != null` — a UI branch that cannot render.

`external_id`: 0 of 3,442. Reserved for an issue-tracker import that is not live. **Keep** — it is
an integration key with no cost, unlike the five above which are on the hot write path. Worth a
`cm:why` noting it is reserved, not abandoned.

## Not defects — do not target these

| Field | Looks empty | Why that is correct |
|---|---|---|
| `waiting_kind` | 4 / 867 | Cleared on leaving `waiting`. A snapshot count measures *how many are waiting right now*, not how often it is used. |
| `release_batch_run_id` | 0% | Transient — set for the duration of a batch, cleared after. |
| `assignee_id` | 1 / 3,442 | Ownership in Forge is `status` + who holds the job. The column is vestigial but harmless; folding it in is a separate call. |

## The decision that turned out to be already made

This proposal was drafted around an apparent conflict: Onboarding C3 (issue `31c43cf0`, ISS-454,
under the ISS-443 epic) proposes **populating** `aiSummary` / `aiSuggestedSolution` /
`aiAcceptanceCriteria` — its description calls them "currently-unused columns" and treats the
emptiness as the gap to close.

**ISS-454 is closed.** It shipped, and what it shipped is the quick-capture dialog in
`web-v2/.../new-issue-dialog.tsx` — which writes the *same string* into `description` and
`aiSummary` and builds no consumer for any of the three columns. The conflict was apparent, not
real: C3's stated goal was met without the columns ever acquiring a reader.

The issue is not reopened to correct its description — reopening a closed issue to fix prose
re-stamps lifecycle state to solve a text problem. A comment on ISS-454 records that the columns
were dropped and what replaced them.

## Sequencing — all three landed in one commit

They shipped together rather than in three deploys: a commit that removes the write path but leaves
the column is a state where code and schema disagree and nothing tests the gap.

1. **No migration.** Remove the five from the MCP + REST *create* schemas and from `patch-fields.ts`.
   Writes stop; existing values are untouched and still readable. This alone lands the
   no-AC-at-create enforcement.
2. **No migration.** Delete the two dead readers of `parent_issue_id` — the edge *synthesis* in
   `forge-pm-graph.ts` (not the `parent` edge kind, which is live) and the `ParentFallback` branch in
   `properties-rail.tsx` — and correct the `forge-pm-graph.ts` module header, which currently
   documents the column as live.
3. **Migration.** Drop the five columns plus `parent_issue_id` — six in total — and strip the
   81 plumbing sites.

## Counterweight

The last field handed to the agent unconstrained was `sessionContext`, and it became the vehicle for
a fabricated `purpose.verifiedGroundTruth` claim that propagated into typed state (ISS-786 child A,
VISION №10 — state never lies). That is the honest argument against agent-shaped storage.

It is materially weaker today than it was then: ISS-820 shipped a bounded recursive walk over
`verified*` keys (`VERIFIED_CLAIM_MAX_NODES = 100_000`, `VERIFIED_CLAIM_MAX_DEPTH = 64`) plus a
200,000-byte cap in `mcp/tools/forge-issues.ts:102-153`. The pattern that proposal established —
**free-form blob, one narrow guard on the dangerous shape** — is the same one this proposal applies,
and it is already running in production.

## Residual — the skill prose the cut left behind

Dropping a column does not edit the prose that names it. Measured 2026-08-27, after the cut:

| Where | State |
|---|---|
| Bundled templates (`packages/core/skills/`) | Clean. 15 stale instructions across 6 skills fixed in `40fe7d81`; `builtin-seed.ts` re-seeded all 14 global rows on deploy (`lastSeed.updated: 6`), `skill_md` **and** `files[]`. |
| forge-dev's own project copies | Clean. Only `forge-clarify` was affected; patched to v10 and confirmed on the runner mirror. Its copies are tailored, not stale clones, so they were hand-patched rather than re-adopted. |
| 27 other projects | **151 rows still stale, 25 of them carrying a write payload.** Not touched. |

The 25 are the ones that matter: they hand-write `previewUrl` / `previewApiUrl` / `previewStatus`
into `forge_issues.update`, whose schema is `.strict()`, so the call fails whole — the `status`
write with it. Those three names never existed: no migration, no schema, nothing in the git history
of `packages/core/src` or `packages/contracts`. Impact is retry friction, not a wedge — over 60 days
288/348 `s` and 59/84 `xs` issues still merged, so agents were recovering.

They stay for the reconcile lane (ISS-795). Fanning out by hand would overwrite deliberate
tailoring — dodgeprint-fe forked 8 skills, dodgeprint-api has its own forge-clarify — and
`template-propagation.ts` is signal-only *by design*, after the last push-per-project mechanism
rotted into a mute switch (75 drafts, 10 of 15 projects invisible to a forge-test bump).

`builtin-seed-field-names.test.ts` stops the class recurring in the templates: every hand-written
`forge_issues` update payload is parsed against `ISSUE_UPDATE_DATA_KEYS`, plus a denylist of the ten
dead names. It covers the bundled skills only — a project copy is not in the tree, which is why the
25 are a reconcile item and not a gate failure.
