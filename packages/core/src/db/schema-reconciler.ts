/** When the rescue pass last read each stuck issue, so it reads the longest-unread first (ISS-1228). */

import { pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { issues } from './schema.js';

export const reconcilerExamined = pgTable('reconciler_examined', {
  issueId: uuid('issue_id')
    .primaryKey()
    .references(() => issues.id, { onDelete: 'cascade' }),
  examinedAt: timestamp('examined_at', { withTimezone: true }).notNull(),
});
