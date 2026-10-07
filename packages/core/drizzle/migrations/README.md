# Migrations

Drizzle-managed schema migrations for `@forge/core`. Applied automatically
on container start by `node dist/migrate.js` (the Dockerfile CMD), before the
server starts. That entry (`packages/core/src/migrate.ts`) installs the
error-tracking port and then runs `packages/core/src/db/migrate.ts`.

## Runtime behaviour

`packages/core/src/db/migrate.ts` calls `drizzle-orm/postgres-js/migrator`, which:

1. **Reads `meta/_journal.json`** — the canonical list of migrations to
   apply, in order (`idx` field), and opens each `<tag>.sql`.
2. Reads the single highest `created_at` in `drizzle.__drizzle_migrations`.
3. Applies, in ONE transaction, every entry whose `when` exceeds it, inserting
   a row per entry. An entry at or below it is skipped silently — the hash is
   stored, never compared.

A boot that cannot migrate exits 1 and reports the failure through the
error-tracking port (Sentry when `SENTRY_DSN` is set), flushed before exit:
the stage, the failing migration's tag when the statement names one, the
pending tags, and the journal and recorded counts. A statement waiting on a
lock another session holds fails at `MIGRATE_LOCK_TIMEOUT_MS` instead of
waiting with nothing logged.

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
it in a migration whenever the schema's version changes, a vocabulary the CHECK is derived from
included. `src/db/schema-checks.test.ts` replays these files in journal order and fails naming
every CHECK whose literals differ from the schema's, or that no migration defines. The outbox's
event types are rows of `outbox_event_types` instead (0451): a new type is one
`INSERT INTO "outbox_event_types"` migration, and the same test replays those writes against
`OUTBOX_EVENT_TYPES`. 0405 left the outbox admitting 28 of 43 event types and every write of the
other 15 failed; 0419 repaired it, and thirteen whole-list rewrites later 0451 retired the list.

**A new migration must apply to a database that holds rows.** The integration suite's global
setup (`tests/helpers/global-setup.ts`) reads the merge target the way every delta-scoped gate does
(`scripts/lib/base-branch.mjs`), migrates a copy through the newest migration that target carries,
seeds it through `tests/helpers/factories.ts`, and applies this tree's new migrations over those rows
one at a time. The first one Postgres refuses fails the suite, naming its tag and SQLSTATE: 0442
reset a NOT NULL column to null before dropping the constraint, passed on the empty template, and
stopped the dev.103 deploy. A row whose shape no factory writes is not seeded, so a migration about
such a table still owes its own `groundBefore` test (`tests/helpers/migration-ground.ts`).

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

Either the journal entry is missing (above) or your entry's `when` is not
above the highest `created_at` already in `drizzle.__drizzle_migrations`. If the columns are
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
