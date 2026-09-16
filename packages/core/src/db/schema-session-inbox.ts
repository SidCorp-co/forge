// The durable inbox a core-side `session.send` writes to, one row per INTENT.
//
// Core does not sit on a socket waiting for a process to answer: it stamps an
// episode here, publishes, and decides later whether silence is an answer. The
// table is what makes that decision reconstructible after a restart, a device
// loss, or a redelivery of the same command.
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-journal.ts` and is registered in `drizzle.config.ts` and the drizzle
// client's schema map alongside it.

import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentSessions } from './schema.js';

export const sessionInboxKinds = ['work', 'answer', 'inject', 'checkpoint', 'cancel'] as const;
export type SessionInboxKind = (typeof sessionInboxKinds)[number];

export const sessionSendOutcomes = ['delivered', 'gone', 'unknown'] as const;
export type SessionSendOutcome = (typeof sessionSendOutcomes)[number];

export const sessionInbox = pgTable(
  'session_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSessionId: uuid('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: sessionInboxKinds }).notNull(),
    intentId: text('intent_id').notNull(),
    body: text('body'),
    sendRequestedAt: timestamp('send_requested_at', { withTimezone: true }).notNull().defaultNow(),
    sendConfirmedAt: timestamp('send_confirmed_at', { withTimezone: true }),
    sendOutcome: text('send_outcome', { enum: sessionSendOutcomes }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    appliedTurn: integer('applied_turn'),
  },
  (t) => ({
    intentUnique: uniqueIndex('session_inbox_intent_unique').on(
      t.agentSessionId,
      t.kind,
      t.intentId,
    ),
    seqUnique: uniqueIndex('session_inbox_seq_unique').on(t.agentSessionId, t.seq),
    unresolvedIdx: index('session_inbox_unresolved_idx')
      .on(t.sendRequestedAt)
      .where(sql`send_confirmed_at IS NULL OR (send_outcome = 'unknown' AND applied_at IS NULL)`),
  }),
);
