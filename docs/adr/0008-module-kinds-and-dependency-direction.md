# 0008 — Module kinds and dependency direction

**Status:** accepted · **Date:** 2026-10-04 · **Supersedes:** none; extends [0006](0006-every-external-system-is-reached-through-one-adapter-port.md) with the direction an adapter may import

## Context

The owner said on 2026-10-04 that core's logic was not clean and its build pattern not stable
("Logic tôi thấy chưa sạch sẽ và build pattern chưa ổn"), and that requirements, workflow designs
and patterns are the root the code is reconciled to. A read-only review of `packages/core/src` on
`dev` that day measured why:

- **No module boundaries.** 68 of 77 directories sat in one import cycle; without `db`, `lib`,
  `middleware` and the root it was still 51. 85 pairs of domains imported each other. The schema
  imported `issues` and `pipeline`, and `lib` imported `project-config`. Moving the 21 most-shared
  helpers into a kernel layer shrank the knot only from 51 to 49, so the coupling came from services
  calling each other, not from shared helpers.
- **No table owners.** `comments` was written from 18 files in 9 directories, some skipping the
  screening its own service runs; `agent_sessions` from 21 files. 77 of 160 route files queried the
  database themselves.
- **The same fact in several places.** Changed-since-plan, "passing", standing and waiting-on,
  needs-you, job context, pins, permission, status sets and the release refusal each had two to
  twelve live implementations, so two screens could disagree about one issue
  (`VISION: state-never-lies`).
- **The pattern covered one slice kind.** The previous `docs/conventions/domain-entities.md` was a
  sound recipe for an entity slice (contracts as the one declaration, the refusal envelope, revisions,
  keys), and 7 directories followed it. It said nothing about state machines, events, read models,
  dependency direction, table ownership or permission, which is where the tangles were, and its own
  route-mount rule made `project-config` a hub in both directions.

## Decision

**Every directory under `packages/core/src` is exactly one of six kinds**, declared in
`packages/core/src/modules.json`: kernel, domain, read-model, adapter, door, platform. Imports run
one way — door → read-model → domain → kernel → platform, with a domain reaching an adapter only
through its port — and nothing imports upward or in a cycle. Pattern v2
(`docs/conventions/domain-entities.md`) states the rules; REQ-12 revision 3 makes each one a
citable business criterion (BC-11 to BC-22).

The choices inside that, and why:

- **Six kinds, not layers by technology.** The tangles were between product modules, not between
  "routes" and "services". A kind says what a module may know: the kernel owns the machines every
  product module moves, a read model only derives, an adapter only speaks a vendor's protocol.
- **Read models sit above domains.** A derived fact usually spans several domains (needs-you reads
  issues, requirements and questions). How a read model reaches their data is the ISS-188
  amendment below: it SELECTs the owners' tables it declares, and writes none.
- **The kernel imports no adapter.** An effect of a transition on the outside world (a chat
  message, a deploy) is a domain's reaction to the transition's outbox event. That keeps the kernel
  testable without a vendor and keeps `VISION: kernel-hard-policy-soft` structural.
- **An adapter imports no domain.** ADR 0006 placed every vendor call behind a port and checked
  where a vendor may be *named*. It did not say which way an adapter may *import*, and the review
  found adapters importing 13 domains: Sentry intake moving issues, Coolify driving a release, the
  chat adapter holding a whole chat application. Inbound vendor traffic now enters through a door
  and calls the module that owns the effect.
- **One public face per module.** Without it, any file is any module's API, and a refactor inside
  a module breaks callers it cannot see. Platform modules are exempt: they are leaf utilities, and
  their protection is that they import nothing above them.
- **One owner per table.** A write that skips the owner skips its rules, as the comment writers
  that skipped screening showed. Ownership is declared in the same file as the kinds, so one
  document answers "who may write this".
- **REST is the primary door, the CLI is built over it, and MCP is slimmed.** The owner ruled on
  2026-10-04 that a tool the CLI or the API can replace is not needed ("cái nào cli thay thế được
  và nên dùng API hơn và CLI hơn thì không cần MCP"). Of the 78 registered tools, 40 were dotted
  one-verb wrappers and 38 action-enum tools; the question of which naming scheme wins dissolves
  once the wrappers go. The few that stay take the one-tool-per-resource form with an `action`
  enum, live in their module (**tool.ts**), and are mounted, like every module's routes, by one
  registry per door.
- **Status machines as data, one kernel transition, one durable outbox.** A machine declared in
  contracts can be checked against its approved state-machine design; a status written in one
  engine, with one record and one event in one transaction, cannot drift between a record, an
  activity row, an outbox row and a push. 26 of 27 in-memory hook topics were lost on a crash; the
  outbox makes every reaction durable, and an event nobody consumes is not emitted. Durable is not
  enough on its own: a single row with one shared attempt counter let one failing consumer spend the
  retries of every other, gave up after three quick attempts, and left the row unprocessed for ever
  with nobody told, which breaks `VISION: state-never-lies`. So each consumer gets its own pg-boss
  job, sent in the act's transaction through pg-boss's Drizzle executor; its retries back off over
  hours, and a job that runs out ends `dead`, listed, alerted and replayable. Measured on **pg-boss
  12.36.0** (ISS-192), it covers six of the nine requirements as shipped, one more with a derived job
  id, and two are built: a transactional send, one queue per consumer, backoff up to a cap, a
  heartbeat that holds a running job, a dead-letter copy with retry of the failed job, and
  `key_strict_fifo`, which holds an issue's later jobs behind an active, retrying or failed one.
  That last is the rule chosen on
  2026-10-05: **a dead delivery blocks its issue for that consumer until it is replayed**, loudly,
  through A6. Three gaps are built here. pg-boss's retention deletes a failed job with the completed
  ones, which would release the block and hide the dead, so the consumer queues delete nothing and a
  timer prunes only delivered jobs. Within a key pg-boss orders by the emitting transaction's start,
  then by id, so a job id leads with the event's `seq` and events written in one transaction keep
  their order; across transactions the order is by transaction start, where the hand-rolled claim
  ordered by `seq` taken at insert, and neither follows commit order. pg-boss counts no overdue job
  that excludes the ones a key holds back, so that count reads its job table. The earlier 60% reading
  was of 10.4.2. pg-boss 12 cannot migrate the version-24 schema 10.4.2 wrote, so it lives in
  `pgboss_v12` and core copies the jobs 10.4.2 left waiting on first start
  (`packages/core/src/queue/v10-carry-over.ts`); `pgboss` is only read, so a code revert returns to
  10.4.2. **`pgboss` is dropped once** every environment that ran 10.4.2 has booted this build, the
  boot log there names no job written to `pgboss` after the copy, and a revert to 10.4.2 is no longer
  wanted.
- **Refusals stay one envelope**, and the error-class and `HTTPException` shapes are retired rather
  than mapped, because a client that has to read four shapes reads none of them reliably.
- **Permission is [ADR 0007](0007-approval-is-a-permission.md)'s**, not restated here: approval
  became a permission, and one `can()` replaces the agency rule table for every other act.

**The rules are measured by two scripts.** The import rules (direction, public face, cycles)
are `scripts/check-module-boundaries.mjs`'s, a blocking check with a shrink-only baseline, as
ISS-184's amendment below records. `scripts/check-module-shape.mjs` refuses a declaration that
contradicts itself (an undeclared directory among it) and blocks, with type-aware ESLint rules
ratcheted by bulk suppressions (ISS-196), the rules an import graph cannot show: table writers,
database calls in routes, refusal shape and the global fetch outside an adapter; a status
written outside the kernel transition is refused by a database trigger instead (ISS-189,
`docs/conventions/domain-entities.md`, Status machines); `--markers` writes those findings as the Wrong markers of the
reconciliation checklist, a JSON document the REQ-17/18 observation store can import. The owner
ruled on 2026-10-04 that dev is code only and QA comes later ("build trước đi đã test gọi QA test
sau"), so neither ships with unit tests, and the only check before a push on dev is
`pnpm tc:changed` (`scripts/tc-changed.mjs`), a typecheck of the touched packages and their
importers.

Two rules have no script yet: web derivations and permission. They are judged by the
reconciliation decision on each module until a check exists.

## Consequences

- **First reading, at `252529729` on `dev`**: 84 of 93 modules Wrong, 81 failing two or more rules;
  one import cycle of 81 modules; 709 imports against the direction, 2,280 imports of another
  module's internals, 153 writes to a table another module owns (37 tables written from more than
  one module), 78 route files with database calls, 310 refusals outside the envelope, 67 status
  writes outside the kernel transition.
- **Modules are rebuilt, not refactored, kernel first.** Under the reconciliation flow's rule
  (rewrite due at two failing aspects), almost every module is due. The owner froze features on
  2026-10-04 so the kernel goes first: permission, the state machine as data, the refusal body,
  table writers, read models, then events, adapters and doors, as the rebuild issues the pattern-v2
  issue blocks record.
- **archmap keeps its own contracts.** Its purity and fan-out contracts in `.arch.json` stay; the
  kinds are not restated as archmap `layers`, because that would declare every kind twice.
- **`project-config` and `issues` stop being hubs**: their slice mounts are deleted, every router
  is mounted by `packages/core/src/route-registry.ts`, and `refused` lives beside the envelope in
  `packages/core/src/lib/refusal.ts`.
- **Two adapter shapes remain legal** (registry-bound and deployment-bound, ADR 0006); a caller
  imports the port's **index.ts** either way.
- **The cost** is in pattern v2's Honest costs: most of core fails on day one, and because the
  semantic rules run on demand, a change can break one of them and land until someone next runs
  the script.

## Amendment (2026-10-04)

The core component design exposed two tensions in the kinds above; the orchestrator ruled on both
under the owner's dev delegation.

- **Memberships and roles are kernel-owned data.** Project and org membership rows, their roles
  and their grants belong to the permission kernel, not to the `projects` and `orgs` domains that
  used to write them. `packages/core/src/modules.json` lists `projectMembers` and
  `organizationMembers` under `permissions`, so the one check reads only its own tables, and every
  module that adds, changes or drops a membership calls the kernel's writer
  (`packages/core/src/permissions/memberships.ts`).
- **Sign-in left the platform.** Signing a person in through the identity adapter is not a platform
  leaf's work. `auth` was declared a door here; ISS-184's amendment below makes it a domain, since it
  owns the users table and other domains import it. Either kind reaches the identity adapter only
  through its port's **index.ts** (`packages/core/src/integrations/identity/index.ts`).
  The credential helpers every kind uses (the PAT helpers, `jwt`, `cookie`, the device and turn
  credentials, the MCP audit writer) live in the platform module `packages/core/src/credentials/`,
  which owns `personalAccessTokens` and `mcpAuditLog`. Whether a turn may act as a person asks
  `project.read`, so it sits in the permission kernel
  (`packages/core/src/permissions/turn-authority.ts`). Assistant and display preferences are the
  `preferences` domain's. `auth` keeps only sign-in and the person's own profile.
- **The permission check reads only its own tables.** Where a project sits (its org) is the
  projects domain's fact: the HTTP door hands it to the check at boot
  (`packages/core/src/lib/authz.ts:provideProjectOrg`, given
  `packages/core/src/projects/service.ts:findProjectOrgId`), and the org check reads only the
  caller's org membership, so an org the caller is not in and one that does not exist are the same
  403. Carrying the org on membership rows was the other option; it would not cover an org owner
  or admin with no project row, who holds admin on every project of the org, so it needed a second
  copy of `projects.org_id` kept in step by every create and transfer.

## Amendment (2026-10-04, ISS-184): business contexts, a split face, and dependency-cruiser

A research pass over 163 primary sources (owner ask, 2026-10-04) set pattern v2 beside how
modular monoliths that succeeded were built. Three of its ranked changes are taken here. The
measurements are dependency-cruiser 18.2.0 over `packages/core/src` at `0d3e1c9ef` on `dev`, tests
excluded.

- **A business-context layer above the kinds, and direction between contexts first.** Every
  source draws and enforces boundaries at the level of a business capability first: Shopify's 37
  components average about 76,000 lines, Spring Modulith takes top-level packages as modules, and
  the DDD context map relates contexts, not files. Direction over 98 code modules of about 2,400
  lines means re-planning hundreds of module edges at once; between twelve contexts it is one
  order. The contexts are the twelve root module labels on the Forge project, declared with their
  order in `packages/core/src/modules.json` `contexts`, and every module names its own. Read with the
  label grouping as it stood, 62 context pairs imported each other and 48 of them both ways.
- **The order, read from the graph:** platform, adapters, access, project-config, knowledge, work,
  execution, design, release, ecosystem, conversations, operations, each context importing only
  those before it. Each context sits above the contexts it imports most; the alternatives scored
  within a few imports of each other, and the tie-breaks follow the kinds: the contexts holding
  kernels (access, work, execution) sit below the domains that move them. With doors exempt and
  the technical layers fixed by kind, 58 context pairs import each other, 35 both ways, and 285
  imports over 104 module pairs run against the order. Those are the back edges to cut, platform's
  and adapters' first, as Shopify cut cross-layer edges first.
- **Work is upstream of execution; they stay two contexts.** Execution imports work 122 times over
  22 module pairs (jobs into the pipeline and the transition engine, devices into issues, sessions
  into the pipeline); work imports execution 56 times over 17, and 32 of those are the pipeline
  dispatching jobs, sessions, devices and runners. The languages differ (issue, status, step,
  pipeline against agent, session, job, runner, device), and a job exists to carry out an issue's
  step and move the issue through the work kernel's transition: execution conforms to work. The
  back edges are cut by execution's outbox events, which work consumes, and by the job pool
  execution claims from. A merge would have made one context of about 26 modules, the largest by
  far, joined by a dispatch call that an event already describes.
- **The technical layers are defined by kind.** A platform-kind module is in `platform` and an
  adapter in `adapters`; neither holds a domain or a read model. That moved, against the label
  grouping: `config`, `credentials`, `pat`, `security`, `branches`, `embeddings` and
  `observability` to platform (every layer reads `packages/core/src/config/env.ts`, and middleware reads the
  credential helpers, so in a business context each was a false back edge); `git`,
  `integrations/coolify`, `integrations/deploy`, `integrations/published-releases` and `storage` to
  adapters (the registry imports them), since folded into the ports that own their concept
  (`integrations/source-host`, `integrations/deploy`, `integrations/github`, `integrations`); `uploads`, a domain, to work. The integration door joins
  adapters. A door is exempt from context direction because it composes contexts; its kind still
  lets only a door import it.
- **modules.json agrees with its own kinds.** `auth` owned `users` and the sign-in tokens as a
  door, and `orgs` and `conversations` imported it, which no non-door may: it is now a domain, and
  it reaches the identity adapter through the port as any domain may. `usage-records`, a read
  model, wrote `usage_records` when a job finished and four kernels read it: it is the job's cost
  evidence, so it is a kernel module in execution. `admin`, a read model, wrote `admin_thresholds`:
  the thresholds moved to the domain `admin-thresholds` (since ISS-220 fixed defaults, with no
  table), and `admin` keeps only derived views.
  `app-config`, declared platform, holds a project's assistant settings behind routes and a
  permission check: it was a domain in project-config until ISS-213 deleted it with its last
  caller. **Who owns tables:** kernel, domain, adapter
  and platform modules; an adapter only its own bookkeeping with the vendor (connections,
  deliveries, mirrored vendor state), a platform module only its own (backfill markers, tokens, the
  embedding index). A read model and a door own nothing.
- **The face is split in two.** ISS-168 moved each module's routes and tools onto its index.ts and
  core then failed to load with "Cannot access X before initialization": reading one constant
  through a face evaluates every router behind it, and inside an import cycle that order breaks.
  Barrels load eagerly (Atlassian's removal across 90,000 files cut local test time by about half),
  and every precedent with public entries splits a light one from a heavy one (Grzybek's
  IntegrationEvents, ABP's Application.Contracts, Angular's secondary entry points). index.ts now
  exports services, read functions and types and constructs nothing at import; **routes.ts** is
  imported only by `packages/core/src/route-registry.ts`, and **tool.ts** only by
  `packages/core/src/mcp/registry.ts` and the assistant's chat toolset
  (`packages/core/src/assistant/tools/registry.ts`), the second place tools are composed; shared constants and types come from `@forge/contracts`; a
  type-only edge is `import type`, which `verbatimModuleSyntax` (already on in core and contracts)
  erases.
- **dependency-cruiser replaces the import half of the regex module script.** Its
  configuration is generated from `modules.json`, so kinds and contexts are declared once. Five
  rules: context direction, kind direction, runtime cycles between modules (type-only and dynamic
  imports excluded, since neither orders loading), face-only access, and adapters reached only
  through their port's index.ts. Its violations are frozen in a shrink-only baseline: a new
  violation fails, a baseline entry that no longer occurs fails, and a rule whose frozen count rose
  over the base revision fails, so debt is worked off and never added to (Packwerk's todo file,
  ArchUnit's freeze, ESLint's bulk suppressions). The declaration checks stay in the small script's
  library: each table owned once, `owns` consistent with `kind`, every module a known context, and
  the two technical layers by kind. The semantic rules (table writers, database calls in routes,
  the refusal shape) stay regex reports run on demand; off-the-shelf tools see
  imports, not behaviour, and a type-aware lint for them is a later change. Sheriff and
  eslint-plugin-boundaries would have served too; one tool is enough, and dependency-cruiser
  already resolves archmap's graph. Nx needs a project file per module and custom rules on an
  Enterprise plan.
- **Not taken:** a planted-violation test per rule. The owner ruled on 2026-10-04 that dev is code
  only and QA comes later, so each rule is trusted on its generated configuration until QA plants
  a violation per rule and watches it go red.

## Amendment (2026-10-05, ISS-188): read models read the data directly

The same research pass compared read models with the CQRS sources. Greg Young's thin read layer
"reads directly from the database and projects DTOs" and names loading several aggregates to build
one DTO as the cost; Dahan keeps the domain model out of queries; Grzybek's read side is raw SQL
over views. Building a read model by calling several domains' read functions is that cost, an N+1
read, and Forge's own reference read model (`packages/core/src/runs/facts-read.ts`, one statement
per table over twelve tables) already broke the rule this ADR stated. The rule now matches it.

- **A read model SELECTs the tables it declares.** Each read model lists under `reads` in
  `packages/core/src/modules.json` the owners' tables or views it reads, and writes none. Ownership
  is about writes: a SELECT skips no owner's rule, and the declaration keeps every cross-owner read
  visible and reviewable.
- **The boundary check enforces the list.** `scripts/check-module-boundaries.mjs` refuses a read
  model file that SELECTs (raw SQL `FROM` or `JOIN`, or a value import from a schema file) a table
  its `reads` does not name (`undeclared-read`), and a declared read nothing uses. A read model may
  <!-- doc-citation: unchecked `read.ts` `read/` — file-name patterns a module may use, not paths in this tree -->
  import an owner's read files (`read.ts`, `<x>-read.ts`, `read/`) for a table it declares, past the
  face-only and context-direction rules; nothing else behind the face.
- **One input-builder per derived fact.** The predicate was declared once, in contracts, but its
  inputs were assembled twice, by the read model and by the gate, so the two could drift. Each fact
  now has one function that builds the predicate's input from a `tx`, beside the table that owns
  the fact's subject; the read model calls it with the database and the gate calls it inside its
  own write transaction.
- **A written path when a read gets slow:** an index, then a view, then a materialized view with
  its staleness stated, then a projection table the read model declares under `projections` (the one
  table a read model owns), written only by its outbox consumer and rebuildable from source. Application-maintained caches are "a complete mess of complicated
  invalidation logic" (Kleppmann); each step is taken only when the one before cannot serve.
