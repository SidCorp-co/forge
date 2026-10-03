# Domain entities: one schema, one pattern

The owner ruled on 2026-10-03 that every build gets a clearly defined schema and a clear pattern,
not a style per place. This page is that pattern for the entities of the Requirement / Feedback /
Development redesign: requirements, suggestions, issue criteria and verdicts, record events, agent
reports, workflow designs and contract versions, and whatever ISS-59 (feedback), ISS-61 (ecosystem)
and the onboarding slice add next.

- **Scope.** A *document* written as `{ baseRevision, document }` (the project document, a workflow,
  an ecosystem interface or link) is not an entity here. Its parse refuses `SCHEMA_VIOLATION` by
  JSON pointer, and its rules belong to `packages/core/src/project-config/documents.ts`.
- **How to read it.** Each rule names its reference implementation. A
  rule the code does not meet yet is marked **target**, and its gap is listed under
  [Non-conforming today](#non-conforming-today) with an owner.
- **The API comes first.** MCP and the CLI wrap the routes ([api-first.md](../proposals/destination/api-first.md)),
  so every rule below is stated for the route first.

## Where each schema lives

| Shape | Lives in | Imported by | Reference |
|---|---|---|---|
| Table, CHECKs, indexes | `packages/core/src/db/schema-<x>.ts`, one file per entity family, listed in `packages/core/drizzle.config.ts` | core only | `packages/core/src/db/schema-suggestions.ts:suggestions` |
| Enum values (`as const`), refusal codes, request schemas, response shapes, limits | `packages/contracts/src/<domain>.ts`, compiled (`tsconfig.emit.json`) and exported at `@forge/contracts/<domain>` | core (DB, routes, MCP) and web | `packages/contracts/src/suggestions.ts:SUGGESTION_STATUSES`, `:SUGGESTION_REFUSAL_CODES`, `:createSuggestionRequestSchema`, `:SuggestionView` |
| The refusal body | `packages/contracts/src/refusal.ts:RefusalEnvelope` | core and web | `packages/web-v2/src/lib/api/refusals.ts:namedRefusals` |
| Web types | `packages/web-v2/src/features/<domain>/types.ts`, which re-exports from contracts and declares only UI-local unions | web | `packages/web-v2/src/features/suggestions/types.ts` |

- **One declaration.** The DB column reads the contracts array: `text('status', { enum: X })` plus a
  `check()` built from the same array. A second copy held equal by a parity test is
  non-conforming, because the test is the only thing standing between two truths.
- **Runtime imports.** A contracts subpath core imports at runtime resolves to compiled JS.
  `packages/core/src/lib/contracts-runtime-exports.test.ts` refuses one that does not.

## Module layout in core

Each entity lives under `packages/core/src/<domain>/`, one file per responsibility. The references are
`packages/core/src/suggestions/` and `packages/core/src/requirements/`.

| File | Holds | Must not |
|---|---|---|
| **rules.ts** | Pure guards over what the service read; each returns `<Domain>Refusal \| null` or a list | Touch the DB, throw a refusal |
| **read.ts** | `rowIn(tx, projectId, ref)`, list and detail views, the actor type | Write |
| **service.ts** | Writes. Each runs in one transaction under the entity's advisory lock (`packages/core/src/requirements/service.ts:lockRequirements`) and returns `{ ok: true, … } \| { ok: false; refusals }` | Throw a refusal. It throws only a 404 and invariant `Error`s |
| **routes.ts** | Hono routes: param validators, `strictBody`, `actorOf`, `answer` | Hold a rule |
| `packages/core/src/mcp/tools/forge-<domain>.ts` | The MCP door, calling the same service function as the route | Re-implement a rule |

- A route module mounts from `packages/core/src/project-config/mount.ts` (project-scoped) or
  `packages/core/src/issues/mount.ts` (issue-scoped).
- Its prefix is in `packages/core/src/auth/pat-permissions.ts:PAT_PERMISSION_RESOURCES`, so a token can be
  granted it.

## Requests

- **Body.** `packages/core/src/middleware/zod-validator.ts:strictBody(schema, SHAPE)`. The schema is a
  `z.strictObject` from contracts, and `SHAPE` is the valid shape as a string, declared beside it
  (`packages/contracts/src/suggestions.ts:CREATE_SUGGESTION_SHAPE`).
- **What a bad body gets.** `400 BAD_REQUEST` with message `invalid body: <SHAPE>` and
  `details: { formErrors, fieldErrors }`. That names both the valid shape and the field that broke
  it.
- **Path and query.** `zValidator('param' | 'query', schema, hook)`, whose hook throws 400 naming
  what the path or query holds.

## Refusals

A write a rule refuses answers **422** with one body, and nothing is written:

```json
{ "error": { "code": "<the code, or <DOMAIN>_REFUSED when several differ>",
             "message": "refused, nothing written: <CODE> at <path>; …",
             "refusals": [{ "code": "…", "path": "/json/pointer or ''", "detail": "…" }] } }
```

- **REST.** `packages/core/src/project-config/respond.ts:refused`.
- **MCP.** `packages/core/src/mcp/tools/lib.ts:refusedAnswer`, which returns the same body flagged
  `isError`.
- **Both doors** build the body with `packages/core/src/lib/refusal.ts:refusalEnvelope`.
- **The status never varies by rule**, so a client reads `error.code` and nothing else. Who-may-act
  refusals are 422 too. The 403 in the error handler's shape (`{ code, message, details }`) stays
  for transport: no session, no project membership, a fenced token.
- **Codes.** A code is `<DOMAIN>_<WHAT>`, upper snake case. It is declared as an `as const` array in
  contracts, and a who-may-act code ends `_FORBIDDEN`.
- **Detail.** It names what was wrong and what is valid. It names another entity by its key
  (`REQ-3`), never by uuid.
- **Unknown input is refused.** A body field outside the schema gets the 400 above. A row the
  caller cannot see gets a 404 naming the ref.

## Who may act (S0 agency)

`packages/core/src/lib/person-act.ts:actMiss` is the one decision. A slice declares a rule and words the
refusal under its own code. It never compares `agency` itself.

| Rule | Person | Agent | Used by |
|---|---|---|---|
| `PERSON_ACT` | member or above | never | `packages/core/src/lib/person-act.ts:personActRefusal`, which requirement sign-off and suggestion decide both call |
| `approverRule(agentMay)` | org owner or admin | member or above, only when the project's policy says `master` | `packages/core/src/workflows/design.ts:designApproverRefusal`, `packages/core/src/ecosystem/contract/approval.ts:approverRefusal` |
| `PROJECT_AGENT_WRITE` | never | member or above | `packages/core/src/workflows/rules.ts:workflowWriterRefusal`, `packages/core/src/ecosystem/link-rules.ts:writerRefusal` |
| `PERSON_ADMIN_ACT` | project owner or admin | never | `packages/core/src/feedback/rules.ts:redactActRefusal` (deleting a reporter's data) |

- **Before this page:** seven separate implementations across the slices: requirement sign-off,
  suggestion decide, design approver, contract approver, workflow writer, link writer and builder
  supersede. ISS-58 folded the first two into `personActRefusal`. This change puts six of the seven
  on `actMiss`.
- **Still outside it:** `packages/core/src/ecosystem/builder-supersede-rules.ts:supersederRefusal` and five
  agency checks older than the redesign (listed below).
- **Recording the agency.** A table records it in `<role>_agency text`, CHECK `('human','agent')`,
  the values of `packages/core/src/issues/actor-agency.ts:ActorAgency`. The word is `human`, never `person`.

## Tables

The reference is `packages/core/src/db/schema-suggestions.ts:suggestions`, with `packages/core/src/db/schema-requirements.ts`
for revisioned entities.

- **Ids and scope.** A `uuid` primary key and `project_id` NOT NULL referencing `projects` with
  `on delete cascade`, or `issue_id` the same way for an issue-scoped row. Every list index leads
  with that scope column.
- **Enums.** `text` plus a CHECK built from the contracts array. No `pgEnum`, and no free text.
- **Timestamps.** `timestamp with time zone`. `created_at` is NOT NULL with a default of now. Each act
  gets `<act>_at`, nullable with no default.
- **Actors.** `<act>_by uuid` references `users` `on delete restrict`, because an audit column never
  forgets who acted. An act either person or agent may take also gets `<act>_agency`.
- **Immutability.** A trigger enforces it and raises a named error. A revision row is deleted only
  with its owning entity's cascade; its content is editable only while it is `draft`, and its state moves only along the
  vocabulary below (`requirement_revision_guard()` in
  `packages/core/drizzle/migrations/0349_a_requirement_has_a_home.sql`). A baseline or verdict row
  is insert-only, again but for that cascade (`requirement_baseline_guard()`, same migration; verdicts are a **target**, see
  item 9).
- **Keyed rows are never deleted.** They move to a terminal status.

## Revisions: one vocabulary

An authored entity that changes under review is a **head** row plus immutable **revision** rows
numbered 1..n.

- Each revision carries one state:
  `draft → proposed → current → superseded`.
- `current` is what was approved. The head points at it (`current_revision`), and the previous
  current becomes `superseded` in the same write.
- Approve, return and accept are **decisions**, not states. A return sends `proposed` back to
  `draft`, with its reason and decider recorded.
- The reference is `packages/core/src/db/schema-requirements.ts:REVISION_STATES`, enforced by
  `requirement_revision_guard()`.

| Entity | Today | Conforms |
|---|---|---|
| Requirement revision | `REVISION_STATES` on each revision row | yes, the reference |
| Workflow design | One `design_status` on the head (`packages/core/src/workflows/design.ts:DESIGN_STATUSES`: draft, proposed, approved, returned) plus `approved_revision` | **no**, see below |
| Contract version | `approval` on each version row (`packages/core/src/ecosystem/contract/approval.ts:CONTRACT_APPROVALS`: proposed, approved, returned) | **differs, justified** |
| Suggestion | proposed, accepted, rejected, stale, withdrawn (`packages/contracts/src/suggestions.ts:SUGGESTION_STATUSES`) | not a revision: a one-shot decision item |

**Why contract versions keep their own words.** A contract version is *recorded*, not authored: its
content is measured from a source ref, so there is no draft to edit, and a returned version is never
revised (a change is a new version). Its `approved` means `current`. A reader maps it that way and
no writer gets a fourth state.

## Keys

- **Shape.** A human key reads `<PREFIX>-<n>`. `n` is an `integer` `<x>_seq` column, unique per
  `(project_id, <x>_seq)`.
- **Format and resolve.** A formatter builds the key (`packages/core/src/requirements/read.ts:requirementKey`,
  `packages/core/src/lib/issue-ref.ts:formatIssueRef`). `rowIn` resolves a uuid, a key or a bare `n`, and
  answers 404 naming the ref (`packages/core/src/requirements/read.ts:rowIn`).
- **Allocation.** For a new entity, `max(seq)+1` inside the entity's advisory-locked transaction
  (`packages/core/src/requirements/revision-write.ts:createRequirementIn`). It needs no table, and the lock
  that serialises the entity's writes already orders it. That is safe only because keyed rows are
  never deleted.
- **ISS-n** keeps its counter row and trigger (`packages/core/src/db/schema.ts:projectIssCounters`). There is
  no shared `project_counters` table, and FB-n (ISS-59) does not need one.

## Language of stored text

- **Prose follows the project.** A column an agent writes for people to read (a title, body,
  reason, summary, criterion, label, release note) is written in the project's content language,
  the project document's `contentLanguage` (`packages/contracts/src/content-language.ts:contentLanguageOf`,
  absent is `en`). Technical terms stay English inside it.
- **Machine-read text never does.** Enum values, refusal codes, keys, field names, status names,
  step types, `file:symbol` citations and the `detail` Forge itself writes are English, and so are
  code, commits, branch names and PR titles. A client switches on them; Forge's UI chrome is English.
- **Told, not checked.** Nothing refuses a write for its language (`VISION: kernel-hard-policy-soft`).
  Every prompt that writes prose appends `packages/core/src/content-language/block.ts:contentLanguageBlock`,
  and the session records what it was told under `metadata.contentLanguage` beside `artifactContext`
  (`packages/core/src/content-language/read.ts:recordContentLanguage`). Only a tag that is not
  canonical BCP-47 is refused, `CONTENT_LANGUAGE_INVALID`.

## Records and audit

- **Issue-scoped facts.** A fact about an issue that a gate or reader relies on is a typed event,
  `record.<kind>` in `activity_log`. It is written by `packages/core/src/issues/record-events/store.ts:writeRecordEvent`,
  and its kinds come from `packages/contracts/src/record-events.ts:RECORD_EVENT_KINDS`.
- **Revisioned entities.** Their audit is their own rows: `<act>_by` / `<act>_at` / `reason` on the
  revision or decision row. A slice writes no untyped `activity_log` row of its own.
- **Repeated acts.** A decision that can happen more than once on one item, such as a return
  that is re-proposed, needs a row per decision. Overwriting the last one loses history
  (requirements walkthrough D6). Feedback is the reference: every triage, decline, verify, reopen and
  redaction inserts a `packages/core/src/db/schema-feedback.ts:feedbackDecisions` row, insert-only by
  `feedback_decision_guard()` in `packages/core/drizzle/migrations/0352_product_feedback_is_an_item.sql`.
  Requirement returns are still a **target** (item 10).

## Data policy (sensitive projects)

A project's document carries `sensitiveData`, one of
`packages/contracts/src/data-policy.ts:SENSITIVE_DATA_LEVELS` (`off`, `redact`, `no_egress`; absent
means `off`).

- **One guard.** Every path that sends item text to a provider (an embedding, an LLM tool, a prompt)
  passes it through `packages/core/src/lib/data-egress.ts:egressOf` (or `egressFor` /
  `egressDeep`). At `redact` only scrubbed text leaves; at `no_egress` nothing does and the guard
  refuses `CONTENT_EGRESS_FORBIDDEN` naming the item. A slice never checks the level itself.
- **One exemption.** Onboarding questionnaire answers are product information, not patient data
  (owner, 2026-10-04): read through `egressDeep` as the `onboarding_answers` class
  (`packages/core/src/lib/data-egress.ts:EgressDataClass`), they leave scrubbed at `no_egress` as at
  `redact`. Only batches of an onboarding conversation qualify; a BA requirement clarification batch
  can quote feedback and is refused like any other content. The questionnaire card warns on a
  `redact` or `no_egress` project that answers must not include patient data.
- **On write.** At `redact` and `no_egress`, free text an entity stores is scrubbed first
  (`packages/core/src/lib/data-egress.ts:storedText`, over the observability scrubber). Feedback
  scrubs its title, body, where-seen, answer and every decision reason, and a questionnaire scrubs
  every typed answer (`packages/core/src/lib/data-egress.ts:storedAnswers`); what it does not reach
  yet is item 25.
- **Embeddings.** `packages/core/src/embeddings/item-writer.ts:writeItemEmbedding` is the one writer;
  a withheld item is recorded as `withheld_by_policy`, never left missing.
- **Readers.** `ba_read_requirement` and `ba_read_issue` answer metadata only, plus `withheld`, at
  `no_egress` (`packages/core/src/assistant/tools/ba-tools.ts`).

## MCP

- **One tool per domain.** It is named `forge_<domain>` (plural noun) and listed in
  `packages/core/src/mcp/registered-tools.ts:REGISTERED_TOOLS`. It takes an `action` enum whose verbs match
  the routes.
- **Input** is one `z.strictObject`. A per-action `need(input, key)` throws
  `BAD_REQUEST: <action> needs <key>`.
- **Refusals** come back through `packages/core/src/mcp/tools/lib.ts:refusedAnswer`, never as thrown text.
- **Answers.** A list answers summaries and a write answers what it changed: `act`, the entity's head,
  and the relation or revision it touched. A whole document comes only from `get` or `view: 'full'`.
  - The summary field set is declared in contracts beside the full shape
    (`packages/contracts/src/requirements.ts:REQUIREMENT_SUMMARY_FIELDS`,
    `packages/contracts/src/workflows.ts:WORKFLOW_SUMMARY_FIELDS`,
    `packages/contracts/src/suggestions.ts:SUGGESTION_SUMMARY_FIELDS`).
  - Core projects it in `packages/core/src/<domain>/projection.ts`, and the door picks the view with
    `packages/core/src/mcp/tools/projection.ts:projectOne`.
  - A REST read takes the same `?view=`, full by default, because the web draws the whole document.
  - `packages/core/src/mcp/tools/answer-size.test.ts` holds each tool's default answer to its size class.
- **References:** `packages/core/src/mcp/tools/forge-suggestions.ts`, `packages/core/src/mcp/tools/forge-requirements.ts`.

## Web module

- **Files.** `packages/web-v2/src/features/<domain>/` holds **api.ts** (fetchers over `apiClient`), **hooks.ts**
  (React Query), **types.ts** (re-exports from contracts), **routes.ts** when it owns pages, and
  **components/**. The reference is `packages/web-v2/src/features/suggestions/`.
- **Refusals** render through `packages/web-v2/src/lib/api/refusals.ts` (`refusalsOf`, `namedRefusals`).
  The client already reads the envelope (`packages/web-v2/src/lib/api/client.ts:refusalOf`), so
  even `formatApiError` shows the refusal's detail rather than the status text.
- **Badges.** An enum's tone map is declared in contracts beside the enum
  (`packages/contracts/src/issue-vocabulary.ts:ISSUE_STATUS_TONES`) and drawn with
  `packages/web-v2/src/design/primitives/badge.tsx:Badge` over `packages/web-v2/src/design/status.ts:TONE_META`, as
  `packages/web-v2/src/features/issues/derive.ts:TONE_CHIP` does. A feature declares no colour map and no
  second badge primitive.

## Compat amnesties

- **Form.** A compatibility path is annotated
  `cm:hack ISS-<n> until:<condition> — <what is traded>`, the codemap grammar.
- **Where it sits.** The annotation sits on the code that is deleted when the condition holds.
- **What is checked.** Nothing in this repo checks the form, since the codemap checker was removed;
  `check-comment-budget` measures comment content only. A grep for `cm:hack` without `ISS-` finds
  the gap.

## Template: a new entity

Take feedback (ISS-59, `FB-n`) as the example. These are the files, under `packages/`, and the shapes each one exports.

```text
contracts/src/feedback.ts         FEEDBACK_STATUSES, FEEDBACK_REFUSAL_CODES (as const), the limits,
                                  createFeedbackRequestSchema + CREATE_FEEDBACK_SHAPE, FeedbackView,
                                  FeedbackResponse, FeedbackListResponse
  + contracts/tsconfig.emit.json, contracts/package.json "./feedback" → dist
core/src/db/schema-feedback.ts    feedback (uuid, project_id cascade, fb_seq unique per project,
                                  status text + CHECK from FEEDBACK_STATUSES, created_at, <act>_by/_at)
  + core/drizzle.config.ts; migration number from `node scripts/check-migration-order.mjs`
core/src/feedback/rules.ts        routeShapeRefusal(...) → FeedbackRefusal | null; who-may-act via actMiss
core/src/feedback/read.ts         rowIn (uuid | FB-n | n), feedbackKey, listFeedbackAs, detail view
  + refs.ts                       resolving the item a feedback is about, by key
core/src/feedback/service.ts      lockFeedback(tx, projectId); createFeedback / declineFeedback → Outcome
  + triage.ts, attachments.ts,    further writes, split by responsibility to stay under the file budget
    embeddings.ts
core/src/feedback/routes.ts       strictBody(createFeedbackRequestSchema, CREATE_FEEDBACK_SHAPE);
                                  answer(outcome) → refused(c, refusals) | c.json(view, 201/200)
  + core/src/project-config/mount.ts, core/src/auth/pat-permissions.ts
core/src/mcp/tools/forge-feedback-items.ts  forge_feedback_items, action: list | get | create | triage | …;
                                  refusedAnswer (the name differs, see item 21)
  + core/src/mcp/registered-tools.ts
core/src/feedback/rules.test.ts   every refusal code, planted
web-v2/src/features/feedback/     api.ts, hooks.ts, types.ts (re-export), routes.ts, components/
```

What it writes: the `feedback` row and, per decision, a decision row carrying `<act>_by`, `<act>_at`
and `reason`. If the feedback becomes an issue, the issue's own records follow the record-events
rule.

## Audit, 2026-10-03: what each slice chose

Read at `origin/dev` `0b3a1069a`.

| Concern | Choices found | Anchors |
|---|---|---|
| Refusal status and body | Three shapes. (1) `refused`, 422 `{error}`: requirements, workflows, ecosystem documents, and suggestions after the ISS-58 rework. (2) A thrown 403 in the error handler's `{code, details.refusals}`: requirement sign-off and design approver (both unified here), ecosystem `refusedBy`, workflow writer. (3) A thrown `HTTPException` in the error handler's `{code, message}`: record events at 422, criteria and verdicts at 400 or 409 | `packages/core/src/ecosystem/access.ts:refusedBy`, `packages/core/src/workflows/service.ts:assertWriter`, `packages/core/src/issues/record-events/routes.ts:refusalHttp`, `packages/core/src/issues/criteria/store.ts:CriteriaRefused` |
| MCP refusal | Thrown text in requirements, suggestions and workflows (a thrown 403 even lost its code); a structured `isError` envelope in ecosystem | now `packages/core/src/mcp/tools/lib.ts:refusedAnswer` in all four |
| Body validation | Three styles: local `strictBody` naming only the shape (×3); `zValidator` + `flattenError` naming only fields; ecosystem `SCHEMA_VIOLATION` refusals | now `packages/core/src/middleware/zod-validator.ts:strictBody`; `packages/core/src/issues/criteria/input-schemas.ts:verdictPostSchema` |
| Who may act | Seven implementations of `agency !== 'human'` / `agency === 'agent'` | now `packages/core/src/lib/person-act.ts:actMiss` |
| Enum home | Contracts for ISS-54 and suggestions; core only for requirements, criteria, agent reports and designs, each redeclared in web; two copies plus a parity test for record events | `packages/core/src/db/schema-requirements.ts:REVISION_STATES`, `packages/core/src/workflows/design.ts:DESIGN_STATUSES` |
| Agency word in tables | `human` in `activity_log` and verdicts; `person` in `contract_versions.decided_as` and `suggestions.producer_kind`; no CHECK on `actor_agency` or `author_agency` | `packages/core/src/db/schema-ecosystem.ts:contractVersions`, `packages/core/src/db/schema-activity.ts:actorAgencies` |
| Actor columns | `decided_by` (requirements, suggestions, contracts) against `decided_by_user` (workflow designs); FK `restrict` against `set null` (suggestions) | `packages/core/src/db/schema-workflows.ts:projectWorkflowDesigns` |
| Immutability | A trigger only on requirement revisions and baselines; verdicts and criteria are insert-only by comment | `packages/core/src/db/schema-issue-criteria.ts:verdictValues` |
| Keys | ISS-n by counter row and trigger; REQ-n by `max+1` under a lock; no shared counter | `packages/core/src/db/schema.ts:projectIssCounters` |
| Audit | Typed events only for issue records; requirements, suggestions, designs and contracts audit in their own columns; a transition writes the untyped `issue.statusChanged` | `packages/core/src/issues/record-events/store.ts:writeRecordEvent` |
| Amnesties | Every ISS-54/55/56 hack writes its exit as prose ("Exit:", "Ends when"), not `ISS-n until:` | `packages/core/src/issues/apply-transition.ts:LegacyMove`, `packages/core/src/issues/criteria/store.ts:syncCriteriaFromText` |
| Web badges | Four colour maps and a second badge primitive | `packages/web-v2/src/features/requirements/components/badges.tsx:EnumBadge`, `packages/web-v2/src/features/workflows/components/workflow-parts.tsx:DESIGN_PILL`, `packages/web-v2/src/features/issues/criteria.ts:BADGE` |

## Non-conforming today

Two owners appear here. **Review** is the review pass after the POC. A numbered slice is the next
slice to touch that code. Nothing below is migrated in this change.

| # | Divergence | Owner |
|---|---|---|
| 1 | Ecosystem services throw who-may-act refusals at 403 in the error handler's shape (`packages/core/src/ecosystem/access.ts:refusedBy`, used by contract version decide), and their entity writes answer through the document 422 | ISS-61 |
| 2 | `packages/core/src/workflows/service.ts:assertWriter` throws a 403 instead of returning `WORKFLOW_WRITER_NOT_PROJECT` | review |
| 3 | Record events refuse with a thrown 422 and criteria and verdicts with a thrown 400 or 409, each in the error handler's shape, not the envelope (`packages/core/src/issues/record-events/routes.ts:refusalHttp`, `packages/core/src/issues/criteria/store.ts:CriteriaRefused`, `:VerdictRefused`); `forge_criteria` takes a non-strict input, and `forge_issue_events` throws text | review |
| 4 | Requirement codes, statuses and views are declared in core (`packages/core/src/requirements/rules.ts:RequirementRefusalCode`, `packages/core/src/db/schema-requirements.ts:REVISION_STATES`) and redeclared in `packages/web-v2/src/features/requirements/types.ts`; the requirement spec and criterion schemas live in `packages/contracts/src/suggestions.ts` instead of a requirements module of its own in contracts; route bodies are built inline (`packages/core/src/requirements/routes.ts:revisionFields`) | review |
| 5 | Criteria verdict values, agent-report kinds and design statuses are declared in core and redeclared in web (`packages/core/src/db/schema-issue-criteria.ts:verdictValues`, `packages/core/src/db/schema.ts:agentReportKinds`, `packages/core/src/workflows/design.ts:DESIGN_STATUSES`) | review |
| 6 | Record-event kinds are declared twice, held by `packages/core/src/issues/record-events/kinds.test.ts` | review |
| 7 | Workflow design state is one head status, not per-revision `REVISION_STATES`; `decided_by_user` / `proposed_by_user` naming | review (migration) |
| 8 | `contract_versions.decided_as` says `person` (and carries `before-approval`); `actor_agency` and `author_agency` have no CHECK | review (migration) |
| 9 | Criteria and verdict rows are insert-only by comment, with no trigger | review (migration) |
| 10 | A requirement return overwrites `proposed_at` / `return_reason`, with no row per decision (walkthrough D6) | review |
| 11 | Refusals name another requirement by uuid (`REQUIREMENT_ISSUE_LINKED_ELSEWHERE`, walkthrough D10) | review |
| 12 | Who-may-act codes predating the suffix: `WORKFLOW_DESIGN_APPROVER_NOT_*`, `CONTRACT_APPROVER_NOT_*`, `CONTRACT_BREAKING_NEEDS_PERSON`, `WORKFLOW_WRITER_NOT_PROJECT`, `LINK_WRITER_NOT_CONSUMER` | review (a rename touches guides and MCP descriptions) |
| 13 | `packages/core/src/ecosystem/builder-supersede-rules.ts:supersederRefusal` decides agency on its own (an org admin of either side may act, whatever the agency) | ISS-61 |
| 14 | Agency checks older than the redesign: `packages/core/src/issues/transition-guards.ts`, `packages/core/src/issues/merge-marker.ts`, `packages/core/src/release-batch/approvals.ts`, `packages/core/src/issues/release-gate-hold.ts`, `packages/core/src/projects/master-charter-routes.ts` | review |
| 15 | Body validation outside `strictBody`: criteria, record events and agent reports use `zValidator` + `flattenError` with no shape hint | review |
| 16 | `packages/core/src/agent-reports/routes.ts` writes with inline drizzle rather than `packages/core/src/agent-reports/service.ts`; `forge_agent_report` is a singular name | review |
| 17 | The ISS-54/55/56 `cm:hack` annotations carry no `ISS-n until:` (`packages/core/src/issues/legacy-status.ts`, `packages/core/src/issues/criteria/event-verdicts.ts`, `packages/core/src/issues/record-events/mirror.ts`, `packages/core/src/issues/record-events/history.ts:legacyCommentRecords`, `packages/core/src/comments/tree.ts:recordOf`, `packages/core/src/agent-reports/routes.ts:feedbackReportsAliasRoutes`, `packages/core/src/mcp/tools/forge-agent-report.ts:forgeFeedbackAliasTool`) | review |
| 18 | Web colour maps outside contracts: `EnumBadge` with its own `HUE`, `DESIGN_PILL` (draft is coloured twice, differently), criteria `BADGE`, and the unused `packages/web-v2/src/features/agent-reports/types.ts:kindToBadgeTone` | review |
| 19 | The issue transition audits as the untyped `issue.statusChanged`, not `record.transition` | review |
| 20 | The BA door posts a questionnaire through its bound tool (`packages/core/src/assistant/tools/ba-tools.ts`, `ba_send_questionnaire`) without the `PROJECT_AGENT_WRITE` rule REST and MCP posting take (`packages/core/src/questionnaires/rules.ts:posterRefusal`); the room binding stands in for it | review |
| 21 | FB-n's MCP tool is `forge_feedback_items`, because `forge_feedback` is still the agent-reports alias; the `feedback:*` token grant also still means agent reports, so FB-n routes ride `projects:*` (`cm:hack ISS-59` in `packages/core/src/auth/pat-permissions.ts`) | review (a migration rewrites stored `feedback:*` grants, then the names move) |
| 22 | Feedback's target arc holds requirement, issue, release and workflow; a screen is `where_seen` text with no key, as the approved design has it, not the arc member REQ-7 BC-1 lists. A release is a `pipeline_runs` row | review |
| 23 | Feedback's stored statuses are new, triaged, reopened, verified, declined; `planned` and `resolved` are derived on read from what the route carries (`packages/core/src/feedback/rules.ts:phaseOf`) | review |
| 24 | The `answer` route stores its text on `feedback.answer`, not a decision comment, because comments have no feedback arc | review |
| 25 | Feedback gaps the POC left: an agent's clarification answer is not turned into a triage suggestion; a high or critical item does not wake the master; deleting a reporter's data does not reach text already copied into a filed draft issue; a person on the MCP door is treated as provider-bound; the scrubber recognises a name only when it is labelled or marked as a patient; a clarification answer (written by the questions module) and a triage suggestion's note are stored unscrubbed | review |
| 26 | The conversation detail carries the room's questionnaire batches, and the list each room's `kind` and `threadStatus` (`packages/core/src/assistant/conversation-routes.ts`): a conversation route reading the onboarding and questionnaire rows instead of the client reading `/questionnaires/:bid` | review |
| 27 | `onboardings.status` is set by each writer (start, post, submit, done), not derived on read from the batches and the job; the dashboard hint is derived (`packages/core/src/onboarding/read.ts:hintOf`) | review |
| 28 | `POST /api/projects/:id/onboarding/join` adds the caller to the onboarding room, which can turn a direct room into a group; no rule decides who may join beyond project access | review |
| 29 | The web maps onboarding tones onto `StatusChip` keys (`packages/web-v2/src/features/onboarding/components/marks.tsx:TONE_CHIP`), one more colour map outside contracts beside item 18 | review |
| 30 | Answering a questionnaire row through the questions route is refused `QUESTION_IN_QUESTIONNAIRE` as a thrown 409 in the questions slice's own shape (`packages/core/src/questions/write.ts:answerQuestion`), not the envelope | review |
| 31 | The data-flow guard reads the level itself (`packages/core/src/onboarding/read.ts:projectHoldsSensitiveData`) to decide whether a data-flow design is owed, which is not an egress decision | review |
| 32 | REST and MCP answer different defaults: a REST read is full unless `?view=summary`, an MCP call a summary unless `view: 'full'`; REST writes take no view and answer the whole entity | review |
| 33 | Workflows and designs carry no `waitingOn`, as requirements do; a design's `status` and `approver` say who is owed | review |
| 34 | `forge_issues`, `forge_feedback_items` and `forge_knowledge` take no `view`: their lists were already summaries and their writes answer one item, at most 3.5 KB as measured on dev on 2026-10-04. `forge_feedback_items` `propose_triage` answers the whole suggestion | review |
| 35 | A projection runs after the whole read: a write still reads the full detail (`packages/core/src/requirements/read.ts:detailOf`, `packages/core/src/workflows/design-service.ts:designView`) and the door drops most of it | review |
| 36 | `forge_suggestions` has no `get`: a suggestion's payload is read by `list` with `view: 'full'`, narrowed by target | review |

## Honest costs

| Choice | What it costs |
|---|---|
| One 422 for every rule refusal | A client can no longer branch on 403 for who-may-act, and has to read `error.code`; the requirement sign-off and design approval moved from 403 to 422 in this change |
| One declaration in contracts, compiled | Core's start depends on `@forge/contracts` being built first; a contracts edit rebuilds before core typechecks |
| Agency in one module | A slice that needs a new standing (for example a steward org admin) extends `ActRule` for everyone, rather than writing its own `if` |
| `max+1` keys under the entity lock | A keyed row can never be hard-deleted, or its number is reissued |
| Thirty-six listed divergences left in place | Until the review pass, two patterns are live for each of them, and a new slice must copy the reference, not the nearest file |
