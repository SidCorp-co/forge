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
- **Code that breaks a rule is Wrong**, and is rebuilt to the rule rather than patched. There is
  no hand-kept list of divergences on this page.
- **The import rules block.** `scripts/check-module-boundaries.mjs` runs dependency-cruiser over
  `packages/core/src` with rules generated from `packages/core/src/modules.json`: context direction,
  kind direction, runtime cycles between modules, face-only access, adapters through their port,
  and read models SELECTing only the tables they declare under `reads`.
  Today's violations are frozen in `.forge/module-boundaries-baseline.json`; a new violation, an
  entry that no longer occurs, or a rule whose frozen count rose fails, so the baseline only
  shrinks. It runs in `pnpm verify` and CI.
- **The semantic rules block too.** `scripts/check-module-shape.mjs` refuses a declaration that
  contradicts itself, then runs the type-aware ESLint rules in `scripts/eslint-module-shape/`: a
  write to a table outside its owner module (any receiver typed as a Drizzle database or
  transaction, any value typed as the table, raw SQL naming it), a database call in a route file, a
  refusal built outside `packages/core/src/lib/refusal.ts`, and the global `fetch` outside an
  adapter. Today's violations are frozen in `.forge/module-shape-suppressions.json` (ESLint bulk
  suppressions): a new violation, an entry that no longer occurs, or a rule whose frozen total rose
  fails. It runs in `pnpm verify` and CI; `--markers` writes every finding as Wrong markers. A
  status written outside the kernel is not linted: the database refuses it (Status machines,
  below).
- **The API comes first.** The CLI wraps the routes, and MCP keeps only what neither covers
  ([api-first.md](../proposals/destination/api-first.md)), so every rule below is stated for the
  route first.
- **Code only on dev, QA later.** On dev the only check before a push is `pnpm tc:changed`
  (`scripts/tc-changed.mjs`), which typechecks the packages a change touched and their importers. Tests, verify, checkers and CI are not run while building; QA is a
  later phase (owner, 2026-10-04: "build trước đi đã test gọi QA test sau").

## Business contexts

Every module also belongs to one **context**, declared as `context` on its entry in
`packages/core/src/modules.json`. The contexts are listed once, in order, under `contexts` in the
same file; each carries the name of its root module label on the Forge project (`label`). Ten are
business contexts and two are technical layers.

| # | Context | Label | Holds |
|---|---|---|---|
| 1 | `platform` | Platform | Every platform-kind module, the outbox, and the three composition doors: the root, `mcp`, `ws` |
| 2 | `adapters` | Adapters | Every adapter (each `integrations/<port>`, the registry, `git`, `storage`) and the integration door |
| 3 | `access` | Identity & access | Sign-in and users (`auth`), orgs, the permission kernel, install |
| 4 | `project-config` | Projects & config | Projects, the project document and its revisions, assistant settings, preferences |
| 5 | `knowledge` | Knowledge | Knowledge entries and edges, memory, item embeddings, guides, onboarding |
| 6 | `work` | Work & delivery | Issues, the transition engine, the pipeline, comments, tasks, questions, PM reads, labels, uploads, error intake |
| 7 | `execution` | Execution | Sessions, jobs, runs, masters, runners, devices, prompts, skills, schedules, usage records |
| 8 | `design` | Product design | Requirements, workflow designs, mockups, suggestions, feedback |
| 9 | `release` | Release & deploy | Release batches |
| 10 | `ecosystem` | Ecosystem | Ecosystems, contracts, channels, inbound webhooks |
| 11 | `conversations` | Conversations | The assistant, conversations, notifications |
| 12 | `operations` | Operations | Metrics, health, the admin views |

- **Direction between contexts comes first.** A module imports modules of its own context or of a
  context listed above it in this table, never one listed below it. The order is the reading of
  the real import graph: each context sits above the contexts it imports most, and every import
  that runs the other way is a back edge to cut (ADR 0008, Amendment of ISS-184).
- **A door is exempt from context direction**, because a door is an entry that composes contexts.
  Its kind still holds: only a door imports a door.
- **The technical layers are defined by kind.** A platform-kind module is in `platform`, an
  adapter is in `adapters`, and neither layer holds a domain or a read model.
- **Work is upstream of execution.** A job carries out an issue's step and moves the issue through
  the work kernel's transition, so execution imports work. Work learns what execution did from
  execution's outbox events; the pipeline does not call into jobs, sessions or runners.
- **Inside a context the six kinds are the rule.** A context is rebuilt to the kinds as one unit.

## Module kinds (BC-11)

Every directory under `packages/core/src` is exactly one kind, declared in
`packages/core/src/modules.json`. A nested path is a module of its own when the file declares it
(each `integrations/<port>`). The root files (**index.ts** and its siblings) are the module `(root)`,
a door.

| Kind | Holds | Must not |
|---|---|---|
| **kernel** | The job, session, run and issue machines, the transition engine, leases, evidence and records (a job's usage records among them), retry, escalation, the outbox, and memberships with their roles and grants (the permission kernel's own data) | Hold a product rule; call an adapter |
| **domain** | One product entity family: requirements, feedback, release, chat, users and sign-in, and so on | Compute a fact another module also computes |
| **read-model** | Derived facts only: standing, waiting-on, needs-you, coverage, counts, the system graph | Write any table but its own projection; SELECT a table its `reads` does not declare |
| **adapter** | One external system behind a role-named port ([ADR 0006](../adr/0006-every-external-system-is-reached-through-one-adapter-port.md)) | Import a domain, a kernel module or a read model |
| **door** | The route-mount registry, the MCP registry, WebSocket, inbound webhooks, the API contract generator, and the integration door (a provider's routes and MCP tools, which reach its adapter through the port) | Hold a rule or a query |
| **platform** | The db client and schema, `lib`, middleware, queue, config, observability, the credential helpers (`credentials`) | Import any other kind |

**Who owns tables.** A kernel, a domain, an adapter or a platform module may own tables; a read
model owns none but the projection tables it declares under `projections` (BC-19), and a door owns
none. An adapter owns only its own bookkeeping with the vendor (connections,
deliveries, mirrored vendor state), never a product entity. A platform module owns only its own
bookkeeping (backfill markers, tokens, the embedding index).

## Dependency direction (BC-12)

```text
door ──▶ read-model ──▶ domain ──▶ kernel ──▶ platform
  │                       │
  └───────────────────────┴──▶ adapter (port index only) ──▶ platform
```

| Kind | May import |
|---|---|
| door | door, read-model, domain, kernel, adapter (port index only), platform |
| read-model | read-model, domain, kernel, platform; an owner's read files for a table it declares under `reads` |
| domain | domain, kernel, adapter, platform |
| kernel | kernel, platform |
| adapter | adapter, platform |
| platform | platform |

- **Nothing points back up.** The schema and `lib` import no domain; a kernel module never imports
  the domain that reacts to it.
- **No cycle between modules.** Two modules that need each other both ways are one module, or one
  of them reacts to the other's outbox event. A cycle counts only runtime imports: a type-only
  import is erased at build and a dynamic import evaluates on call, so neither orders module
  loading.
- **Inbound vendor traffic** (a webhook, a chat socket, a poll) enters through a door and calls the
  module that owns the effect. The adapter only speaks the vendor's protocol.
- **A domain that gates on a derived fact** applies the fact's predicate from contracts to the input
  the fact's one input-builder answers (BC-19), inside its own write transaction; it does not import
  the read model.

## Public face (BC-13)

A face is split in two, because importing a file evaluates everything it imports: a constant read
through a face that also builds routers loads every service, and inside an import cycle that order
throws "Cannot access X before initialization" (ISS-168).

- **The light face.** Each kernel, domain, read-model, adapter and door module has exactly one
  **index.ts**. It exports the module's services, read functions and types, and nothing else. It
  constructs nothing at import: no router, no tool, no timer, no registration.
- **The heavy face.** A module's routers are exported from its **routes.ts** and its MCP tools from
  its **tool.ts**. Only `packages/core/src/route-registry.ts` imports a **routes.ts**; only the two
  tool registries import a **tool.ts**: `packages/core/src/mcp/registry.ts` and the assistant's
  chat toolset (`packages/core/src/assistant/tools/registry.ts:CHAT_TOOL_ALLOWLIST`).
- **A module whose face is empty says so.** A module that offers other modules nothing has an
  **index.ts** of `export {};`; another module's import of its internals is then a finding.
- Another module imports the **index.ts** and never a file behind it.
- **Shared constants and types come from `@forge/contracts`**, not through a core face.
- **A type-only edge is written `import type`.** Core and contracts compile with
  `verbatimModuleSyntax`, so a type import is erased and only a value import is a runtime edge.
- Platform modules are leaves and are imported file by file.

## Module layout

One file per responsibility, under `packages/core/src/<module>/`. The references are
`packages/core/src/suggestions/` and `packages/core/src/requirements/`.

| File | Holds | Must not |
|---|---|---|
| **rules.ts** | Pure guards over what the service read; each returns `<Module>Refusal \| null` or a list | Touch the DB, throw a refusal |
| **read.ts** | `rowIn(tx, projectId, ref)`, list and detail views, the actor type | Write |
| **service.ts** | Writes. Each runs in one transaction under the entity's advisory lock, taken with `packages/core/src/lib/advisory-lock.ts:lockXact` in the entity's own namespace from `LOCK_NAMESPACES` (`packages/core/src/requirements/service.ts:lockRequirements`) and returns `{ ok: true, … } \| { ok: false; refusals }` | Throw a refusal. It throws only a 404 and invariant `Error`s |
| **standing.ts** | The module's derived facts, when it has any, extending `packages/contracts/src/standing.ts:Standing` | Write |
| **events.ts** | The outbox events this module emits, typed in contracts | Emit an event no module consumes |
| **routes.ts** | Hono routes: param validators, `strictBody`, the actor, `answer`. It is the heavy face: every router the module serves is exported from it | Hold a rule or a database call (BC-15); be imported by anything but the route registry |
| **tool.ts** | The MCP door, only when an agent needs what the CLI and the API do not cover (BC-21) | Re-implement a rule; be imported by anything but the two tool registries |
| **index.ts** | The light face (BC-13): services, read functions, types | Mount anything; export a router or a tool; construct anything at import |

- **Routes hold no queries (BC-15).** A route file validates, calls one service or read function,
  and answers. A call on any value typed as a Drizzle database or transaction in a route file is
  <!-- doc-citation: unchecked `routes.ts` `routes/` — file-name patterns, not paths in this tree -->
  refused (`scripts/eslint-module-shape/rules/route-query.mjs`). A route file is one named
  `routes.ts`, `*-routes.ts` or under `routes/`, and any other file that builds a Hono router
  (`scripts/lib/module-shape.mjs:isRouteFile`).
- A route's prefix is in `packages/core/src/credentials/pat-permissions.ts:PAT_PERMISSION_RESOURCES`, so a
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
  refuse a call through `packages/core/src/lib/tool-call-guard.ts:toolCallRefusal`.
- **One route-mount registry** in the HTTP door mounts the routers each module's **routes.ts**
  exports (`packages/core/src/route-registry.ts:mountRoutes`), and one MCP registry registers the
  remaining tools from each module's **tool.ts** (`packages/core/src/mcp/registry.ts:MCP_TOOLS`, keyed by
  `packages/contracts/src/mcp-tools.ts:MCP_TOOL_NAMES`). Nothing else mounts another module's
  router; `packages/core/src/index.ts` only boots.
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
  drizzle or raw SQL. Another module writes by calling the owner's service, and reads through the
  owner's read functions, except a read model, which SELECTs the tables it declares (BC-19).
- **Ids and scope.** A `uuid` primary key and `project_id` NOT NULL referencing `projects` with
  `on delete cascade`, or `issue_id` the same way for an issue-scoped row. Every list index leads
  with that scope column.
- **Enums.** `text` plus a CHECK built from the contracts array. No `pgEnum`, and no free text.
- **Timestamps.** `timestamp with time zone`. `created_at` is NOT NULL with a default of now. Each
  act gets `<act>_at`, nullable with no default.
- **Actors.** `<act>_by uuid` references `users` `on delete restrict`. An act either a person or an
  agent may take also records `<act>_agency text`, CHECK `('human','agent')`, the values of
  `packages/contracts/src/permissions.ts:ActorAgency`. The word is `human`, never `person`. No
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
- **What a bad body gets.** `400 BAD_REQUEST` in the refusal envelope: `detail` is
  `invalid body: <SHAPE>` and each zod issue is a refusal at its JSON pointer
  (`packages/core/src/lib/refusal.ts:requestRefusals`).
- **Path and query.** `zValidator('param' | 'query', schema, hook)`, whose hook throws 400 naming
  what the path or query holds; a validator with no hook answers the same 400 envelope
  (`packages/core/src/middleware/zod-validator.ts:zValidator`).

## Refusals (BC-16)

A refused write answers one body, served as `application/problem+json` (RFC 9457), and nothing is
written:

```json
{ "type": "urn:forge:refusal:<code>", "title": "<Code in words>", "status": 422,
  "detail": "<the leading refusal's detail>",
  "error": { "code": "<the code, or <MODULE>_REFUSED when several differ>",
             "message": "refused, nothing written: <CODE> at <path>; …",
             "refusals": [{ "code": "…", "path": "/json/pointer or ''", "detail": "…" }] } }
```

- **The status says what the client should do**, and each code's status is declared once, in
  contracts beside the code (`packages/contracts/src/refusal.ts:RefusalStatuses`, collected by
  `packages/contracts/src/refusal-statuses.ts:refusalStatusOf`): **400** the request shape (fix
  the request); **403** every `_FORBIDDEN` code without listing it, and a permission refusal
  named otherwise (stop); **404** a row the caller cannot see; **409** a lost compare-and-set or
  lease, such as `STALE_TRANSITION`, `STALE_BASE`, `*_REVISION_STALE`, `NO_HOLDER`,
  `ISSUE_LEASE_HELD` (re-read and retry); **422** every other rule.
- **`refusals[]` is ordered most relevant first**: by status in the order 403, 404, 400, 409,
  422, and in the service's own order within one status. The envelope's `status` and `detail`
  are the leading refusal's.
- **`error.code` and `refusals[]` stay the contract.** `type`, `title`, `status` and `detail` are
  the RFC 9457 members beside them; an error that is not a refusal (401, a 404 from `rowIn`, a
  5xx) carries the same four members beside its `code`, `message` and `details`.

- **Both doors** build it with `packages/core/src/lib/refusal.ts:refusalEnvelope`: REST through
  `packages/core/src/lib/refusal.ts:refused`, under the module's `<MODULE>_REFUSED` fallback code,
  MCP through `packages/core/src/lib/tool.ts:refusedAnswer`, flagged `isError`.
- **A service returns its refusals; it never throws them.** A guard that runs before the service
  throws `packages/core/src/lib/refusal.ts:RefusalError`, built by the module's typed
  `packages/core/src/lib/refusal.ts:refuser`, which `packages/core/src/middleware/error.ts`
  answers with the same body.
- **A rule refusal is never an error class, an `HTTPException` or thrown text.** 401 and 403 (no
  session, no membership, a fenced token) and 404 (a row the caller cannot see, named by its ref)
  are transport and come from middleware and `rowIn`; a 400 from a validator is answered in the
  envelope. Release blockers, criteria, verdicts, record events, questions and permission
  refusals are the envelope.
- **Codes.** `<MODULE>_<WHAT>`, upper snake case, declared as an `as const` array in contracts and
  never in core, with a `<MODULE>_REFUSAL_STATUSES` map beside it when any code answers other than
  422. A permission refusal ends `_FORBIDDEN`.
- **Detail** names what was wrong and what is valid, and names another entity by its key (`REQ-3`),
  never by uuid.

## Status machines (BC-17)

- **A status machine is data**: `packages/contracts/src/<x>-machine.ts` declares
  `{ states, edges: [{ from, to, act, permission, guards }] }`, checked against the approved
  state-machine design of the same name, and every machine is listed in
  `packages/contracts/src/machines.ts:MACHINES`. The status column's CHECK holds its `states`.
- **A machine has a version.** Its `shapes` lists the fingerprint of every shape it has had
  (`packages/contracts/src/state-machine.ts:machineShape`, over states and edges), and its
  `version` is their count. `defineMachine` refuses at load a machine whose states or edges no
  recorded shape matches, naming the fingerprint to append, so a change is a new version and a
  version is never reused. Every `kernel_transitions` row records the version that judged the move
  (`machine_version`, null on rows recorded before versions), and so does its
  `<entity>.transitioned` event (`machineVersion`).
- **Only the kernel transition writes a status**, for every machine: the edge's guards, a
  compare-and-set on the row, and one `kernel_transitions` record, in one transaction
  (`packages/core/src/lifecycle/transition.ts:transition`); the outbox event is written at its
  `emitTransitionEvents` hook. The database holds the rule: a trigger on every machine's status
  column (`forge_kernel_status_guard`, installed per column by `forge_guard_status_column`) refuses
  an UPDATE that changes the status, `KERNEL_STATUS_WRITE_REFUSED` naming the row and the move,
  unless the transaction-local flag `forge.kernel_txn` holds the current transaction. The kernel
  sets it for its own status write only and puts it back after
  (`packages/core/src/db/kernel-marker.ts:asKernelStatusWrite`). A migration that adds a machine
  calls `forge_guard_status_column` for its column. One database-side writer remains:
  `enforce_no_active_child_under_terminal_run` (migration 0113) rewrites a job or session made
  active under a finished run to `cancelled`/`cancelled_stale` inside the move that made it active,
  and records its own `kernel_transitions` row with no version.
- **Guards are pure and run under the lock.** The kernel locks the rows (`FOR UPDATE`), then runs
  the guards the edge names, then writes. A guard reads only through the move's transaction; a fact
  from anywhere else (the project document, the actor's permissions, a provider such as a
  storefront draft) is read before the move and handed in
  (`packages/core/src/issues/transition-guards.ts:readIssueMoveFacts`). A guard never opens a
  second connection or calls the network while the lock is held.
- **A lost compare-and-set is a 409.** A caller that read a status moves with `expect: <status>`;
  a row that left it first is refused `STALE_TRANSITION` with `expected` and `actual`
  (`packages/contracts/src/state-machine.ts:staleTransitionRefusal`), and a read status with no edge
  to the target is refused `TRANSITION_NOT_AN_EDGE`. `from` is for a sweep, which leaves a row
  standing elsewhere as it is.
- **Removing a state or an edge is a declared migration.** The migration that ships the new version
  moves every row the change strands, or aborts naming them: `forge_migrate_state_rows(entity,
  table, column, from, to, version, reason)` moves every row standing at `from` to `to`, each move a
  `kernel_transitions` row (`source = 'migration'`) under the new version, and with `to` NULL raises
  `MACHINE_ROWS_UNMIGRATED` naming the rows still standing there. A removed state moves its rows
  before the CHECK drops it, and so does every live column holding the machine's states (a park's
  `issue_work_state.left_status`). A removed edge moves the rows at its `from` when it was their way
  out; where `from` keeps another exit, the version alone records the change. A migration's move
  writes no outbox event.
- **History keeps the values it recorded.** `kernel_transitions.from_status` and `to_status`, the
  outbox payloads and the record events carry no CHECK and are never rewritten or upcast; a reader
  types them as text and reads a retired state as the version that recorded it named it.
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
  one durable outbox (`packages/core/src/db/schema-outbox.ts:pipelineOutbox`) by
  `packages/core/src/outbox/emit.ts:emitEvent`, its types in
  `packages/contracts/src/outbox-events.ts:OUTBOX_EVENT_TYPES`. There is no in-memory bus.
- **Every consumer is declared in contracts** (`packages/contracts/src/outbox-consumers.ts:OUTBOX_CONSUMERS`)
  and registered under that name (`packages/core/src/outbox/consumers.ts:consume`, from
  `packages/core/src/outbox-consumers.ts:registerOutboxConsumers`). The workers refuse to start
  while the two disagree.
- **One pg-boss job per event and consumer**, sent in the act's transaction through pg-boss's
  Drizzle executor (`packages/core/src/outbox/emit.ts:emitEvents`) onto that consumer's own queue
  (`packages/core/src/outbox/queues.ts:queueOf`). Consumers are independent: one failing never
  retries or holds back another. The job carries the event whole, so it outlives the event's row.
- **Completing the job is the consumer's inbox.** A consumer whose effect is rows writes them inside
  `Delivery.inbox(tx => …)`, which completes the job in the same transaction, fenced to the attempt
  it holds, so a redelivery after the commit writes nothing again. A consumer whose effect leaves
  the database (a push, a queue send) is completed by pg-boss when it returns, and is delivered at
  least once.
- **Retries back off over hours** (`OUTBOX_MAX_ATTEMPTS` starts, pg-boss doubling the delay from
  `OUTBOX_RETRY_DELAY_SECONDS` to `OUTBOX_RETRY_DELAY_MAX_SECONDS`), then the job is `failed`, which
  is dead, and pg-boss copies it into `outbox.dead`. Dead deliveries are listed from that queue at
  `GET /api/projects/:id/outbox/dead` (and every project's, project-less events included, at
  `GET /api/admin/outbox/dead`), replayed with a fresh attempt count by
  `POST /api/projects/:id/outbox/deliveries/:did/replay` under `outbox.replay`, and raised as the
  `A6` ops alert (`packages/core/src/admin/alert-queries.ts:computeAlerts`). A consumer with a row
  of its own waiting on the delivery settles it in `onDeadLetter`.
- **An issue's events reach each consumer in order**: each queue is `key_strict_fifo` keyed by
  issue, so a delivery waits behind an active, retrying or dead one of the same issue for the same
  consumer. **A dead delivery blocks the issue for that consumer until it is replayed**; the block
  is loud through `A6`. Within a key pg-boss orders by the emitting transaction's start, then by job
  id, which leads with the event's `seq` (`packages/core/src/outbox/queues.ts:deliveryJobId`).
- **A heartbeat holds the job while a consumer runs** (`heartbeatSeconds`), so a slow consumer is
  never handed to a second worker, and a crashed one is retried.
- **Each consumer's worker is woken in-process after the emitting transaction commits**
  (`packages/core/src/db/client.ts:afterCommit`); nothing is signalled from inside the transaction,
  and polling backs it up. pg-boss deletes nothing from the consumer queues: delivered jobs and
  events are pruned after `OUTBOX_RETENTION_DAYS` by the `outbox-retention` timer
  (`packages/core/src/outbox/service.ts:pruneOutbox`), and a dead job is never pruned.
- **An event nobody consumes is not emitted**, and a subscription to an event nobody emits is
  removed. Each event node of an approved design maps to an event kind or to "the row is the
  record".
- **One act yields one record and at most one event**, not a record plus an activity row plus an
  outbox row plus a push. A kernel move is its `kernel_transitions` row plus one `<entity>.transitioned`
  event for the machines and targets in
  `packages/contracts/src/outbox-events.ts:TRANSITION_EVENTS`; the activity line and the WebSocket
  push are consumers of that event.
- **Comments on other entities** sit on exactly one of issue | requirement | workflow | feedback
  (`comments_scope_chk`), with a `packages/core/src/db/schema-comments.ts:commentEvents` row per post
  and edit.

## Read models (BC-19)

- **Every derived fact a screen or an agent reads** (standing, waiting-on, counts, coverage,
  changed-since-plan, passing, needs-you, the system graph) has one function in one core read
  model, answering one shared contracts shape. The reference is `packages/core/src/runs/`, whose
  `packages/core/src/runs/read.ts:listRunStanding` answers `packages/contracts/src/run-standing.ts`.
- **One standing shape.** A row's group and whom it waits on are
  `packages/contracts/src/standing.ts:Standing<Group, WaitingKind>`: its groups are a subset of
  `STANDING_GROUPS`, its waiting kinds a subset of `WAITING_KINDS`, and its group labels a
  `StandingGroupLabels`. Needs-you is the one predicate
  `packages/contracts/src/standing.ts:needsViewer` over that shape.
- **A read model reads the data directly.** It SELECTs the owners' tables or views it lists under
  `reads` on its entry in `packages/core/src/modules.json`, and writes none. It does not build a
  fact by calling other domains' read functions row by row, which is an N+1 read. The boundary
  check refuses a read model file that SELECTs a table its `reads` does not name (a raw SQL `FROM`
  or `JOIN`, or a value import from a schema file: `undeclared-read`) and a declared read nothing
  <!-- doc-citation: unchecked `read.ts` `read/` — file-name patterns a module may use, not paths in this tree -->
  uses. A read model may import an owner's read files (`read.ts`, `<x>-read.ts`, anything under
  `read/`) for a table it declares, and nothing else behind the owner's face.
- **The reference shape is `packages/core/src/runs/facts-read.ts`.** One statement per table for
  the whole page, never one per row, collected into maps keyed by row
  (`packages/core/src/runs/facts-read.ts:readTables`); then a typed facts object per row
  (`packages/core/src/runs/facts.ts:gatherFacts`); then one pure function from facts to the
  contracts shape (`packages/core/src/runs/standing.ts:runStandingOf`).
- **One input-builder per derived fact.** A fact that a gate also decides on has exactly one
  function that builds its predicate's input. It takes the executor first
  (`Pick<Tx, 'execute'>`), lives in the module that owns the fact's subject, and is exported beside
  the predicate. The read model calls it with `db`; the gate calls it with its own `tx`, inside the
  write transaction that acts on the answer. Nothing else assembles the same rows. The reference is
  `packages/core/src/issues/blocked-by.ts:blockingEdgesIn`, which the issue standing, the
  dependency read and every take gate call.
- **A predicate is declared once**, and the read model and every gate apply that one predicate:
  in contracts when it is pure over a contracts shape (`packages/contracts/src/standing.ts:needsViewer`),
  or beside its input-builder when it is a SQL fragment, which the builder then selects as a column
  rather than restating it in TypeScript (`packages/core/src/issues/blocked-by.ts:blockerUnsettledSql`,
  `packages/core/src/devices/master-silence.ts:masterSilentSql`,
  `packages/core/src/jobs/session-kinds.ts:heartbeatReapedSql`). A surface that describes what a
  sweep will do asks the sweep's own predicate (`@forge/contracts/jobs:holdReleasesItself`).
- **When computing on read gets slow**, take the next step only when the one before cannot serve,
  and measure before each:
  1. **An index** on the owner's table, leading with the scope column.
  2. **A view** the owner publishes (`pgView`, listed under the owner's `owns`, read through
     `reads`), when several read models need the same join.
  3. **A materialized view** (`pgMaterializedView`, the owner's), refreshed by a declared timer.
     Its staleness is stated: every answer it serves carries the refresh time, and the field's
     contracts doc says how stale it may be.
  4. **A projection table**, listed under the read model's own `projections` in modules.json. Only
     the read model's outbox consumer writes it (declared in
     `packages/contracts/src/outbox-consumers.ts:OUTBOX_CONSUMERS`), and it is rebuildable from the
     owners' tables at any time, so losing it loses nothing.
- **web-v2 renders; it computes no domain fact.** A feature's **derive.ts** may format, sort and
  group what a read model answered, and nothing more.

## Permissions (BC-20)

- **One check**: `packages/core/src/permissions/can.ts:can(actor, permission, resource)` and its
  forms (`holds` for a read flag, `requireHeld` / `requireCan` for a route, `permissionRefusal` /
  `permissionRefusalFor` for a rule that returns its refusal). The resource is
  `{ type, id, projectId }` (`@forge/contracts/permissions:ProjectResource`; `projectResource(id)`
  for a project-wide check) or an org (`orgResource(id)`); only the project decides today, and the
  type and id are carried so per-resource permissions change no call site. Nothing else reads a
  role, a grant or a token to decide who may act.
- **One list filter**: `packages/core/src/permissions/can.ts:visibleFilter(actor, permission, { type, projectId })`
  answers the same question for every row of a list as a Drizzle predicate over the rows' project
  column, the token's fence and grant included. A list read uses it rather than joining
  `project_members` by hand (`packages/core/src/me/attention-gates.ts`,
  `packages/core/src/me/attention-buckets.ts`).
- **The actor** is `{ userId, agency, tokenId, onBehalfOf }`
  (`packages/core/src/permissions/actor.ts:Actor`, built by `actorFor(userId)`, which takes the
  token and delegation from the request's own credential). A kernel move records the token and the
  person it acts for (`kernel_transitions.actor_token_id`, `actor_on_behalf_of`); no rule reads
  them.
- **One vocabulary**: `<resource>.<verb>` in `packages/contracts/src/permissions.ts:PERMISSIONS`.
  A role is a permission set declared there as data (`ROLE_PERMISSIONS`, `ORG_ROLE_PERMISSIONS`);
  a membership's grant (`project_members.grants`) adds permissions on its project beyond the role;
  a token narrows what its holder reaches, and holds a permission in `TOKEN_EXPLICIT_PERMISSIONS`
  (every `<resource>.approve` among them) only where its own grant names it. A credential core
  mints for an agent names the explicit permissions the agent's memberships grant
  (`packages/core/src/permissions/agent-fence.ts:agentCredentialGrant`), and an agent account's credential
  expires after a year.
- **Approval is a permission**
  ([ADR 0007](../adr/0007-approval-is-a-permission.md)): every approve-type act asks for
  `<resource>.approve`. No rule refuses an actor for being an agent, for being a person or for being
  the author; whoever holds the permission acts.
- **One refusal**: a caller with a role that lacks the permission is refused `PERMISSION_FORBIDDEN`
  with 403 in the envelope, naming `permission` and `scope`; a caller with no role on the project
  is a 403 (transport).
- **A slice never compares `agency`.** Agency is recorded on the row and read by no rule.
- **Memberships are the kernel's data** (orchestrator under dev delegation, 2026-10-04; ADR 0008
  Amendment). `permissions` owns `project_members` and `organization_members`, so `can()` reads
  only its own tables. A domain that adds, changes or drops a membership (projects, orgs,
  conversations) calls the kernel's writer, `packages/core/src/permissions/memberships.ts`.
- **Where a project sits is handed in.** The projects domain provides the project's org at boot
  (`packages/core/src/lib/authz.ts:provideProjectOrg`); the check reads no `projects` or
  `organizations` row.

## External systems (BC-22)

Every external system is reached through one adapter port under
`packages/core/src/integrations/<port>/`, named by role, never by vendor
([ADR 0006](../adr/0006-every-external-system-is-reached-through-one-adapter-port.md)). The ports,
their vendors and their callers are in `packages/core/src/integrations/README.md`.

- **A domain imports the port's index.ts.** It never imports a vendor directory, a vendor SDK, a
  vendor's types, or calls the global `fetch`; `scripts/check-provider-literals.mjs` refuses a
  vendor SDK import outside `packages/core/src/integrations/`, and the module-shape lint
  (`scripts/eslint-module-shape/rules/global-fetch.mjs`) the global `fetch` outside an adapter.
- **An adapter imports no domain, kernel module or read model.** What the vendor sends back enters
  through a door, and a provider's routes and tools are the integration door's
  (`packages/core/src/integration-door/`), never the adapter's.
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
- **Format and resolve.** A formatter builds the key (`packages/contracts/src/requirements.ts:requirementKey`,
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
  appends `packages/contracts/src/content-language.ts:contentLanguageBlock`.

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
core/src/modules.json             "feedback": { "kind": "domain", "context": "design", "owns": [...] }
core/src/feedback/rules.ts        pure guards → FeedbackRefusal | null
core/src/feedback/read.ts         rowIn (uuid | FB-n | n), feedbackKey, list and detail views
core/src/feedback/service.ts      lockFeedback; createFeedback / declineFeedback → Outcome
core/src/feedback/standing.ts     its derived facts, if any, in the contracts standing shape
core/src/feedback/events.ts       the outbox events it emits, each with a consumer
core/src/feedback/routes.ts       strictBody(...); answer(outcome) → refused | c.json(view);
                                  imported only by route-registry.ts
core/src/feedback/tool.ts         only if an agent needs what the CLI and API do not cover;
                                  imported only by the two tool registries
core/src/feedback/index.ts        { services, read functions, types }
web-v2/src/features/feedback/     api.ts, hooks.ts, types.ts, routes.ts, components/
```

## Honest costs

| Choice | What it costs |
|---|---|
| One kind per directory and a direction | Most of core breaks it on the first reading; every module is rebuilt through the reconciliation flow rather than refactored in place, and a rebuild loses what the old code handled that no rule or design stated |
| One index.ts per module | A barrel per module, and an internal import that used to be free is now a finding until the module exposes it |
| A light face and a heavy face | Two entry files per module instead of one, and a constant another module needs moves to contracts rather than riding the face |
| Direction between twelve contexts first | A back edge between two contexts is cut by an outbox event or a port filled at boot rather than a direct call, and each cut is a change of its own; the order was read from today's graph, so a context whose code is wrongly placed reads as a back edge until it moves |
| One owner per table | A cross-module write becomes a call into the owner's service, one more function and one more transaction boundary to get right |
| The machine as data and one kernel transition | Every status write in core moves into one engine, and a slice can no longer set its own status in a one-line update; the database refuses one that tries, so a missed path fails at runtime rather than in review |
| A version per machine | Any edit to a machine's states or edges appends a fingerprint to its `shapes`, and one that removes a state or an edge ships a data migration with it |
| One durable outbox | Every reaction is asynchronous and survives a crash, at the price of a table write per event plus one per consumer, and a consumer whose effect leaves the database must be idempotent |
| The status chosen by what the client should do | Each code that is not 422 is declared in a status map beside it; a code thrown in core but declared in no contracts array answers 422, whatever it means |
| The semantic rules run on demand, not before a push | New code can break a table-writer, route-query or refusal rule and land; the break shows only when the orchestrator or QA next runs the script |
| Read models SELECT owners' tables they declare | An owner's column change can break a read model's SQL that no owner code calls, so the `reads` list is where an owner looks before it changes a table |
| One input-builder per fact, shared with the gate | The builder answers what both callers need, so the read model's page query and the gate's single-row check run the same statement shape, and the gate may read a column it does not use |
| A shrink-only baseline for the import rules | A file move rewrites its baseline keys, so the move carries `--update-baseline` with it; a violation can never be admitted by re-freezing, only fixed |
