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
  sound recipe for an entity slice (contracts as the one declaration, the 422 envelope, revisions,
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
  issues, requirements and questions), so its read model imports their read functions. A domain
  that must gate on the same fact applies the fact's predicate from contracts to its own rows. The
  alternative, read models below domains, forces each read model to query other modules' tables
  directly, which is the ownership breach this decision exists to end.
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
  enum, live in their module (`tool.ts`), and are mounted, like every module's routes, by one
  registry per door.
- **Status machines as data, one kernel transition, one durable outbox.** A machine declared in
  contracts can be checked against its approved state-machine design; a status written in one
  engine, with one record and one event in one transaction, cannot drift between a record, an
  activity row, an outbox row and a push. 26 of 27 in-memory hook topics were lost on a crash; the
  outbox makes every reaction durable, and an event nobody consumes is not emitted.
- **Refusals stay one envelope**, and the error-class and `HTTPException` shapes are retired rather
  than mapped, because a client that has to read four shapes reads none of them reliably.
- **Permission is [ADR 0007](0007-approval-is-a-permission.md)'s**, not restated here: approval
  became a permission, and one `can()` replaces the agency rule table for every other act.

**The rules are measured by a script, on demand.** `scripts/check-module-shape.mjs` reads the kind declaration and archmap's import graph
(`archmap graph --json`, so one resolver answers for both checks) and reports per module: kind,
direction, public face, cycles, table writers, database calls in routes, refusal shape and status
writes outside the kernel transition; `--markers` writes its findings as the Wrong markers of the
reconciliation checklist, a JSON document the REQ-17/18 observation store can import. The owner
ruled on 2026-10-04 that dev is code only and QA comes later ("build trước đi đã test gọi QA test
sau"), so the orchestrator or QA runs it; it is wired into neither `pnpm verify` nor a hook, ships
without unit tests, and the only check before a push on dev is `tsc` on the touched packages.
Whether a rule later becomes a gate is a QA-phase decision.

Two rules have no script yet: read models (web derivations) and permission. They are judged by the
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
- **`project-config/mount.ts`, `issues/mount.ts` and `project-config/respond.ts` stop being hubs**:
  mounting moves to the door registries and `refused` moves into platform beside the envelope.
- **Two adapter shapes remain legal** (registry-bound and deployment-bound, ADR 0006); a caller
  imports the port's `index.ts` either way.
- **The cost** is in pattern v2's Honest costs: most of core fails on day one, and because the
  checker runs on demand, a change can break a rule and land until someone next runs it.

## Amendment (2026-10-04)

The core component design exposed two tensions in the kinds above; the orchestrator ruled on both
under the owner's dev delegation.

- **Memberships and roles are kernel-owned data.** Project and org membership rows, their roles
  and their grants belong to the permission kernel, not to the `projects` and `orgs` domains that
  used to write them. `packages/core/src/modules.json` lists `projectMembers` and
  `organizationMembers` under `permissions`, so the one check reads only its own tables, and every
  module that adds, changes or drops a membership calls the kernel's writer
  (`packages/core/src/permissions/memberships.ts`).
- **Sign-in belongs to the auth door.** Signing a person in through the identity adapter is a door's
  work, not a platform leaf's: `auth` is declared a door, and a door may reach an adapter through
  its port's `index.ts` (`packages/core/src/integrations/identity/index.ts`), as a domain may.
  The credential helpers other modules import from `auth` (`pat-scope`, `pat-format`,
  `pat-permissions`, `pat`, `jwt`, `cookie`, the device and turn credentials) now read as imports
  of a door from below until they move to a platform module; the checker reports them.
