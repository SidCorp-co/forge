# Migrations

Drizzle-managed schema migrations for `@forge/core`. Applied automatically
on container start by `node dist/db/migrate.js` (Dockerfile CMD).

## Runtime behaviour

`dist/db/migrate.js` calls `drizzle-orm/postgres-js/migrator`, which:

1. **Reads `meta/_journal.json`** — the canonical list of migrations to
   apply, in order (`idx` field).
2. For each entry, opens `<tag>.sql` from this directory and computes its
   hash.
3. Compares the hash against rows in the `drizzle.__drizzle_migrations`
   table in the target DB.
4. Applies any file whose hash isn't already present, then inserts a
   journal row in the DB.

**A `.sql` file in this folder does NOT get applied unless its tag is
registered in `meta/_journal.json`.** The runtime migrator never scans
the directory — it trusts the journal exclusively.

## How to add a migration

### Preferred — `drizzle-kit generate`

```bash
cd packages/core
# After editing src/db/schema.ts:
pnpm db:generate
```

`drizzle-kit` writes the SQL file, updates `meta/_journal.json`, and
emits a snapshot under `meta/`. No manual edits needed.

### Hand-written SQL (rare)

Use only when codegen can't express the change (data backfills,
expression indexes, partial indexes, stored functions). When you
hand-write a `NNNN_name.sql`, you **must also**:

1. Append an entry to `meta/_journal.json` with the next `idx`,
   matching `tag`, and a unique `when` timestamp:

   ```jsonc
   {
     "idx": 42,
     "version": "7",
     "when": 1778200000000,
     "tag": "0042_my_change",
     "breakpoints": true
   }
   ```

2. Make every statement idempotent (`IF NOT EXISTS` /
   `IF EXISTS` / guarded `UPDATE`s). The runtime migrator has no
   concept of rolling back a partially-applied migration; if your file
   re-runs against a partially-mutated DB it must converge cleanly.

3. Separate statements with `--> statement-breakpoint` on its own line.
   The migrator splits on this exact marker and runs each statement
   in its own command.

## Common failure modes

### Symptom: column from a new migration "does not exist" in prod

Almost always the migration file shipped without a `_journal.json`
entry. Check:

```sh
grep -F "<tag>" packages/core/drizzle/migrations/meta/_journal.json
```

If this returns nothing, the migrator never saw your file. Add the
entry, ship a follow-up. (See `0042_agent_sessions_zombie_fix.sql`
post-mortem in `0043_agent_sessions_zombie_fix_redo.sql`.)

### Symptom: migrator says "[migrate] done" but nothing changed

Either the journal entry is missing (above) or `drizzle.__drizzle_migrations`
already contains a row whose hash matches your file. If the columns are
genuinely missing on the target DB despite the row, someone (or an old
deploy) recorded the migration without the SQL actually running. Fix:

```sql
DELETE FROM drizzle.__drizzle_migrations WHERE id = <bad_id>;
```

Then restart the container so the migrator reapplies cleanly.

## Source of truth

- Runtime migrator: `packages/core/src/db/migrate.ts`
- Schema TS: `packages/core/src/db/schema.ts`
- Drizzle config: `packages/core/drizzle.config.ts`
