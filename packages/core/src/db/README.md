# `packages/core/src/db` — Drizzle schema conventions

Single source of truth for Postgres schema. A table lives in a `schema-<subject>.ts`
module: one per module that `owns` it in `src/modules.json` (`schema-issues.ts`,
`schema-auth.ts`, …) or one of its own (`schema-issue-leases.ts`,
`schema-deploy-locks.ts`, …). The generator reads every `schema*.ts` file through the
glob in [`../../drizzle.config.ts`](../../drizzle.config.ts). The query layer reads
[`./schema.ts`](./schema.ts), which re-exports the owner files, plus the files spread
into the `schema` object in [`db/client.ts`](./client.ts); a new module of its own
is added to one of the two. An enum array one schema file's columns read from
another goes in the leaf [`schema-vocabulary.ts`](./schema-vocabulary.ts): the
schema files import each other in a cycle, and a column built at load time from a
binding that has not loaded yet throws. Migrations are hand-written into
[`../../drizzle/migrations/`](../../drizzle/migrations); how is in its README.

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

## Writing a migration

Every migration is hand-written, with its journal entry, as
[`../../drizzle/migrations/README.md`](../../drizzle/migrations/README.md) says: `pnpm db:generate`
diffs against the last snapshot drizzle kept and re-emits every change since, so it writes none.

```bash
cd packages/core
pnpm db:migrate    # applies to $DATABASE_URL
```
