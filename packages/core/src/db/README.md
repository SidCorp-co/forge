# `packages/core/src/db` — Drizzle schema conventions

Single source of truth for Postgres schema. A new table lands either in
[`schema.ts`](./schema.ts) or in a `schema-<subject>.ts` module of its own —
`schema-issue-leases.ts`, `schema-deploy-locks.ts` and the rest. A module of its
own owes two registrations, and a table carrying neither is invisible to the
generator or to the query layer: the file path in `schema` in
[`../../drizzle.config.ts`](../../drizzle.config.ts), and a spread into the
`schema` object in [`db/client.ts`](./client.ts). Migrations are generated into
[`../../drizzle/migrations/`](../../drizzle/migrations) via `pnpm db:generate`.

The conventions below are set by Phase 2.1-C (ISS-146) and bind every later
table (projects, issues, jobs, memories, …). Depart from them only with a
clear reason and a note in the owning issue.

## Conventions

1. **Primary keys.** `uuid('id').primaryKey().defaultRandom()`. Emits
   `DEFAULT gen_random_uuid()`, which is built into Postgres 13+ — no
   `pgcrypto` extension required. Do not generate UUIDs client-side for
   inserts.

2. **Column naming.** `snake_case` in SQL, `camelCase` on the Drizzle field.
   Always pass the explicit SQL name as the first argument
   (`uuid('owner_id')`, not `uuid()`).

3. **Timestamps.** Always
   `timestamp('col', { withTimezone: true })` — never the `timestamptz(...)`
   shorthand (keeps a single style across the codebase).
   - `createdAt` → `.notNull().defaultNow()`
   - Optional timestamps (e.g. `emailVerifiedAt`) → nullable, no default
   - A `Date` entering a raw `sql` template goes through `sqlTimestamp()`
     ([`sql-timestamp.ts`](./sql-timestamp.ts)); a bare `${date}` is refused
     by the driver with `RAW_SQL_DATE_PARAM`. Query-builder comparisons on a
     timestamp column (`gte(col, date)`) are encoded by the column and need
     nothing.

4. **Foreign keys.** Always
   `.references(() => other.id, { onDelete: <behavior> })`.
   - `'cascade'` when the child row is meaningless without the parent
     (verification tokens, session tokens, device tokens).
   - `'restrict'` when the parent should not disappear while children exist
     (projects → users).

5. **Enums.** Prefer `text('col', { enum: [...] })` over Postgres
   `CREATE TYPE` enums. Easier to evolve, no migration dance to add a value.

6. **Indexes.** Add a named index on every FK you filter or join by. Name
   pattern: `<table>_<col>_idx`.

## Vector storage (`pgvector`)

The `pgvector` extension is enabled in the migration that introduces the
`memories` table. Do not enable it from earlier migrations.

## Generating a migration

```bash
cd packages/core
pnpm db:generate   # reads schema.ts, writes drizzle/migrations/NNNN_*.sql
pnpm db:migrate    # applies to $DATABASE_URL
```
