import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './schema-auth.js';
import { feedbackDecisions } from './schema-feedback.js';

// which answer each reporter's own sessions were told, one row per answer and reporter (REQ-47 BC-11):
// an answer is a `triaged` decision on the `answer` route, so a later answer on the item is a new row
// to tell, and a told one is never told again. Written by the claim that hands it to the session
export const feedbackAnswerDeliveries = pgTable(
  'feedback_answer_deliveries',
  {
    decisionId: uuid('decision_id')
      .notNull()
      .references(() => feedbackDecisions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
    // `session`: handed to a session of the reporter's; `predates`: given before 0549, never handed out
    via: text('via', { enum: ['session', 'predates'] }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.decisionId, t.userId] }),
    viaChk: check('feedback_answer_deliveries_via_chk', sql`${t.via} IN ('session', 'predates')`),
    userIdx: index('feedback_answer_deliveries_user_idx').on(t.userId),
  }),
);
