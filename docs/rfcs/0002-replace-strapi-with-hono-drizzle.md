- Feature Name: `replace_strapi_backbone`
- Start Date: 2026-04-20
- RFC PR: _(pending)_
- Tracking Issue: _(pending acceptance)_
- Owning team: @junixlabs
- Status: Draft — open for comment
- Related ADR: [0002](../decisions/0002-replace-strapi-with-hono-drizzle.md)

> **Reader note (2026-04-23):** Three items in this RFC are superseded:
> 1. **Vector DB row in §Stack** ("Qdrant — unchanged") and the docker-compose `qdrant:` service → superseded by **[ADR 0011](../decisions/0011-pgvector-replaces-qdrant.md)** (Postgres `pgvector`, single connection).
> 2. **Cutover model** (parity-implied throughout) → superseded by **[ADR 0010](../decisions/0010-clean-break-from-strapi.md)** (clean break, no parity, single flip PR).
> 3. **Mobile mentions** → `forge/app/` is paused per [ADR 0009](../decisions/0009-mobile-app-paused-for-v0x.md); it is not a Phase 2.5 client.
>
> The RFC body is preserved as the historical proposal. For current implementation guidance, follow the ADRs above and [proposals/core-strapi-decoupling.md](../proposals/core-strapi-decoupling.md).

# Summary

Replace the Strapi 5 backbone with a purpose-built Node service on **Hono + Drizzle + pg-boss**, **rebuilt from scratch** rather than migrated. The new service is designed around the control-plane workload (device-runner orchestration, dual-principal auth, event streaming, MCP exposure) instead of Strapi's CMS-shaped lifecycle. Existing Strapi-coupled code in `forge/strapi/` is deleted after the new service reaches functional parity. No runtime data migration is attempted — the internal alpha deployment is recreated fresh.

# Motivation

Strapi was chosen during internal alpha for speed of prototyping: schema-first content types gave us admin UI and REST for free. Eight months in, the costs dominate the benefits:

1. **Wrong workload shape.** Strapi is a CMS optimized for content publishing. Jarvis Agents is a control plane optimized for real-time event streaming, multi-stage job orchestration, and dual-principal authorization. Every critical path feature — WebSocket fan-out, pg-boss integration, MCP server, policy layer — is hand-built against Strapi's conventions rather than with them. The framework is in the way.

2. **Upgrade treadmill.** Strapi v4 → v5 required substantial internal rewrites. v5 → v6 will likely do the same. Every major version disrupts contributors and delays product work.

3. **Memory footprint.** Baseline ~400 MB RAM conflicts with our "simple self-host" narrative. A control plane targeting solo developers and small teams should run in under 128 MB idle.

4. **OSS-contributor friction.** "Why is this built on Strapi?" will be asked by every incoming engineer. The answer has to be technical, not "we started there." Contributors must learn Strapi's admin conventions before touching anything.

5. **Admin UI is a liability, not a win.** Strapi admin exposes full CRUD by default and is hard to lock down for production. A purpose-built admin surface would be smaller, safer, and shaped to the operator's actual needs.

6. **The audit findings are easier to resolve from a clean start.** The audit surfaced row-level access gaps, over-broad WebSocket broadcasts, and a `crossProjectAccess` escape hatch. Retrofitting a shared policy layer onto Strapi's ad-hoc controller checks is possible but drift-prone. Building a new service around a single policy layer from the first commit prevents the drift entirely.

7. **Internal alpha is pre-users.** We have no external adopters to migrate. The cost of breaking our own deployment is bounded; the cost of carrying Strapi into public launch is compounding.

Rebuilding from scratch is cheaper and safer than migrating. Attempting a parallel migration adds 1–2 weeks of schema-adapter work, data-verification work, and cut-over risk for no benefit — nobody outside SidCorp has data to preserve.

# Guide-level explanation

## The new service

`forge/core/` is a Node 20+ service built on Hono. It exposes:

- **REST API** at `/api/*` for projects, issues, comments, devices, jobs, webhooks, auth.
- **WebSocket** at `/ws` with room-scoped broadcasts (one socket → many rooms based on principal type).
- **MCP server** at `/mcp` (Streamable HTTP transport) exposing the same data as REST, for agent clients like Claude Code or Cline.
- **Job queue** via pg-boss on the existing Postgres instance.

It does NOT include:
- An admin UI (that becomes part of the Next.js web app at `/admin`)
- Claude credential storage (enforced by [ADR 0004](../decisions/0004-no-claude-credentials-on-server.md))
- Any CMS features

## Stack

| Concern | Choice |
|---------|--------|
| HTTP framework | Hono |
| ORM + migrations | Drizzle + drizzle-kit |
| Database | PostgreSQL 17 (unchanged) |
| Job queue | pg-boss |
| WebSocket | `ws` + custom room manager |
| MCP server | `@modelcontextprotocol/sdk` |
| Auth | Custom: `jose` (JWT) + `argon2` + shared policy module |
| Email | Nodemailer + SMTP |
| Vector DB | Qdrant (unchanged) |
| Admin UI | Next.js `/admin` routes in `forge/web/` + Drizzle Studio for dev |
| Lint + format | Biome |
| Test | Vitest |
| Runtime | Node 20+ (Bun-compatible via Hono if we choose later) |

## What developers do differently

### Defining a new table

Before (Strapi): create a `schema.json` in `src/api/<name>/content-types/<name>/`, restart Strapi, endpoints auto-generate.

After (Drizzle): declare the table in `src/db/schema.ts` with typed columns, run `pnpm drizzle-kit generate`, hand-roll the Hono route in `src/api/<domain>/`.

The after is more code but every route is explicit and typed. No framework magic, no hidden lifecycle hooks.

### Adding a route

```ts
// src/api/devices/routes.ts
import { Hono } from 'hono'
import { requireUser, assertUserIsProjectMember } from '@/auth'

export const devicesRouter = new Hono()
  .post('/pairing-codes', requireUser(), async (c) => {
    const user = c.get('user')
    const code = await createPairingCode(user.id)
    return c.json({ code, expiresIn: 300 })
  })
```

Policy helpers (`requireUser`, `assertUserIsProjectMember`, etc.) live in one module. Every route must call one.

### Lifecycle hooks → explicit functions

Before (Strapi): `strapi.db.lifecycles.subscribe({ models: ['api::issue.issue'], afterCreate(event) { ... } })` in bootstrap.

After (Drizzle + Hono): the route that creates an issue explicitly calls `onIssueCreated(issue)` which is a function in `src/pipeline/hooks.ts`. Transitions are explicit code, not framework callbacks.

### Testing

Each module ships `.test.ts` files using Vitest. Tests hit a test Postgres via Testcontainers or a dedicated test database. Policy module has ≥90% coverage (per [ADR 0005](../decisions/0005-dual-principal-auth.md)).

# Reference-level explanation

## Directory layout

```
forge/core/
├── src/
│   ├── db/
│   │   ├── schema.ts          # Drizzle schema for all tables
│   │   ├── client.ts          # Drizzle client singleton
│   │   └── migrations/        # Generated by drizzle-kit
│   ├── auth/
│   │   ├── jwt.ts             # issue/verify JWTs (user principal)
│   │   ├── device.ts          # issue/verify device tokens
│   │   ├── policy.ts          # shared assertUser*, assertDevice*, assertJob*
│   │   └── middleware.ts      # requireUser, requireDevice Hono middleware
│   ├── api/
│   │   ├── projects/
│   │   ├── issues/
│   │   ├── comments/
│   │   ├── devices/
│   │   ├── jobs/
│   │   ├── webhooks/
│   │   ├── auth/
│   │   └── health/
│   ├── ws/
│   │   ├── server.ts          # WS upgrade + auth
│   │   ├── rooms.ts           # Room manager (subscribe/publish)
│   │   └── handlers/          # Per-event handlers
│   ├── mcp/
│   │   ├── server.ts          # MCP Streamable HTTP
│   │   └── tools/             # Per-tool: forge_issues, forge_memory, etc.
│   ├── queue/
│   │   ├── boss.ts            # pg-boss client
│   │   └── dispatcher.ts      # Job dispatch + device routing
│   ├── pipeline/
│   │   ├── state-machine.ts   # 14-status transitions
│   │   ├── hooks.ts           # onIssueCreated, onJobComplete, etc.
│   │   └── skills/            # Built-in skill registry
│   ├── services/
│   │   ├── embeddings.ts      # Qdrant client wrapper
│   │   ├── email.ts           # Nodemailer wrapper
│   │   └── rate-limit.ts      # Per-IP + per-user limits
│   ├── config/
│   │   └── env.ts             # Zod-validated env parsing
│   └── index.ts               # Hono app assembly + server start
├── tests/
│   ├── integration/
│   └── unit/
├── drizzle.config.ts
├── biome.json
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

## Schema (Drizzle, abbreviated)

```ts
// src/db/schema.ts
import { pgTable, uuid, text, timestamp, jsonb, integer, boolean } from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  emailVerifiedAt: timestamp('email_verified_at'),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const devices = pgTable('devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  platform: text('platform', { enum: ['macos', 'linux', 'windows'] }).notNull(),
  agentVersion: text('agent_version'),
  tokenHash: text('token_hash').notNull(),
  tokenPrefix: text('token_prefix').notNull(),
  status: text('status', { enum: ['online', 'offline', 'revoked'] }).notNull().default('offline'),
  lastSeenAt: timestamp('last_seen_at'),
  pairedAt: timestamp('paired_at').notNull().defaultNow(),
  capabilities: jsonb('capabilities'),
})

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  activeDeviceId: uuid('active_device_id').references(() => devices.id),
  agentConfig: jsonb('agent_config'),
  webhookSecret: text('webhook_secret'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

// issues, comments, jobs, job_events, skills, memories — similar shape
```

## Auth — dual principal

User and device are two distinct principal types. JWTs are asymmetric per principal:

```ts
// User JWT: 7-day TTL, refresh rotation
type UserToken = {
  sub: string   // userId
  typ: 'user'
  iat: number
  exp: number
}

// Device token: long-lived, one per device, argon2-hashed in DB
type DeviceToken = {
  sub: string   // deviceId
  typ: 'device'
  iat: number
  // no exp — revoked via DB lookup
}
```

Policy helpers:

```ts
export async function assertUserIsProjectMember(ctx, projectId: string) {
  const user = ctx.get('user')
  if (!user) throw new HTTPException(401, 'user required')
  const member = await db.query.projectMembers.findFirst({
    where: and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, user.id)),
  })
  if (!member) throw new HTTPException(403, 'not a project member')
}

export async function assertDeviceBelongsToProject(ctx, projectId: string) { /* ... */ }
export async function assertJobAccessibleByPrincipal(ctx, jobId: string) { /* ... */ }
```

Every route must call one of these before reading or writing. This resolves audit findings #1 and #2 by construction.

## WebSocket rooms

On upgrade handshake, the server identifies the principal:

- User JWT → subscribes to `user:<id>` and `project:<projectId>` for every project the user owns or is a member of.
- Device token → subscribes to `device:<id>` and `project:<projectId>` for every project the device is pooled in.

Events publish to rooms; fan-out is scoped. Clients cannot request arbitrary subscriptions. Audit finding #2 closed by construction.

## MCP server

The MCP server mounts at `/mcp` (Streamable HTTP per the MCP spec). Tools are defined as thin wrappers over internal handlers:

```ts
// src/mcp/tools/forge_issues.ts
export const issuesTools = {
  list: defineTool({
    schema: z.object({ projectId: z.string() }),
    async handler(args, ctx) {
      await assertUserIsProjectMember(ctx, args.projectId)
      return listIssues(args.projectId)
    },
  }),
  // ... get, create, update
}
```

The `crossProjectAccess` flag is absent — there's no code path for it.

## Job dispatcher

`src/queue/dispatcher.ts` polls pg-boss, resolves the project's `activeDeviceId`, pushes `job.assigned` over WebSocket to the device's room. Device POSTs JobEvent batches to `/api/jobs/:id/events`; server persists and broadcasts.

Stale detection runs every 5 minutes: jobs with no JobEvent in >5 min transition to `failed` with auto-retry up to 3x.

## Configuration

All config via `.env`, validated with Zod at boot. No defaults for secrets; the service exits if required secrets are missing.

Required:
- `DATABASE_URL`
- `JWT_SECRET`
- `DEVICE_TOKEN_PEPPER`
- `SMTP_*` (for email verification)
- `QDRANT_URL`

Optional:
- `CORS_ORIGINS`, `CORS_ORIGIN_PATTERNS`
- `LITELLM_*` (for chat agent, optional)

## Deployment

docker-compose updates:

```yaml
services:
  postgres: # unchanged
  qdrant:   # unchanged
  core:
    build: ./forge/core
    ports: ["8080:8080"]
    depends_on:
      postgres: { condition: service_healthy }
      qdrant:   { condition: service_started }
    environment:
      DATABASE_URL: postgres://...
      JWT_SECRET: ${JWT_SECRET}
      # ...
  web:      # points at core
```

The `strapi` service is removed.

# Drawbacks

1. **Rewrite is 8 weeks of focused work.** We lose 8 weeks of product iteration. Acceptable because the current stack is both the largest adoption barrier and the largest source of audit debt.

2. **Internal alpha deployment is recreated fresh.** SidCorp engineers currently using the Strapi-backed deployment will lose their data (issues, jobs, chat history). Acceptable because: (a) no external users yet, (b) the alpha content is test data, and (c) recreating test data is small.

3. **Admin UI work moves to the web app team.** We inherit the work of building user management, project management, and device management UIs in Next.js. These don't exist today — Strapi admin provided them for free. ~1 week of UI work hidden inside Phase 2.6.

4. **No framework-provided upgrade path for schema.** Drizzle migrations are explicit; every schema change requires a generate + review + apply cycle. Acceptable — this is good. Strapi's "just restart" was a feature that hid cost.

5. **Contributors need to learn our conventions, not Strapi's.** Net wash — our conventions are standard Hono + Drizzle patterns, which are more transferable than Strapi-specific knowledge.

6. **We commit to maintaining a Node service long-term.** The boundary between "framework we use" and "code we own" shifts. The code is smaller and more ours; the framework is smaller but the total surface we're responsible for is larger.

# Rationale and alternatives

## Alternative 1 — Stay on Strapi for v0.1, migrate at v1.0

Rejected. Every user we add makes migration harder. "Why Strapi?" is an adoption objection that compounds with users. Delaying doesn't make the work smaller; it makes it riskier.

## Alternative 2 — Extract only the control-plane core from Strapi, keep Strapi for CRUD admin

Initially proposed, then rejected. Two services add operational complexity for self-hosters. Strapi stays in the contributor's way. The upgrade treadmill still applies to the retained Strapi surface. The split boundary is artificial — projects, issues, devices, and jobs are one cohesive domain.

## Alternative 3 — Full rewrite with NestJS

Rejected. NestJS is "Strapi-without-the-CMS" from a contributor ergonomics standpoint — same heaviness, same enterprise patterns, same OSS friction. The work of learning NestJS offsets the benefit of leaving Strapi.

## Alternative 4 — Fastify + Prisma

Rejected. Prisma's query-engine binary inflates container size and introduces a non-Apache-licensed binary in the dependency tree (mitigated in 5.x but still a friction point for self-hosters in regulated contexts). Fastify is excellent but Hono's design is newer and TypeScript-first by default.

## Alternative 5 — Elysia + Bun

Rejected for v0.x. Bun is first-class for Elysia but the Node ecosystem is more contributor-familiar for early OSS adoption. Hono supports Bun if we migrate later — swap is one-line.

## Alternative 6 — Go rewrite

Rejected. TypeScript is the project's primary language. Forcing contributors into Go doubles the onboarding barrier without corresponding benefit at our scale.

## Alternative 7 — Migrate data instead of rebuilding the deployment

Rejected. We have no external users. The only migration benefit is preserving internal test data, which is small and easily recreated. The migration adds ~2 weeks of schema adapters, verification scripts, and cut-over drills for no product value.

## Why the proposed design wins

- **Purpose-shaped.** Every line of code is for Jarvis Agents specifically, not a CMS.
- **Lightweight.** Target memory 100–120 MB vs Strapi's 400 MB.
- **TypeScript-first.** No JSON schema files, no JSON lifecycle hook declarations.
- **OSS-friendly licensing.** All dependencies MIT / Apache / BSD.
- **Audit findings closed by construction.** Policy layer prevents the class of bug, not just the specific instances.
- **Contributor onboarding trivial.** "Read any modern TS app" is the learning curve.

# Prior art

1. **LangChain LangGraph** — state-machine-driven agent execution. We adopt the explicit-transition-function pattern, not LangChain's runtime abstractions.
2. **Temporal worker model** — event-sourced job progress, deterministic replay on reconnect. We borrow the JobEvent append-only log pattern. We don't adopt Temporal itself because pg-boss covers our needs.
3. **Supabase (PostgREST + Realtime + Auth)** — self-hosted OSS platform built on Postgres. We adopt the Postgres-first philosophy; we diverge because PostgREST's REST auto-generation doesn't fit our RBAC model as cleanly as hand-written Hono routes.
4. **Hono + Drizzle + pg-boss stack** used by numerous Cloudflare-first OSS tools (val.town infra, PlanetScale boss, etc.). Standard stack for TypeScript backends in 2026.
5. **Rust RFC process + ADR pattern** — this RFC follows the same format as [RFC 0001](0001-device-runner-architecture.md).

# Unresolved questions

- **Q1. Monorepo tooling.** pnpm workspaces plain, or + turbo? Recommend pnpm + turbo for caching; open for discussion.
- **Q2. Testing database strategy.** Testcontainers (slow, accurate) vs dedicated test Postgres schema (fast, concurrent-safe)? Recommend Testcontainers for CI, schema mode for local.
- **Q3. Admin UI scope for v0.1.** Minimal surface: user list, project list, device list, audit log. What's cut, what's kept? Separate ADR.
- **Q4. OpenAPI spec generation.** Hand-write, or extract from Zod schemas (e.g., with `@hono/zod-openapi`)? Recommend extraction.
- **Q5. Observability wiring.** OpenTelemetry in v0.1 or v0.5? Recommend v0.1 with minimal collector setup; full traces in v0.5.
- **Q6. Session cache for policy checks.** In-memory per-process, Redis, or re-query DB? Recommend in-memory with 30-second TTL for v0.1.

All non-blocking; resolved during implementation.

# Future possibilities

- **Horizontal scaling.** Once WebSocket concurrency exceeds ~1000, move room broadcasts to Redis pub/sub. Already flagged in ADR 0006.
- **Multi-region.** Postgres replication + region-aware device routing. Not in v0.x.
- **Plugin system.** Once the surface is stable, expose a plugin hook system for user-contributed Hono middleware. Separate RFC.
- **Temporal migration.** If complex multi-step workflows emerge (multi-day approvals, human-in-the-loop chains), revisit Temporal.
- **Rust rewrite.** If contributor pool shifts and performance demands exceed Node + pg-boss, consider a Rust core with WASM boundaries.

# Stakeholders

- **Owning:** @junixlabs (maintainer)
- **Adjacent to ping when RFC opens for discussion:**
  - All SidCorp engineers currently using the internal Strapi deployment (disruption communication)
  - Any future co-maintainer candidate
- **External users affected:** none (pre-public launch)

# FCP readiness check

- [x] Summary is ≤1 paragraph and jargon-free
- [x] Motivation cites concrete pains (workload shape, memory, upgrade treadmill, OSS friction)
- [x] Guide-level includes runnable examples (schema, route, policy)
- [x] Reference-level covers interface, storage, migration (N/A — rebuild), rollback (N/A — no data)
- [x] ≥2 drawbacks (6 listed)
- [x] ≥2 alternatives (7 listed)
- [x] ≥2 prior-art references (5 listed)
- [x] Unresolved questions are non-blocking
- [ ] Owning-team sign-off — pending, RFC opens as PR first
- [ ] ≥5 business days of open discussion — pending

**Conclusion:** Content-wise FCP-ready. Procedural gates to clear.

# Motion-for-FCP comment (draft)

> @junixlabs — motion for **Final Comment Period** with **disposition: merge**.
>
> Summary of discussion:
> - Rebuild over migrate — pre-public means no data preservation obligation
> - Stack: Hono + Drizzle + pg-boss + ws + MCP SDK + custom dual-principal auth
> - 8-week Phase 2 replaces prior 5–7-week migration estimate; single-track work
> - Admin UI moves to the web app; Strapi admin retired
> - Internal alpha recreation accepted cost
>
> FCP is 10 calendar days from team signoff. Please leave 👍 / 👎 to signal position.
