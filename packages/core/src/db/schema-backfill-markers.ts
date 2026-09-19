import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const backfillMarkers = pgTable('backfill_markers', {
  key: text('key').primaryKey(),
  completedAt: timestamp('completed_at', { withTimezone: true }).notNull().defaultNow(),
});
