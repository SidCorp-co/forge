# Core modules: one build pattern (pattern v2)

The owner ruled on 2026-10-03 that every build gets a clearly defined schema and a clear pattern,
not a style per place, and on 2026-10-04 that the logic was not clean and the build pattern not
stable ("Logic tôi thấy chưa sạch sẽ và build pattern chưa ổn"). This page is the one build
pattern for every module of `packages/core/src`, and for the contracts and web modules that serve
it. It is a root of the reconciliation checklist
([design-is-the-root…](../proposals/design-is-the-root-and-code-is-reconciled-to-it.md)), beside
requirements and workflow designs.

- **Each rule is a business criterion of REQ-12** (revision 3), cited as *BC-n* beside its heading,
  so a verdict or a Wrong marker can name the rule it judges.
- **Why each rule exists** is in [ADR 0008](../adr/0008-module-kinds-and-dependency-direction.md).
  This page says only what to build.
- **Code that breaks a rule is Wrong**, and is rebuilt to the rule rather than patched.
  `scripts/check-module-shape.mjs` measures the rules a script can read, and `--markers` writes its
  findings as Wrong markers. The orchestrator or QA runs it on demand; nothing runs it before a
  push. There is no hand-kept list of divergences on this page.
- **The API comes first.** The CLI wraps the routes, and MCP keeps only what neither covers
  ([api-first.md](../proposals/destination/api-first.md)), so every rule below is stated for the
  route first.
- **Code only on dev, QA later.** On dev the only check before a push is `tsc --noEmit` on the
  packages a change touched. Tests, verify, checkers and CI are not run while building; QA is a
  later phase (owner, 2026-10-04: "build trước đi đã test gọi QA test sau").

## Module kinds (BC-11)

Every directory under `packages/core/src` is exactly one kind, declared in
`packages/core/src/modules.json`. A nested path is a module of its own when the file declares it
(each `integrations/<port>`). The root files (**index.ts** and its siblings) are the module `(root)`,
a door.

| Kind | Holds | Must not |
|---|---|---|
| **kernel** | The job, session, run and issue machines, the transition engine, leases, evidence and records, retry, escalation, the outbox | Hold a product rule; call an adapter |
| **domain** | One product entity family: requirements, feedback, release, chat, and so on | Compute a fact another module also computes |
| **read-model** | Derived facts only: standing, waiting-on, needs-you, coverage, counts, the system graph | Write any table |
| **adapter** | One external system behind a role-named port ([ADR 0006](../adr/0006-every-external-system-is-reached-through-one-adapter-port.md)) | Import a domain, a kernel module or a read model |
| **door** | The route-mount registry, the MCP registry, WebSocket, inbound webhooks, the CLI shapes | Hold a rule or a query |
| **platform** | The db client and schema, `lib`, middleware, queue, config, observability | Import any other kind |

## Dependency direction (BC-12)

```text
door ──▶ read-model ──▶ domain ──▶ kernel ──▶ platform
                          │
                          └──▶ adapter (port index only) ──▶ platform
```

| Kind | May import |
|---|---|
| door | door, read-model, domain, kernel, platform |
| read-model | read-model, domain, kernel, platform |
| domain | domain, kernel, adapter, platform |
| kernel | kernel, platform |
| adapter | adapter, platform |
| platform | platform |

- **Nothing points back up.** The schema and `lib` import no domain; a kernel module never imports
  the domain that reacts to it.
- **No cycle between modules.** Two modules that need each other both ways are one module, or one
  of them reacts to the other's outbox event.
- **Inbound vendor traffic** (a webhook, a chat socket, a poll) enters through a door and calls the
  module that owns the effect. The adapter only speaks the vendor's protocol.
- **A domain that gates on a derived fact** applies the fact's predicate from contracts to its own
  rows; it does not import the read model.

## Public face (BC-13)

- Each kernel, domain, read-model, adapter and door module has exactly one **index.ts**. It exports
  the module's services, read functions, types, `routes` and, when it has one, `tool`, and nothing
  else.
- Another module imports that **index.ts** and never a file behind it.
- Platform modules are leaves and are imported file by file.

## Module layout

One file per responsibility, under `packages/core/src/<module>/`. The references are
`packages/core/src/suggestions/` and `packages/core/src/requirements/`.

| File | Holds | Must not |
|---|---|---|
| **rules.ts** | Pure guards over what the service read; each returns `<Module>Refusal \| null` or a list | Touch the DB, throw a refusal |
| **read.ts** | `rowIn(tx, projectId, ref)`, list and detail views, the actor type | Write |
| **service.ts** | Writes. Each runs in one transaction under the entity's advisory lock (`packages/core/src/requirements/service.ts:lockRequirements`) and returns `{ ok: true, … } \| { ok: false; refusals }` | Throw a refusal. It throws only a 404 and invariant `Error`s |
| **standing.ts** | The module's derived facts, when it has any, typed by its contracts standing shape | Write |
| **events.ts** | The outbox events this module emits, typed in contracts | Emit an event no module consumes |
| **routes.ts** | Hono routes: param validators, `strictBody`, the actor, `answer` | Hold a rule or a database call (BC-15) |
| **tool.ts** | The MCP door, only when an agent needs what the CLI and the API do not cover (BC-21) | Re-implement a rule |
| **index.ts** | The public face (BC-13) | Mount anything |

- **Routes hold no queries (BC-15).** A route file validates, calls one service or read function,
  and answers. A `db` or `tx` call in a route file is a finding.
- A route's prefix is in `packages/core/src/auth/pat-permissions.ts:PAT_PERMISSION_RESOURCES`, so a
  token can be granted it.

## Doors: REST first, the CLI over it, MCP only where neither serves (BC-21)

The owner ruled on 2026-10-04 that MCP is slimmed: "cái nào cli thay thế được và nên dùng API hơn
và CLI hơn thì không cần MCP".

- **The REST API is the primary door.** Every act and every read is a route first.
- **The CLI is built over the API.** A CLI verb calls a route and adds nothing the route does not
  answer; a verb and a route with the same name accept the same filters. The generated API
  reference (`packages/core/src/api-contract/`) is where a difference shows.
- **MCP keeps only what an agent needs and neither the CLI nor the API covers.** A tool that only
  re-wraps a route the CLI already reaches is removed, not migrated.
- **A tool that stays is one tool per resource with an `action` enum** whose verbs match the
  routes, lives in its module (**tool.ts**), and calls the same service and read functions as the
  route. Its input is one `z.strictObject`; it declares `grant`, `reach` and `route`, and both doors
  refuse a call through `packages/core/src/mcp/tool-call-guard.ts:toolCallRefusal`.
- **One route-mount registry** in the HTTP door mounts every module's exported `routes`, and one MCP
  registry registers the remaining tools. Nothing else mounts a router: today's `.route()` calls in
  `packages/core/src/index.ts` and the slice mounts in `packages/core/src/project-config/mount.ts`
  and `packages/core/src/issues/mount.ts` move there.
- **Answers.** A list answers summaries and a write answers what it changed: `act`, the entity's
  head, and the relation or revision it touched. A whole document comes only from `get` or
  `view: 'full'`, with the summary field set declared in contracts beside the full shape
  (`packages/contracts/src/requirements.ts:REQUIREMENT_SUMMARY_FIELDS`).

## Where each schema lives

| Shape | Lives in | Reference |
|---|---|---|
| Table, CHECKs, indexes | `packages/core/src/db/schema-<x>.ts`, one file per entity family, listed in `packages/core/drizzle.config.ts` | `packages/core/src/db/schema-suggestions.ts:suggestions` |
| Enum values (`as const`) including kernel statuses, refusal codes, request schemas, response shapes, limits, status machines, event types | `packages/contracts/src/<module>.ts`, compiled (`tsconfig.emit.json`) and exported at `@forge/contracts/<module>` | `packages/contracts/src/suggestions.ts:SUGGESTION_STATUSES`, `:SUGGESTION_REFUSAL_CODES`, `:createSuggestionRequestSchema`, `:SuggestionView` |
| The refusal body | `packages/contracts/src/refusal.ts:RefusalEnvelope` | `packages/web-v2/src/lib/api/refusals.ts:namedRefusals` |
| Web types | `packages/web-v2/src/features/<module>/types.ts`, re-exporting from contracts plus UI-local unions | `packages/web-v2/src/features/suggestions/types.ts` |

- **One declaration.** The DB column reads the contracts array: `text('status', { enum: X })` plus
  a `check()` built from the same array. A second copy held equal by a parity test is Wrong.
- **Runtime imports.** A contracts subpath core imports at runtime resolves to compiled JS.

## Tables (BC-14)

- **One owner.** Every table is listed under exactly one module's `owns` in
  `packages/core/src/modules.json`. Only that module inserts, updates or deletes its rows, by
  drizzle or raw SQL. Another module reads through the owner's read functions and writes by
  calling the owner's service.
- **Ids and scope.** A `uuid` primary key and `project_id` NOT NULL referencing `projects` with
  `on delete cascade`, or `issue_id` the same way for an issue-scoped row. Every list index leads
  with that scope column.
- **Enums.** `text` plus a CHECK built from the contracts array. No `pgEnum`, and no free text.
- **Timestamps.** `timestamp with time zone`. `created_at` is NOT NULL with a default of now. Each
  act gets `<act>_at`, nullable with no default.
- **Actors.** `<act>_by uuid` references `users` `on delete restrict`. An act either a person or an
  agent may take also records `<act>_agency text`, CHECK `('human','agent')`, the values of
  `packages/core/src/issues/actor-agency.ts:ActorAgency`. The word is `human`, never `person`. No
  rule reads it (BC-20).
- **Immutability.** A trigger enforces it and raises a named error. A revision row is deleted only
  with its owning entity's cascade, and its content is editable only while it is `draft`
  (`requirement_revision_guard()` in
  `packages/core/drizzle/migrations/0349_a_requirement_has_a_home.sql`). A baseline, decision or
  verdict row is insert-only.
- **Keyed rows are never deleted.** They move to a terminal status.
- **A declared state that no act writes** (a status nothing sets, a pin column nothing fills) is
  built or removed in the change that finds it.

## Requests

- **Body.** `packages/core/src/middleware/zod-validator.ts:strictBody(schema, SHAPE)`. The schema is
  a `z.strictObject` from contracts, and `SHAPE` is the valid shape as a string declared beside it
  (`packages/contracts/src/suggestions.ts:CREATE_SUGGESTION_SHAPE`).
- **What a bad body gets.** `400 BAD_REQUEST` with message `invalid body: <SHAPE>` and
  `details: { formErrors, fieldErrors }`.
- **Path and query.** `zValidator('param' | 'query', schema, hook)`, whose hook throws 400 naming
  what the path or query holds.

## Refusals (BC-16)

A write a rule refuses answers **422** with one body, and nothing is written:

```json
{ "error": { "code": "<the code, or <MODULE>_REFUSED when several differ>",
             "message": "refused, nothing written: <CODE> at <path>; …",
             "refusals": [{ "code": "…", "path": "/json/pointer or ''", "detail": "…" }] } }
```

- **Both doors** build it with `packages/core/src/lib/refusal.ts:refusalEnvelope`: REST through
  `packages/core/src/project-config/respond.ts:refused` (moving into platform beside the envelope),
  MCP through `packages/core/src/mcp/tools/lib.ts:refusedAnswer`, flagged `isError`.
- **A service returns its refusals; it never throws them.** A guard that runs before the service
  throws `packages/core/src/lib/refusal.ts:RefusalError`, which `packages/core/src/middleware/error.ts`
  answers with the same body.
- **A rule refusal is never an error class, an `HTTPException` or thrown text.** 400 (request
  shape), 401 and 403 (no session, no membership, a fenced token) and 404 (a row the caller cannot
  see, named by its ref) are transport and come from validators, middleware and `rowIn`. Release
  blockers, criteria, verdicts, record events, questions and permission refusals are the envelope.
- **Codes.** `<MODULE>_<WHAT>`, upper snake case, declared as an `as const` array in contracts and
  never in core. A permission refusal ends `_FORBIDDEN`.
- **Detail** names what was wrong and what is valid, and names another entity by its key (`REQ-3`),
  never by uuid.

## Status machines (BC-17)

- **A status machine is data**: `packages/contracts/src/<x>-machine.ts` declares
  `{ states, edges: [{ from, to, act, permission, guards }] }`, checked against the approved
  state-machine design of the same name, and every machine is listed in
  `packages/contracts/src/machines.ts:MACHINES`. The status column's CHECK holds its `states`.
- **Only the kernel transition writes a status**, for every machine: the edge's guards, a
  compare-and-set on the row, and one `kernel_transitions` record, in one transaction
  (`packages/core/src/lifecycle/transition.ts:transition`); the outbox event is written at its
  `emitTransitionEvents` hook. A status set anywhere else is a finding; an adapter's own delivery
  status is the one exception, because an adapter imports no kernel module.
- **A derived phase is a read-model value**: computed in one function, never stored, never a SQL
  view plus a TypeScript override.
- **A retired value is refused by name.** The kernel never maps an old status onto a new one; the
  17-to-10 legacy issue status map is deleted (owner, 2026-10-04), and kernel input naming a
  legacy status is refused `ISSUE_STATUS_LEGACY`
  (`packages/contracts/src/issue-machine.ts:issueStatusLegacyRefusal`).

## Records and events (BC-18)

- **Issue-scoped facts** are typed `record.<kind>` events in `activity_log`, written by
  `packages/core/src/issues/record-events/store.ts:writeRecordEvent`, their kinds in
  `packages/contracts/src/record-events.ts:RECORD_EVENT_KINDS`. Kernel evidence (a transition, a park,
  a verdict, `packages/contracts/src/record-events.ts:KERNEL_ONLY_RECORD_KINDS`) is written only by core
  in the act's transaction (`packages/core/src/issues/record-events/store.ts:writeKernelRecord`); a
  caller posting one is refused `EVENT_KIND_KERNEL_ONLY`.
- **Revisioned entities** audit in their own rows: `<act>_by` / `<act>_at` / `reason` on the revision
  or decision row. A decision that can happen more than once gets a row per decision
  (`packages/core/src/db/schema-feedback.ts:feedbackDecisions`); overwriting the last one loses
  history.
- **A fact another module reacts to is an outbox event**, written in the act's transaction to the
  one durable outbox (`packages/core/src/db/schema.ts:pipelineOutbox`) and typed in contracts. The
  in-memory bus (`packages/core/src/pipeline/hooks.ts:HooksBus`) is retired.
- **An event nobody consumes is not emitted**, and a subscription to an event nobody emits is
  removed. Each event node of an approved design maps to an event kind or to "the row is the
  record".
- **One act yields one record and at most one event**, not a record plus an activity row plus an
  outbox row plus a push. A WebSocket push is a consumer of the event.
- **Comments on other entities** sit on exactly one of issue | requirement | workflow | feedback
  (`comments_scope_chk`), with a `packages/core/src/db/schema-comments.ts:commentEvents` row per post
  and edit.

## Read models (BC-19)

- **Every derived fact a screen or an agent reads** (standing, waiting-on, counts, coverage,
  changed-since-plan, passing, needs-you, the system graph) has one function in one core read
  model, answering one shared contracts shape. The reference is `packages/core/src/runs/`, whose
  `packages/core/src/runs/read.ts:listRunStanding` answers `packages/contracts/src/run-standing.ts`.
- **A predicate is declared once**, in contracts, and both the read model and any gate apply that
  one predicate.
- **web-v2 renders; it computes no domain fact.** A feature's **derive.ts** may format, sort and
  group what a read model answered, and nothing more.

## Permissions (BC-20)

- **One check**: `can(actor, permission, scope)` over the actor's project role and token grant.
  Each route and tool action declares its permission in contracts, and REST and MCP read the same
  declaration.
- **Approval is a permission**
  ([ADR 0007](../adr/0007-approval-is-a-permission.md)): every approve-type act asks
  `packages/core/src/lib/approval.ts:mayApprove` and refuses with
  `packages/core/src/lib/approval.ts:approvalRefusal`. No rule refuses an actor for being an agent,
  for being a person or for being the author; whoever holds the permission acts. The other
  who-may-act checks (project roles in `lib/authz`, token grants, the MCP principal checks) move
  onto the same `can()`.
- **A slice never compares `agency`.** Agency is recorded on the row and read by no rule.

## External systems (BC-22)

Every external system is reached through one adapter port under
`packages/core/src/integrations/<port>/`, named by role, never by vendor
([ADR 0006](../adr/0006-every-external-system-is-reached-through-one-adapter-port.md)). The ports,
their vendors and their callers are in `packages/core/src/integrations/README.md`.

- **A domain imports the port's index.ts.** It never imports a vendor directory, a vendor SDK, a
  vendor's types, or calls the global `fetch`; `scripts/check-provider-literals.mjs` refuses the
  last two outside `packages/core/src/integrations/`.
- **An adapter imports no domain, kernel module or read model.** What the vendor sends back enters
  through a door.
- **Both adapter shapes are legal**: a project-bound port is reached through
  `packages/core/src/integrations/registry.ts` with its credential in the vault; a deployment-bound
  port reads its configuration from the environment and exports plain functions.
- **A credential handed to an agent session** (an MCP endpoint and key) is a declared egress
  surface.
- **A new system gets a port first**, with a row in the integrations README.

## Revisions: one vocabulary

An authored entity that changes under review is a **head** row plus immutable **revision** rows
numbered 1..n.

- Each revision carries one state: `draft → proposed → current → superseded`.
- `current` is what was approved. The head points at it (`current_revision`), and the previous
  current becomes `superseded` in the same write.
- Approve, return and accept are **decisions**, not states. A return sends `proposed` back to
  `draft`, with its reason and decider recorded.
- The reference is `packages/core/src/db/schema-requirements.ts:REVISION_STATES`, enforced by
  `requirement_revision_guard()`. A workflow design moves onto revision rows.
- A contract version is *recorded*, not authored, so it keeps `proposed`, `approved` and
  `returned` (`packages/core/src/ecosystem/contract/approval.ts:CONTRACT_APPROVALS`); a reader maps
  `approved` to `current`.

## Keys

- **Shape.** A human key reads `<PREFIX>-<n>`. `n` is an `integer` `<x>_seq` column, unique per
  `(project_id, <x>_seq)`.
- **Format and resolve.** A formatter builds the key (`packages/core/src/requirements/read.ts:requirementKey`,
  `packages/core/src/lib/issue-ref.ts:formatIssueRef`). `rowIn` resolves a uuid, a key or a bare
  `n`, and answers 404 naming the ref (`packages/core/src/requirements/read.ts:rowIn`).
- **Allocation.** `max(seq)+1` inside the entity's advisory-locked transaction
  (`packages/core/src/requirements/revision-write.ts:createRequirementIn`), safe because keyed rows
  are never deleted. ISS-n keeps its counter row and trigger
  (`packages/core/src/db/schema.ts:projectIssCounters`).

## Language of stored text

- **Prose follows the project.** A column an agent writes for people to read is written in the
  project's content language (`packages/contracts/src/content-language.ts:contentLanguageOf`,
  absent is `en`). Technical terms stay English inside it.
- **Machine-read text never does.** Enum values, refusal codes, keys, field names, status names,
  `file:symbol` citations, Forge's own `detail`, code, commits and branch names are English.
- **Told, not checked.** Nothing refuses a write for its language. Every prompt that writes prose
  appends `packages/core/src/content-language/block.ts:contentLanguageBlock`.

## Data policy (sensitive projects)

A project's document carries `sensitiveData`, one of
`packages/contracts/src/data-policy.ts:SENSITIVE_DATA_LEVELS` (`off`, `redact`, `no_egress`; absent
means `off`).

- **One rule.** Every read that hands content to an agent or a provider passes
  `packages/core/src/lib/data-egress.ts:egressDeep(project, surface)`, and each surface declares its
  class once, in `packages/core/src/lib/data-egress.ts:EGRESS_SURFACES`; an undeclared surface is
  refused `EGRESS_SURFACE_UNDECLARED`. **product** content is read at every level, scrubbed at
  `redact` and `no_egress`; **operational** content is scrubbed at `redact` and withheld at
  `no_egress` (`CONTENT_EGRESS_FORBIDDEN`).
- **On write.** At `redact` and `no_egress`, stored free text is scrubbed first
  (`packages/core/src/lib/data-egress.ts:storedText`).
- **Embeddings.** `packages/core/src/embeddings/item-writer.ts:writeItemEmbedding` is the one
  writer; a withheld item is recorded as `withheld_by_policy`.
- **LLM and embedding ports gate inside the adapter**, taking a
  `packages/core/src/lib/data-egress.ts:EgressScope`.

## Web module

- **Files.** `packages/web-v2/src/features/<module>/` holds **api.ts** (fetchers over `apiClient`),
  **hooks.ts** (React Query), **types.ts** (re-exports from contracts), **routes.ts** when it owns
  pages, and **components/**. The reference is `packages/web-v2/src/features/suggestions/`.
- **Derived facts come from a core read model** (BC-19); a feature computes none.
- **Refusals** render through `packages/web-v2/src/lib/api/refusals.ts` (`refusalsOf`,
  `namedRefusals`).
- **Badges.** An enum's labels, tones, glyphs and hints are declared in contracts beside the enum
  (`packages/contracts/src/issue-vocabulary.ts:ISSUE_STATUS_TONES`, or
  `packages/contracts/src/ui-vocabulary.ts:STATE_READINGS` for an enum core declares), and drawn
  with `packages/web-v2/src/design/primitives/enum-badge.tsx:StatusBadge` or `:EnumBadge`. A
  feature declares no colour map and no second badge primitive.

## Compat amnesties

A compatibility path carries one comment naming its issue, the condition that ends it and what is
traded, `ISS-<n> until:<condition> — <what is traded>`, on the code that is deleted when the
condition holds. Nothing in this repo checks the form of a comment.

## Template: a new module

Take feedback (`FB-n`) as the example, under `packages/`.

```text
contracts/src/feedback.ts         FEEDBACK_STATUSES, FEEDBACK_REFUSAL_CODES, limits, request schemas
                                  + their SHAPE strings, views, events, the machine if it has one
core/src/db/schema-feedback.ts    the tables; each listed under feedback's `owns` in modules.json
core/src/modules.json             "feedback": { "kind": "domain", "owns": [...] }
core/src/feedback/rules.ts        pure guards → FeedbackRefusal | null
core/src/feedback/read.ts         rowIn (uuid | FB-n | n), feedbackKey, list and detail views
core/src/feedback/service.ts      lockFeedback; createFeedback / declineFeedback → Outcome
core/src/feedback/standing.ts     its derived facts, if any, in the contracts standing shape
core/src/feedback/events.ts       the outbox events it emits, each with a consumer
core/src/feedback/routes.ts       strictBody(...); answer(outcome) → refused | c.json(view)
core/src/feedback/tool.ts         only if an agent needs what the CLI and API do not cover
core/src/feedback/index.ts        { routes, tool, services, read functions, types }
web-v2/src/features/feedback/     api.ts, hooks.ts, types.ts, routes.ts, components/
```

## Honest costs

| Choice | What it costs |
|---|---|
| One kind per directory and a direction | Most of core breaks it on the first reading; every module is rebuilt through the reconciliation flow rather than refactored in place, and a rebuild loses what the old code handled that no rule or design stated |
| One index.ts per module | A barrel per module, and an internal import that used to be free is now a finding until the module exposes it |
| One owner per table | A cross-module write becomes a call into the owner's service, one more function and one more transaction boundary to get right |
| The machine as data and one kernel transition | Every status write in core moves into one engine, and a slice can no longer set its own status in a one-line update |
| One durable outbox | Every reaction is asynchronous and survives a crash, at the price of a table write per event and a consumer that must be idempotent |
| One 422 for every rule refusal | A client reads `error.code` and never branches on 403 or 409 |
| The checker runs on demand, not before a push | New code can break a rule and land; the break shows only when the orchestrator or QA next runs the checker |
