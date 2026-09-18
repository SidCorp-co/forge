// ISS-1030 — the durable record that a data backfill actually finished.
//
// cm:guard the drizzle ledger answers a DIFFERENT question, and reading it for
// this one is how a backfill goes missing in silence. `migrate()` records a
// migration the moment its DDL commits; a backfill that runs after it and
// throws — or whose container is killed mid-way — leaves that row recorded, so
// the next boot sees the migration applied, skips the backfill for ever, and
// serves canonical-only readers a table still holding legacy rows. That is
// ISS-807's failure mode with a different cause: new code on old data, and
// nothing anywhere saying so.
//
// A row lands here only after the backfill returns, so a boot that finds none
// runs it again. Every backfill this table gates must therefore be idempotent.
import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const backfillMarkers = pgTable('backfill_markers', {
  /** The backfill's own name — stable across releases, never a migration index. */
  key: text('key').primaryKey(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
});
