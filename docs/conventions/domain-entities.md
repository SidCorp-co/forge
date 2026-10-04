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
- **A guard that runs before the service** (a route-level who-may-act check) throws
  `packages/core/src/lib/refusal.ts:RefusalError`, and `packages/core/src/middleware/error.ts`
  answers it with the same 422 body. A service returns its refusals; it never throws them.
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
| `PROJECT_MEMBER_WRITE` | member or above | member or above | `packages/core/src/ecosystem/waits/rules.ts:writerRefusal` (adding or retracting a contract wait); `packages/core/src/comments/entity-rules.ts:posterRefusal` (a comment on a requirement, design or feedback item; its author edits it, else a project admin person, `:editorRefusal`) |
| `SUPERSEDE` | org owner or admin (of the steward org when it is one there, else of the project's org) | member or above | `packages/core/src/ecosystem/builder-supersede-rules.ts:supersederRefusal` |
| `PERSON_ADMIN_ACT` | project owner or admin | never | `packages/core/src/feedback/rules.ts:redactActRefusal` (deleting a reporter's data) |

- **Before this page:** seven separate implementations across the slices: requirement sign-off,
  suggestion decide, design approver, contract approver, workflow writer, link writer and builder
  supersede. ISS-58 folded the first two into `personActRefusal`, the conventions change put five
  more on `actMiss`, and ISS-61 the last, builder supersede.
- **Still outside it:** five agency checks older than the redesign (item 14).
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
  `record.<kind>` in `activity_log`. A caller's record is written by `packages/core/src/issues/record-events/store.ts:writeRecordEvent`,
  and its kinds come from `packages/contracts/src/record-events.ts:RECORD_EVENT_KINDS`.
- **Kernel evidence is core's.** A transition, a park and a verdict
  (`packages/contracts/src/record-events.ts:KERNEL_ONLY_RECORD_KINDS`) are written only by core, by
  `packages/core/src/issues/record-events/store.ts:writeKernelRecord`, in the transaction of the act
  they record: the status move (`packages/core/src/issues/record-events/kernel-records.ts:recordMove`)
  and the verdict row (`packages/core/src/issues/criteria/store.ts:recordVerdict`). A caller posting one
  is refused `EVENT_KIND_KERNEL_ONLY`, and a kernel row cannot be evaluated or deleted
  (`KERNEL_RECORD_IMMUTABLE`). `issue.statusChanged` stays as the feed's and the charts' activity
  row; no gate reads it.
- **Revisioned entities.** Their audit is their own rows: `<act>_by` / `<act>_at` / `reason` on the
  revision or decision row. A slice writes no untyped `activity_log` row of its own.
- **Repeated acts.** A decision that can happen more than once on one item, such as a return
  that is re-proposed, needs a row per decision. Overwriting the last one loses history
  (requirements walkthrough D6). Feedback is the reference: every triage, decline, verify, reopen,
  redaction and promotion from an agent report inserts a `packages/core/src/db/schema-feedback.ts:feedbackDecisions` row, insert-only by
  `feedback_decision_guard()` in `packages/core/drizzle/migrations/0352_product_feedback_is_an_item.sql`.
  A requirement return is a row each (`packages/core/src/db/schema-requirements.ts:requirementReturns`,
  insert-only by `requirement_return_guard()` in
  `packages/core/drizzle/migrations/0355_a_requirement_return_is_a_row.sql`); a re-proposal is still a
  **target** (item 10).
- **Comments on other entities.** A comment sits on exactly one of issue | requirement | workflow |
  feedback (`comments_scope_chk`, ISS-83). One on a requirement, design or feedback item has no
  issue to carry an activity row, so its post and each edit insert a
  `packages/core/src/db/schema-comments.ts:commentEvents` row holding the content as it stood,
  insert-only by `comment_event_guard()` in
  `packages/core/drizzle/migrations/0361_a_comment_sits_on_exactly_one_target.sql`. A decision there
  carries `decision: { decision, reason, options?, authority?, reversedWhen? }`
  (`packages/contracts/src/comments.ts:decisionFieldsSchema`).

## Data policy (sensitive projects)

A project's document carries `sensitiveData`, one of
`packages/contracts/src/data-policy.ts:SENSITIVE_DATA_LEVELS` (`off`, `redact`, `no_egress`; absent
means `off`).

- **One rule.** Every read that hands content to an agent or a provider (an embedding, an LLM tool,
  a prompt, an MCP or API answer to an agent) passes
  `packages/core/src/lib/data-egress.ts:egressDeep(project, surface)` (or `egressAt` at a level
  already read), and each surface declares its class once, in
  `packages/core/src/lib/data-egress.ts:EGRESS_SURFACES`. A slice never checks the level itself and
  never carries an exemption of its own; a surface that is not in the table is refused
  `EGRESS_SURFACE_UNDECLARED`, so a new surface cannot leak.
  - **product** (requirements, designs, issues and their criteria, comments and questions,
    suggestions, onboarding answers) is written to build the product: an agent reads it at every
    level, scrubbed at `redact` and `no_egress`, as written at `off`.
  - **operational** (feedback and its attachments and comments, assistant conversations with people,
    BA clarifications) is what people send in, where patient text arrives: scrubbed at `redact`,
    withheld at `no_egress`, refused `CONTENT_EGRESS_FORBIDDEN` naming the item while the caller
    answers metadata only.
  - A questionnaire takes its class from its own arc
    (`packages/core/src/questionnaires/read.ts:questionnaireSurface`), never from the caller. The
    questionnaire card warns on a `redact` or `no_egress` project that answers must not include
    patient data.
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
- **Access.** A tool declares `grant` (the permission), `reach` (`project`, `public` or `{ account }`)
  and `route` (the REST mount its rows are served at, one per resource its grants name, or the nested
  route it shares with REST where that route serves a newer prefix's rows). The route dates the tool
  for the grant epoch, by the data it serves rather than the mount it sits under
  (`packages/core/src/auth/pat-permissions.ts:PAT_NESTED_SURFACES`). Registration on `/mcp` and in chat refuses a tool missing any
  of them (`packages/core/src/mcp/tool-grant.ts:assertToolDeclaresAccess`). Both doors refuse a
  call through `packages/core/src/mcp/tool-call-guard.ts:toolCallRefusal`, which reads the same epoch
  rule as REST (`packages/core/src/auth/pat-permissions.ts:patEpochRefusal`).
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
- **Badges.** An enum's labels, tones, glyphs and hints are declared in contracts beside the enum
  (`packages/contracts/src/issue-vocabulary.ts:ISSUE_STATUS_TONES`), or, for an enum core declares,
  in `packages/contracts/src/ui-vocabulary.ts:STATE_READINGS` and `:ENUM_LABELS`.
  `packages/web-v2/src/design/vocabulary.ts:LEGEND` names the colours each tone draws. A state value
  is drawn with `packages/web-v2/src/design/primitives/enum-badge.tsx:StatusBadge` and any other enum
  with `:EnumBadge`; plain text goes through `packages/web-v2/src/design/vocabulary.ts:enumLabel`. A
  value no map names reads sentence-cased and neutral, never as the raw token. A status whose tone
  depends on the project is toned by
  `packages/contracts/src/issue-vocabulary.ts:issueStatusToneOn`. A feature declares no colour map
  and no second badge primitive.

## Compat amnesties

- **Form.** A compatibility path carries one comment naming its issue, the condition that ends it
  and what is traded: `ISS-<n> until:<condition> — <what is traded>`. Older ones are written
  `cm:hack ISS-<n> until:…`; the prefix is a plain comment now and is neither required nor read.
- **Where it sits.** The comment sits on the code that is deleted when the condition holds.
- **What is checked.** Nothing in this repo checks the form or the content of a comment.

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
| Audit | Typed events only for issue records; requirements, suggestions, designs and contracts audit in their own columns; a transition writes its typed `record.transition` and, after the commit, the untyped `issue.statusChanged` activity row | `packages/core/src/issues/record-events/kernel-records.ts:recordMove` |
| Amnesties | Every ISS-54/55/56 hack writes its exit as prose ("Exit:", "Ends when"), not `ISS-n until:` | `packages/core/src/issues/apply-transition.ts:LegacyMove`, `packages/core/src/issues/criteria/store.ts:syncCriteriaFromText` |
| Web badges | Four colour maps and a second badge primitive (a requirements `EnumBadge`, the criteria `BADGE`, `DESIGN_PILL`) | now `packages/web-v2/src/design/primitives/enum-badge.tsx:StatusBadge` and `:EnumBadge` everywhere |

## Non-conforming today

Two owners appear here. **Review** is the review pass after the POC. A numbered slice is the next
slice to touch that code. Items 1 and 13 were closed by ISS-61, 18 and 29 by the shared
`StatusBadge`, and 19 by ISS-96; their numbers are not reused. ISS-108 gave master passes their MCP door
(`packages/core/src/mcp/tools/forge-masters.ts`) and the runs read model its own
(`packages/core/src/mcp/tools/forge-runs.ts`), so item 43 keeps only the missing key.

| # | Divergence | Owner |
|---|---|---|
| 2 | `packages/core/src/workflows/service.ts:assertWriter` throws a 403 instead of returning `WORKFLOW_WRITER_NOT_PROJECT` | review |
| 3 | Record events refuse with a thrown 422 and criteria and verdicts with a thrown 400 or 409, each in the error handler's shape, not the envelope (`packages/core/src/issues/record-events/routes.ts:refusalHttp`, `packages/core/src/issues/criteria/store.ts:CriteriaRefused`, `:VerdictRefused`); `forge_criteria` takes a non-strict input, and `forge_issue_events` throws text | review |
| 4 | Requirement codes, statuses and views are declared in core (`packages/core/src/requirements/rules.ts:RequirementRefusalCode`, `packages/core/src/db/schema-requirements.ts:REVISION_STATES`) and redeclared in `packages/web-v2/src/features/requirements/types.ts`; the requirement spec and criterion schemas live in `packages/contracts/src/suggestions.ts` instead of a requirements module of its own in contracts; route bodies are built inline (`packages/core/src/requirements/routes.ts:revisionFields`) | review |
| 5 | Criteria verdict values are declared in core and redeclared in web (`packages/core/src/db/schema-issue-criteria.ts:verdictValues`). Design statuses moved to `packages/contracts/src/design-status.ts:DESIGN_STATUSES` and agent-report kinds to `packages/contracts/src/agent-reports.ts:AGENT_REPORT_KINDS` (ISS-93), which core re-exports | review |
| 6 | Record-event kinds are declared twice, held by `packages/core/src/issues/record-events/kinds.test.ts` | review |
| 7 | Workflow design state is one head status, not per-revision `REVISION_STATES`; a revision's state is derived on read (`packages/core/src/workflows/design-standing.ts:revisionStateOf`), never stored; `decided_by_user` / `proposed_by_user` naming | review (migration) |
| 8 | `contract_versions.decided_as` says `person` (and carries `before-approval`); `actor_agency` and `author_agency` have no CHECK | review (migration) |
| 9 | Criteria and verdict rows are insert-only by comment, with no trigger | review (migration) |
| 10 | A re-proposal of a returned requirement revision overwrites `proposed_at` / `proposed_by`, with no row per proposal; returns have their own rows (walkthrough D6) | review |
| 11 | Refusals name another requirement by uuid (`REQUIREMENT_ISSUE_LINKED_ELSEWHERE`, walkthrough D10) | review |
| 12 | Who-may-act codes predating the suffix: `WORKFLOW_DESIGN_APPROVER_NOT_*`, `CONTRACT_APPROVER_NOT_*`, `CONTRACT_BREAKING_NEEDS_PERSON`, `WORKFLOW_WRITER_NOT_PROJECT`, `LINK_WRITER_NOT_CONSUMER` | review (a rename touches guides and MCP descriptions) |
| 14 | Agency checks older than the redesign: `packages/core/src/issues/transition-guards.ts`, `packages/core/src/issues/merge-marker.ts`, `packages/core/src/release-batch/approvals.ts`, `packages/core/src/issues/release-gate-hold.ts`, `packages/core/src/projects/master-charter-routes.ts` | review |
| 15 | Body validation outside `strictBody`: criteria and record events use `zValidator` + `flattenError` with no shape hint; agent-report triage bodies take `strictBody` since ISS-113 | review |
| 16 | `forge_agent_report` is a singular name; its `submit` inserts through `packages/core/src/agent-reports/service.ts:insertReport` but checks its input inline, and the REST door has no submit | review |
| 17 | The ISS-54/55/56 `cm:hack` annotations carry no `ISS-n until:` (`packages/core/src/issues/legacy-status.ts`, `packages/core/src/issues/criteria/event-verdicts.ts`, `packages/core/src/issues/record-events/mirror.ts`, `packages/core/src/issues/record-events/history.ts:legacyCommentRecords`, `packages/core/src/comments/tree.ts:recordOf`, `packages/core/src/agent-reports/routes.ts:feedbackReportsAliasRoutes`, `packages/core/src/mcp/tools/forge-agent-report.ts:forgeFeedbackAliasTool`) | review |
| 20 | The BA door posts a questionnaire through its bound tool (`packages/core/src/assistant/tools/ba-tools.ts`, `ba_send_questionnaire`) without the `PROJECT_AGENT_WRITE` rule REST and MCP posting take (`packages/core/src/questionnaires/rules.ts:posterRefusal`); the room binding stands in for it | review |
| 21 | FB-n's MCP tool is `forge_feedback_items`, because `forge_feedback` is still the agent-reports alias; the `feedback:*` token grant also still means agent reports, so FB-n routes ride `projects:*` (`cm:hack ISS-59` in `packages/core/src/auth/pat-permissions.ts`) | review (a migration rewrites stored `feedback:*` grants, then the names move) |
| 22 | Feedback's target arc holds requirement, issue, release and workflow; a screen is `where_seen` text with no key, as the approved design has it, not the arc member REQ-7 BC-1 lists. A release is a `pipeline_runs` row | review |
| 23 | Feedback's stored statuses are new, triaged, reopened, verified, declined; `planned` and `resolved` are derived on read from what the route carries (`packages/core/src/feedback/rules.ts:phaseOf`) | review |
| 24 | The `answer` route stores its text on `feedback.answer`, not a decision comment; comments gained the feedback arc in ISS-83, and nothing moved the answer onto one | review |
| 25 | Feedback gaps the POC left: an agent's clarification answer is not turned into a triage suggestion; a high or critical item does not wake the master; deleting a reporter's data does not reach text already copied into a filed draft issue; a person on the MCP door is treated as provider-bound; the scrubber recognises an unlabelled name only when it opens with a common Vietnamese surname (`packages/observability/src/personal-data.ts:scrubPersonalData` names the trade-off), so a name with a rarer surname still passes; a clarification answer (written by the questions module) and a triage suggestion's note are stored unscrubbed | review |
| 26 | The conversation detail carries the room's questionnaire batches, and the list each room's `kind` and `threadStatus` (`packages/core/src/assistant/conversation-routes.ts`): a conversation route reading the onboarding and questionnaire rows instead of the client reading `/questionnaires/:bid` | review |
| 27 | `onboardings.status` is set by each writer (start, post, submit, done), not derived on read from the batches and the job; the dashboard hint is derived (`packages/core/src/onboarding/read.ts:hintOf`) | review |
| 28 | `POST /api/projects/:id/onboarding/join` adds the caller to the onboarding room, which can turn a direct room into a group; no rule decides who may join beyond project access | review |
| 30 | Answering a questionnaire row through the questions route is refused `QUESTION_IN_QUESTIONNAIRE` as a thrown 409 in the questions slice's own shape (`packages/core/src/questions/write.ts:answerQuestion`), not the envelope | review |
| 31 | The data-flow guard reads the level itself (`packages/core/src/onboarding/read.ts:projectHoldsSensitiveData`) to decide whether a data-flow design is owed, which is not an egress decision | review |
| 32 | `CONTRACT_PROVIDER_NOT_LIVE` answers in the release blockers' 409 shape (`packages/core/src/release-batch/blocker-errors.ts:releaseBlockerError`), not the envelope, as every release blocker does; and it refuses the whole release, the auto-release sweep included, not only the issue that waits | review |
| 33 | A contract wait is named by its uuid in refusals and routes, because a wait carries no key | review |
| 34 | The admissible list holds a waiting issue by SQL (`packages/core/src/ecosystem/waits/gate.ts:waitUnsettledSql`) that mirrors `packages/core/src/ecosystem/waits/rules.ts:holdsDispatch`; only the predicate is unit-tested | review (an integration test) |
| 35 | A change request's channel decision document can still answer it in prose; only the draft requirement it landed as (`packages/core/src/ecosystem/requests/land.ts:landChangeRequestIn`) and the provider's approved versions gate anything | review (owner question) |
| 36 | A provider's live version is derived, not recorded: its newest verified release identity matched to a contract measurement's commit (`packages/core/src/ecosystem/waits/live.ts:providerLiveVersion`). An uploaded version, an unprobed provider or a stale land reads as no version, so E4 refuses until the ecosystem sets `releases.providerLive` to `off` | review |
| 37 | Comments (ISS-83): an issue decision stays prose, held only off issues by `comments_decision_fields_chk` (`cm:hack ISS-83` in `packages/core/src/db/schema.ts:comments`); the issue door keeps its untyped `comment.created` activity rows and writes no `comment_events`; `comments` has no `project_id` and no `author_agency` (the agency is read from the device or `users.kind`, as ISS-1137 decided); a comment on another entity is not screened by `packages/core/src/comments/screen.ts:screenAgentComment` and takes no mentions or attachments | review |
| 38 | REST and MCP answer different defaults: a REST read is full unless `?view=summary`, an MCP call a summary unless `view: 'full'`; REST writes take no view and answer the whole entity | review |
| 39 | The workflows list carries no `waitingOn`; only the design read does (`packages/core/src/workflows/design-standing.ts:designWaitingOn`, ISS-72) | review |
| 40 | `forge_issues`, `forge_feedback_items` and `forge_knowledge` take no `view`: their lists were already summaries and their writes answer one item, at most 3.5 KB as measured on dev on 2026-10-04. `forge_feedback_items` `propose_triage` answers the whole suggestion | review |
| 41 | A projection runs after the whole read: a write still reads the full detail (`packages/core/src/requirements/read.ts:detailOf`, `packages/core/src/workflows/design-service.ts:designView`) and the door drops most of it | review |
| 42 | `forge_suggestions` has no `get`: a suggestion's payload is read by `list` with `view: 'full'`, narrowed by target | review |
| 43 | A master pass has no key: refusals name it by its verb and start time, and its history (`GET /api/projects/:id/masters/passes`, `forge_masters` `passes`) pages by `before`, the last start a page served (`packages/core/src/masters/read.ts:listMasterPasses`), not by a key | review |
| 44 | Agent-report triage (ISS-113) keeps its outcome on the report row (`packages/core/src/db/schema-agent-reports.ts:agentReports`, triage columns): a reopen clears it and a later triage overwrites it, with no row per decision, so a re-triaged report loses who decided before; writes serialise on a row lock (`packages/core/src/agent-reports/service.ts:triageReports`), not an advisory lock; reports migrated by 0368 carry no `triaged_by` | ISS-116 (the report History tab) |

## Honest costs

| Choice | What it costs |
|---|---|
| One 422 for every rule refusal | A client can no longer branch on 403 for who-may-act, and has to read `error.code`; the requirement sign-off and design approval moved from 403 to 422 in this change |
| One declaration in contracts, compiled | Core's start depends on `@forge/contracts` being built first; a contracts edit rebuilds before core typechecks |
| Agency in one module | A slice that needs a new standing (for example a steward org admin) extends `ActRule` for everyone, rather than writing its own `if` |
| `max+1` keys under the entity lock | A keyed row can never be hard-deleted, or its number is reissued |
| Forty listed divergences left in place | Until the review pass, two patterns are live for each of them, and a new slice must copy the reference, not the nearest file |
