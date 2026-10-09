# Migration

**Change kind:** Migration
**Introduced by:** ISS-466

A hand-written SQL migration of core's Postgres schema, applied on container start before the
server serves. A change takes this entry when it adds or alters a table, a column, a CHECK, an
index, a trigger or a status machine's states, or moves rows a new shape strands. It builds on
[Core module](core-module.md) (Tables, Status machines): the table's TypeScript declaration and its
owner come first, and the migration makes the database agree with them.

## Reference

- `packages/core/drizzle/migrations/README.md` — how a migration is written: hand-written, idempotent, statement breakpoints, no transaction of its own, every CHECK declared in the schema module too
- `packages/core/drizzle/migrations/0472_a_gated_move_records_its_checklist_and_its_refusals.sql` — a recent one: what it records and why in its header, a ROLLBACK paragraph, `lock_timeout`, `IF NOT EXISTS` on every statement
- `packages/core/drizzle/migrations/0407_an_issue_waits_on_a_contract_version_not_on_another_issue.sql` — a new table with its guard trigger raising a named error
- `packages/core/drizzle/migrations/0450_an_approval_before_its_landing_rule_is_recorded.sql` — a data migration that moves rows the new rule strands, and aborts naming a row it cannot represent
- `packages/core/drizzle/migrations/meta/_journal.json` — the list the migrator applies; an entry missing here is never applied
- `scripts/check-migration-order.mjs` — prints `Next free:`, the only place a migration's index and `when` are taken from
- `packages/core/src/db/schema-contract-waits.ts` — the schema module the table is declared in, its CHECKs built from contracts limits

## Test shape

- `packages/core/src/db/schema-checks.test.ts` — replays every migration in journal order and fails naming each CHECK whose literals differ from the schema module's, or that no migration defines
- `packages/core/tests/integration/design-landing-backfill-migration-e2e.test.ts` — a data migration run by drizzle's own migrator from the ground before it (`groundBefore`), asserting the rows it moved, the rows it left, and the abort naming the row it cannot represent

Every migration is held by **schema-checks.test.ts** under `pnpm --filter @forge/core test`, and by
the integration suite's global setup, which applies this tree's new migrations one at a time over a
copy of the merge target seeded with rows (`pnpm --filter @forge/core test:integration`, collected
by `packages/core/vitest.integration.config.ts`). A migration that moves or rewrites rows also gets
its own `*-migration-e2e.test.ts` under `packages/core/tests/integration/` that seeds the rows before
it with `packages/core/tests/helpers/migration-ground.ts:groundBefore`, runs it, and asserts each
row it must move, each it must leave, and the abort for a row its new shape cannot hold.

## Review checklist

1. The index and `when` are the `Next free:` line of **check-migration-order.mjs**, and the journal entry's `tag` matches the file name.
2. Every statement is idempotent and separated by `--> statement-breakpoint`; the file opens no transaction.
3. The header says what changes and why, and a ROLLBACK paragraph says what reverting loses.
4. Every CHECK, index and table is also declared in its `packages/core/src/db/schema-*.ts` module, built from the contracts array or limit it enforces.
5. A new table is declared in a `packages/core/src/db/schema-*.ts` module, which `packages/core/drizzle.config.ts` reads by its name, and listed under its owner's `owns` in `modules.json`.
6. Ids, scope columns, timestamps and actor columns follow the Tables rules of the core-module entry.
7. A row the new shape cannot represent makes the migration abort naming it; nothing is deleted or widened to make it fit.
8. A state removed from a machine moves its rows with `forge_migrate_state_rows` before the CHECK drops it.
9. The migration applies over a database holding rows, not only over the empty template.
