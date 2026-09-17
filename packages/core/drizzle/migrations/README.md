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
emits a snapshot under `meta/`.

**Two things it gets wrong, both measured on 0220 (ISS-960):**

1. The `when` it writes is the wall clock, which on this repo is far BELOW the
   journal's existing `max(when)` (those are hand-picked, spaced a day apart).
   Drizzle reads the single highest `created_at` in the target DB and skips
   lower entries silently, forever — the container then serves new code against
   an old schema. Raise the generated `when` by hand to a whole number of days
   above the journal's `max(when)` — `+ 86400000` where yours is the only
   migration open, and enough to clear the highest `when` any unmerged sibling
   holds where it is not. Read the siblings immediately before the push that
   lands it: every branch deriving `+ 86400000` from one `main` lands on the
   same number, and the gate reads only your own journal, so it is green on a
   value a sibling is about to take. `db/migrations-journal.test.ts` holds the
   shape — whole days, strictly above, at most 30 ahead — not the collision.
2. It does not re-emit an index that Postgres dropped with the column. If your
   change drops and re-adds a column (the only way to alter a generated
   column's expression), every index on that column goes with it and drizzle's
   model still believes they exist. Add the `CREATE INDEX` by hand.

Both mean the generated file is a starting point on this repo, not a finished
one. Keep the snapshot drizzle emitted; rewrite the SQL and the journal entry.

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

4. Open no transaction of your own. The migrator wraps the WHOLE run in one,
   so a `BEGIN;`/`COMMIT;` in a file ends drizzle's and every migration after
   it in the chain auto-commits statement by statement — free to half-apply
   and still be recorded as applied. `0067_unify_runners.sql` did exactly that
   for 171 migrations until ISS-1001 removed it;
   `db/migrations-journal.test.ts` is now the gate.

**A hand-written migration that changes the SCHEMA still owes a snapshot**, and
`db/migrations-journal.test.ts` fails it by name if it does not have one: a head
snapshot that lags is a `pnpm db:generate` that re-emits DDL the database
already has. A data-only migration owes nothing — the classifier in that test
says which is which.

The way to produce one for a hand-written migration is `pnpm db:generate` on the
merged tree, keeping `meta/<idx>_snapshot.json` and discarding the `.sql` it
emits. **When the change both creates and drops a table, that command cannot
run unattended**: `drizzle-kit` asks "created or renamed?" and its prompt has no
non-TTY answer at all — it aborts with *"Interactive prompts require a TTY"*
under a pipe, a heredoc and `script -qec` alike. Generate in two passes instead,
so neither pass has both a creation and a deletion in it:

1. Add a temporary module re-declaring the table you are DROPPING, and list it
   in `drizzle.config.ts`. Generate: creations only, no prompt.
2. Delete that module and its config line. Generate again: the deletion only,
   no prompt.

Keep the second pass's snapshot, rename it onto your migration's own index, and
set its `prevId` to the id of the snapshot it was diffed from — the two staging
snapshots are discarded, so the chain must link past them. Then delete both
emitted `.sql` files and restore `meta/_journal.json`, which `generate` appends
to. `pnpm db:generate` answering *"No schema changes, nothing to migrate"* is
the check that it worked. Measured 2026-09-14 on `0241_conversations.sql`,
which creates three tables and drops one.

**Declare every CHECK constraint in the schema module too**, not only in the
`.sql`. A drizzle snapshot records `checkConstraints` per table, so a constraint
that exists only in the migration is one the snapshot denies.

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
