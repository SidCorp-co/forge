/**
 * When the rescue pass last read each stuck issue (ISS-1228). The pass reads the longest-unread first
 * and stamps every row it took, so a hundred rows never stand in front of the rest for ever. A table
 * of its own rather than a column on `issues`: an issue row's `updated_at` is what the pass's own
 * filter reads, and its `session_context` is written under a compare-and-set.
 */

import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema.js';

export const reconcilerExamined = pgTable('reconciler_examined', {
  issueId: uuid('issue_id')
    .primaryKey()
    .references(() => issues.id, { onDelete: 'cascade' }),
  examinedAt: timestamp('examined_at', { withTimezone: true }).notNull(),
});
