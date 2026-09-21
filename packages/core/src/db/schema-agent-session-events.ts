// ISS-1030 — the raw carrier a chat session's transcript is derived from.
//
// Split out of `schema.ts` only for size; it is a schema module like
// `schema-session-inbox.ts` and is registered in `drizzle.config.ts` and the
// drizzle client's schema map alongside it.

import { relations } from 'drizzle-orm';
import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { agentSessions } from './schema.js';

export const agentSessionEventKinds = ['stdout', 'seed', 'snapshot'] as const;
export type AgentSessionEventKind = (typeof agentSessionEventKinds)[number];

export const agentSessionEvents = pgTable(
  'agent_session_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    agentSessionId: uuid('agent_session_id')
      .notNull()
      .references(() => agentSessions.id, { onDelete: 'cascade' }),
    ts: timestamp('ts', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind', { enum: agentSessionEventKinds }).notNull(),
    data: jsonb('data').notNull().default({}),
    seq: integer('seq').notNull(),
  },
  (t) => ({
    sessionSeqIdx: uniqueIndex('agent_session_events_session_id_seq_idx').on(
      t.agentSessionId,
      t.seq,
    ),
    sessionTsIdx: index('agent_session_events_session_id_ts_idx').on(t.agentSessionId, t.ts),
  }),
);

export const agentSessionEventsRelations = relations(agentSessionEvents, ({ one }) => ({
  session: one(agentSessions, {
    fields: [agentSessionEvents.agentSessionId],
    references: [agentSessions.id],
  }),
}));
