# Migrations

Drizzle-managed schema migrations for `@forge/core`. Applied automatically
on container start by `node dist/migrate.js` (the Dockerfile CMD), before the
server starts. That entry (`packages/core/src/migrate.ts`) installs the
error-tracking port and then runs `packages/core/src/db/migrate.ts`.

## Runtime behaviour

`packages/core/src/db/migrate.ts` calls `drizzle-orm/postgres-js/migrator`, which:

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

Every migration is hand-written. The last drizzle snapshot is `meta/0381_snapshot.json`; none was
kept after it, so `pnpm db:generate` diffs the schema against 0381 and re-emits every change made
since. Do not use it to write a migration.

### Writing one

<!-- doc-citation: unchecked `NNNN_name.sql` — the naming TEMPLATE a new migration follows, not a file that exists. -->
When you hand-write a `NNNN_name.sql`, you **must also**:

1. Append an entry to `meta/_journal.json` with the next `idx`,
   matching `tag`, and the `when` that `node scripts/check-migration-order.mjs`
   prints as `Next free:`:

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

4. Open no transaction of your own. The migrator wraps the WHOLE run in one,
   so a `BEGIN;`/`COMMIT;` in a file ends drizzle's and every migration after
   it in the chain auto-commits statement by statement — free to half-apply
   and still be recorded as applied. `0067_unify_runners.sql` did exactly that
   for 171 migrations until ISS-1001 removed it.

**Declare every CHECK constraint in the schema module too**, not only in the `.sql`, and rebuild
it in a migration whenever the schema's version changes — a vocabulary the CHECK is derived from
(`OUTBOX_EVENT_TYPES` for `pipeline_outbox_type_chk`) included. `src/db/schema-checks.test.ts`
replays these files in journal order and fails naming every CHECK whose literals differ from the
schema's, or that no migration defines. 0405 left the outbox admitting 28 of 43 event types and
every write of the other 15 failed; 0419 repaired it.

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

- Runtime migrator: `packages/core/src/migrate.ts` over `packages/core/src/db/migrate.ts`
- Schema TS: `packages/core/src/db/schema*.ts`
- Drizzle config: `packages/core/drizzle.config.ts`
